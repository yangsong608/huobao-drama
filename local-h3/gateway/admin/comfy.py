#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ComfyUI 工作流导入：界面图 → API 图、产物/参数推断、依赖校验与 HTTP 客户端。

仅使用标准库，网关与管理服务都能直接复用。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

VIRTUAL_TYPES = {"Reroute", "PrimitiveNode", "Note", "MarkdownNote"}
PRIMITIVE_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
CONTROL_VALUES = {"fixed", "increment", "decrement", "randomize"}

KIND_EXTS = {
    "audio": ["wav", "mp3", "flac", "ogg", "m4a", "aac"],
    "video": ["mp4", "webm", "gif"],
    "image": ["png", "jpg", "jpeg", "webp"],
}

OUTPUT_SAVERS = (
    ("SaveAudio", "audio", KIND_EXTS["audio"]),
    ("SaveVideo", "images", KIND_EXTS["video"]),
    ("VHS_VideoCombine", "gifs", KIND_EXTS["video"]),
    ("SaveImage", "images", KIND_EXTS["image"]),
)


class WorkflowImportError(ValueError):
    """工作流无法转换或依赖不完整。"""


class ComfyError(RuntimeError):
    """ComfyUI 请求失败。"""


# -- 界面图 → API 图 -----------------------------------------------------


def convert_ui_workflow(ui, object_info):
    """把 ComfyUI 界面保存的节点图转换成 ``POST /prompt`` 需要的 API 图。"""
    if not isinstance(ui, dict) or not isinstance(ui.get("nodes"), list):
        raise WorkflowImportError("不是 ComfyUI 界面工作流：缺少 nodes 列表")

    nodes_by_id = {}
    for node in ui["nodes"]:
        if not isinstance(node, dict) or "id" not in node:
            raise WorkflowImportError("工作流节点缺少 id")
        try:
            nodes_by_id[int(node["id"])] = node
        except (TypeError, ValueError):
            raise WorkflowImportError("工作流节点 id 不是整数")

    links = {}
    for link in ui.get("links") or []:
        if isinstance(link, dict):
            try:
                link_id = int(link["id"])
                links[link_id] = [
                    link_id, int(link["origin_id"]), int(link["origin_slot"]),
                    int(link["target_id"]), int(link["target_slot"]), link.get("type"),
                ]
            except (KeyError, TypeError, ValueError):
                raise WorkflowImportError("工作流连线格式不正确")
        elif isinstance(link, list) and len(link) >= 5:
            try:
                links[int(link[0])] = link
            except (TypeError, ValueError):
                raise WorkflowImportError("工作流连线格式不正确")
        else:
            raise WorkflowImportError("工作流连线格式不正确")

    graph = {}
    for node_id in sorted(nodes_by_id):
        node = nodes_by_id[node_id]
        class_type = node.get("type")
        if class_type in VIRTUAL_TYPES:
            continue
        if not class_type or class_type not in object_info:
            raise WorkflowImportError(f"缺少自定义节点：{class_type}")
        mode = node.get("mode", 0)
        if mode in (2, 4):
            raise WorkflowImportError(
                f"工作流包含静音/绕过节点：{class_type}（#{node_id}），请取消后再导入"
            )
        graph[str(node_id)] = {
            "class_type": class_type,
            "inputs": _node_inputs(node, object_info.get(class_type) or {}, links, nodes_by_id),
        }
    if not graph:
        raise WorkflowImportError("工作流中没有可执行的节点")
    return graph


def _ordered_inputs(info):
    data = info.get("input") or {}
    order = info.get("input_order") or {}
    required = data.get("required") or {}
    optional = data.get("optional") or {}
    result = []
    for names, specs in (
        (order.get("required"), required),
        (order.get("optional"), optional),
    ):
        for name in (names if isinstance(names, list) else list(specs)):
            if name in specs:
                result.append((name, specs[name]))
    return result


def _spec_type(spec):
    if isinstance(spec, list) and spec:
        head = spec[0]
        if isinstance(head, list):
            return "COMBO"
        return str(head)
    if isinstance(spec, str):
        return spec
    return "*"


def _has_control(spec):
    return (
        isinstance(spec, list)
        and len(spec) > 1
        and isinstance(spec[1], dict)
        and bool(spec[1].get("control_after_generate"))
    )


def _node_inputs(node, info, links, nodes_by_id):
    inputs = {}
    for entry in node.get("inputs") or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        link_id = entry.get("link")
        if not name or link_id is None:
            continue
        resolved = _resolve_link(int(link_id), links, nodes_by_id)
        if resolved is None:
            continue
        kind, value = resolved
        inputs[name] = value if kind == "value" else [str(value[0]), int(value[1])]

    widgets = node.get("widgets_values")
    if isinstance(widgets, dict):
        for name, _spec in _ordered_inputs(info):
            if name in widgets and name not in inputs:
                inputs[name] = widgets[name]
        return inputs

    values = widgets if isinstance(widgets, list) else []
    index = 0
    for name, spec in _ordered_inputs(info):
        kind = _spec_type(spec)
        if kind not in PRIMITIVE_TYPES:
            continue
        if index >= len(values):
            break
        if name not in inputs:
            inputs[name] = values[index]
        index += 1
        # seed 等整数控件后面会跟一个 control_after_generate 取值
        if (
            kind == "INT"
            and index < len(values)
            and isinstance(values[index], str)
            and values[index] in CONTROL_VALUES
        ):
            index += 1
        elif _has_control(spec) and index < len(values):
            index += 1
    return inputs


def _resolve_link(link_id, links, nodes_by_id, seen=None):
    seen = seen if seen is not None else set()
    if link_id in seen:
        return None
    seen.add(link_id)
    link = links.get(link_id)
    if not link:
        return None
    try:
        origin_id = int(link[1])
        origin_slot = int(link[2])
    except (IndexError, TypeError, ValueError):
        return None
    origin = nodes_by_id.get(origin_id)
    if origin is None:
        return None
    class_type = origin.get("type")
    if class_type == "Reroute":
        entries = origin.get("inputs") or []
        sub_link = entries[0].get("link") if entries and isinstance(entries[0], dict) else None
        if sub_link is None:
            return None
        return _resolve_link(int(sub_link), links, nodes_by_id, seen)
    if class_type == "PrimitiveNode":
        values = origin.get("widgets_values")
        if isinstance(values, dict):
            value = next(iter(values.values()), None)
        else:
            value = values[0] if values else None
        return ("value", value)
    return ("link", (origin_id, origin_slot))


# -- 产物与输入推断 ------------------------------------------------------


def suggest_output(graph):
    for class_type, key, exts in OUTPUT_SAVERS:
        for node_id in sorted(graph, key=lambda item: int(item)):
            if graph[node_id].get("class_type") == class_type:
                return {"node": str(node_id), "key": key, "exts": list(exts)}
    return {}


def suggest_kind(graph):
    classes = {node.get("class_type") for node in graph.values()}
    if "SaveAudio" in classes:
        return "audio"
    if classes & {"SaveVideo", "VHS_VideoCombine", "CreateVideo"}:
        return "video"
    if classes & {"SaveImage", "PreviewImage"}:
        return "image"
    if classes & {"VAEDecodeAudio", "ConditioningStableAudio", "EmptyLatentAudio"}:
        return "audio"
    return "image"


def _linked_node(graph, value):
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
        return value[0]
    return None


def suggest_input_map(graph):
    mapping = {}
    prompt = None
    negative = None
    for node_id in sorted(graph, key=lambda item: int(item)):
        inputs = graph[node_id].get("inputs") or {}
        positive_node = _linked_node(graph, inputs.get("positive"))
        negative_node = _linked_node(graph, inputs.get("negative"))
        if prompt is None and positive_node and _is_clip_text(graph, positive_node):
            prompt = {"node": positive_node, "input": "text", "type": "text"}
        if negative is None and negative_node and _is_clip_text(graph, negative_node):
            negative = {"node": negative_node, "input": "text", "type": "text"}
        if prompt and negative:
            break
    if prompt is None or negative is None:
        encoders = [
            node_id for node_id in sorted(graph, key=lambda item: int(item))
            if graph[node_id].get("class_type") == "CLIPTextEncode"
        ]
        if prompt is None and encoders:
            prompt = {"node": encoders[0], "input": "text", "type": "text"}
        if negative is None and len(encoders) > 1:
            negative = {"node": encoders[1], "input": "text", "type": "text"}
    if prompt:
        mapping["prompt"] = prompt
    if negative:
        mapping["negative_prompt"] = dict(negative, optional=True)

    for node_id in sorted(graph, key=lambda item: int(item)):
        inputs = graph[node_id].get("inputs") or {}
        for key in ("seed", "noise_seed"):
            if key in inputs:
                mapping["seed"] = {"node": node_id, "input": key, "type": "integer"}
                break
        if "seed" in mapping:
            break

    seconds = []
    for node_id in sorted(graph, key=lambda item: int(item)):
        inputs = graph[node_id].get("inputs") or {}
        if "seconds" in inputs:
            seconds.append({"node": node_id, "input": "seconds"})
        elif "seconds_total" in inputs:
            seconds.append({"node": node_id, "input": "seconds_total"})
    if seconds:
        primary = next((item for item in seconds if item["input"] == "seconds"), seconds[0])
        mapping["seconds"] = {
            "node": primary["node"],
            "input": primary["input"],
            "type": "number",
            "targets": seconds,
        }

    for node_id in sorted(graph, key=lambda item: int(item)):
        inputs = graph[node_id].get("inputs") or {}
        if "width" in inputs and "height" in inputs:
            mapping["width"] = {"node": node_id, "input": "width", "type": "integer"}
            mapping["height"] = {"node": node_id, "input": "height", "type": "integer"}
            break

    for node_id in sorted(graph, key=lambda item: int(item)):
        inputs = graph[node_id].get("inputs") or {}
        if "timeline_data" in inputs:
            mapping["timeline_data"] = {
                "node": node_id, "input": "timeline_data", "type": "json",
            }
            break

    return mapping


def _is_clip_text(graph, node_id):
    return (graph.get(node_id) or {}).get("class_type") == "CLIPTextEncode"


def validate_dependencies(graph, object_info):
    if not isinstance(graph, dict) or not graph:
        raise WorkflowImportError("工作流为空")
    for node_id, node in graph.items():
        class_type = node.get("class_type")
        if class_type not in object_info:
            raise WorkflowImportError(f"缺少自定义节点：{class_type}（#{node_id}）")
        required = ((object_info[class_type].get("input") or {}).get("required") or {})
        present = node.get("inputs") or {}
        for name in required:
            if name not in present:
                raise WorkflowImportError(
                    f"节点 {class_type}（#{node_id}）缺少必填输入：{name}"
                )


# -- ComfyUI HTTP 客户端 -------------------------------------------------


class ComfyClient:
    def __init__(self, base_url, timeout=30):
        self.base_url = str(base_url or "").rstrip("/")
        self.timeout = timeout

    def _request(self, path, payload=None):
        if not self.base_url:
            raise ComfyError("未配置 ComfyUI 地址")
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise ComfyError(f"ComfyUI 返回 {exc.code}：{detail}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ComfyError(f"ComfyUI 不可达：{exc}") from exc
        if not body:
            return None
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise ComfyError("ComfyUI 返回了非 JSON 数据") from exc

    def object_info(self):
        return self._request("/object_info") or {}

    def list_saved_workflows(self, directory="workflows"):
        result = self._request(
            f"/userdata?dir={urllib.parse.quote(directory)}&full_info=true"
        )
        if isinstance(result, dict):
            result = result.get("files") or []
        files = []
        for item in result or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") not in (None, "file"):
                continue
            path = str(item.get("path") or item.get("name") or "")
            if not path.lower().endswith(".json"):
                continue
            files.append({"path": path, "name": path.rsplit("/", 1)[-1]})
        return files

    def read_saved_workflow(self, path):
        data = self._request("/userdata/" + urllib.parse.quote(str(path), safe=""))
        if isinstance(data, dict) and isinstance(data.get("workflow"), dict):
            return data["workflow"]
        return data

    def submit(self, graph, client_id=None):
        payload = {"prompt": graph}
        if client_id:
            payload["client_id"] = client_id
        return self._request("/prompt", payload) or {}

    def history(self, prompt_id):
        return self._request("/history/" + urllib.parse.quote(str(prompt_id))) or {}
