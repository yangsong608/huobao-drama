# -*- coding: utf-8 -*-
"""火宝 H3 网关管理台：登录、ComfyUI 设置、工作流注册表、API Key 与审计。"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from markupsafe import Markup
from starlette.middleware.sessions import SessionMiddleware

try:
    from admin import comfy, db
except ModuleNotFoundError:  # 直接以脚本方式从 admin/ 内运行时
    import comfy  # type: ignore
    import db  # type: ignore

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"
KIND_LABELS = {"video": "视频", "image": "图片", "audio": "音频"}
SESSION_HOURS = 8
LOGIN_LIMIT = 5
LOGIN_WINDOW = 60


class LoginLimiter:
    def __init__(self, limit=LOGIN_LIMIT, window=LOGIN_WINDOW):
        self.limit = limit
        self.window = window
        self._fails = {}
        self._lock = threading.Lock()

    def _prune(self, key, stamp):
        attempts = [item for item in self._fails.get(key, []) if stamp - item < self.window]
        if attempts:
            self._fails[key] = attempts
        else:
            self._fails.pop(key, None)
        return attempts

    def blocked(self, key):
        with self._lock:
            return len(self._prune(key, time.time())) >= self.limit

    def fail(self, key):
        with self._lock:
            stamp = time.time()
            attempts = self._prune(key, stamp)
            attempts.append(stamp)
            self._fails[key] = attempts

    def reset(self, key):
        with self._lock:
            self._fails.pop(key, None)


def _load_secret(secret_key, db_path):
    if secret_key:
        return secret_key
    from_env = os.environ.get("H3_ADMIN_SECRET", "").strip()
    if from_env:
        return from_env
    path = os.path.join(os.path.dirname(os.path.abspath(db_path)), "admin.secret")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as handle:
            value = handle.read().strip()
        if value:
            return value
    value = secrets.token_urlsafe(48)
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
        handle.write(value)
    return value


def _fmt_ts(value):
    if not value:
        return "-"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(value)))
    except (TypeError, ValueError, OSError):
        return "-"


def _fmt_size(value):
    try:
        size = int(value)
    except (TypeError, ValueError):
        return "-"
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024.0
    return "-"


def _slugify(name):
    stem = str(name or "").rsplit("/", 1)[-1]
    if stem.lower().endswith(".json"):
        stem = stem[:-5]
    text = "".join(ch.lower() if ch.isascii() and (ch.isalnum() or ch in "_-") else "-" for ch in stem)
    text = text.strip("-")[:64]
    if text and text[0].isalnum():
        return text
    # 中文等非 ASCII 文件名无法生成可读 ASCII slug，用稳定哈希保证同一文件可重复导入
    return "workflow-" + hashlib.sha1(stem.encode("utf-8")).hexdigest()[:8]


def _client_ip(request):
    return request.client.host if request.client else "unknown"


def _safe_next(value):
    text = str(value or "").strip()
    if text.startswith("/") and not text.startswith("//"):
        return text
    return "/"


def _pretty(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def _raw_json(value):
    """textarea 中的 JSON：转义 HTML 边界字符但保持可解析。"""
    text = "" if value is None else str(value)
    text = text.replace("&", "&amp;").replace("<", "\\u003c").replace(">", "\\u003e")
    return Markup(text)


def create_app(
    db_path,
    secret_key=None,
    secure_cookies=False,
    bootstrap_user=None,
    bootstrap_password=None,
):
    db.init_db(db_path)
    if bootstrap_user and bootstrap_password and not db.list_admin_users(db_path):
        try:
            db.create_admin_user(db_path, bootstrap_user, bootstrap_password)
        except ValueError:
            pass

    app = FastAPI(title="火宝 H3 网关管理台", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db_path = db_path
    app.state.limiter = LoginLimiter()
    app.add_middleware(
        SessionMiddleware,
        secret_key=_load_secret(secret_key, db_path),
        session_cookie="h3_admin_session",
        max_age=SESSION_HOURS * 3600,
        same_site="lax",
        https_only=bool(secure_cookies),
    )

    templates = Jinja2Templates(directory=str(TEMPLATE_DIR))
    templates.env.filters["dt"] = _fmt_ts
    templates.env.filters["size"] = _fmt_size
    templates.env.filters["raw_json"] = _raw_json
    templates.env.globals["kind_labels"] = KIND_LABELS
    app.state.templates = templates
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    def path():
        return app.state.db_path

    def ensure_csrf(request):
        token = request.session.get("csrf")
        if not token:
            token = secrets.token_urlsafe(24)
            request.session["csrf"] = token
        return token

    def render(request, template, status_code=200, **context):
        context.setdefault("csrf", ensure_csrf(request))
        context.setdefault("user", request.session.get("user") or "")
        context.setdefault("flash", request.session.pop("flash", None))
        context.setdefault("active", "")
        return templates.TemplateResponse(request, template, context, status_code=status_code)

    async def form_or_403(request):
        form = await request.form()
        token = str(form.get("csrf") or "")
        expected = request.session.get("csrf") or ""
        if not token or not expected or not secrets.compare_digest(token, expected):
            raise HTTPException(status_code=403, detail="CSRF 校验失败，请刷新页面重试")
        return form

    def requires_login(request):
        if request.session.get("user"):
            return None
        target = request.url.path
        if request.url.query:
            target += "?" + request.url.query
        return RedirectResponse(f"/login?next={target}", status_code=303)

    def flash(request, message, level="ok"):
        request.session["flash"] = {"message": message, "level": level}

    def audit(request, action, target="", detail=""):
        db.audit(path(), request.session.get("user") or "-", action, target, detail)

    def client_for(request):
        url = db.get_setting(path(), "comfy_url", "").strip()
        if not url:
            raise comfy.ComfyError("尚未配置 ComfyUI 地址，请先在「设置」中填写")
        return comfy.ComfyClient(url, timeout=15), url

    def workflow_values(row=None):
        if not row:
            return {
                "slug": "", "name": "", "kind": "video", "description": "",
                "workflow_json": "", "input_map": "{}", "output_node": "",
                "output_key": "", "output_exts": "", "example_json": "{}",
                "is_active": True, "source": "manual", "source_file": "",
            }
        return {
            "slug": row.get("slug") or "",
            "name": row.get("name") or "",
            "kind": row.get("kind") or "video",
            "description": row.get("description") or "",
            "workflow_json": _pretty(row.get("workflow") or {}),
            "input_map": _pretty(row.get("input_map") or {}),
            "output_node": row.get("output_node") or "",
            "output_key": row.get("output_key") or "",
            "output_exts": ",".join(row.get("output_exts") or []),
            "example_json": _pretty(row.get("example") or {}),
            "is_active": bool(row.get("is_active", True)),
            "source": row.get("source") or "manual",
            "source_file": row.get("source_file") or "",
        }

    def submitted_values(form):
        return {
            "slug": str(form.get("slug") or "").strip(),
            "name": str(form.get("name") or "").strip(),
            "kind": str(form.get("kind") or "video").strip(),
            "description": str(form.get("description") or "").strip(),
            "workflow_json": str(form.get("workflow_json") or ""),
            "input_map": str(form.get("input_map") or "{}"),
            "output_node": str(form.get("output_node") or "").strip(),
            "output_key": str(form.get("output_key") or "").strip(),
            "output_exts": str(form.get("output_exts") or "").strip(),
            "example_json": str(form.get("example_json") or "{}"),
            "is_active": bool(form.get("is_active")),
            "source": str(form.get("source") or "manual").strip(),
            "source_file": str(form.get("source_file") or "").strip(),
        }

    def store_payload(values):
        return {
            "slug": values.get("slug"),
            "name": values.get("name"),
            "kind": values.get("kind"),
            "description": values.get("description"),
            "workflow": values.get("workflow_json"),
            "input_map": values.get("input_map"),
            "output_node": values.get("output_node"),
            "output_key": values.get("output_key"),
            "output_exts": values.get("output_exts"),
            "example": values.get("example_json"),
            "source": values.get("source") or "manual",
            "source_file": values.get("source_file") or "",
            "is_active": values.get("is_active", True),
        }

    # -- 登录 -------------------------------------------------------------

    @app.get("/login", response_class=HTMLResponse)
    async def login_page(request: Request):
        if request.session.get("user"):
            return RedirectResponse("/", status_code=303)
        return render(request, "login.html", next=request.query_params.get("next") or "")

    @app.post("/login")
    async def login_submit(request: Request):
        form = await form_or_403(request)
        ip = _client_ip(request)
        limiter = request.app.state.limiter
        if limiter.blocked(ip):
            return HTMLResponse(
                "<h1>登录尝试过于频繁</h1><p>请 1 分钟后再试。</p>",
                status_code=429, headers={"Retry-After": str(LOGIN_WINDOW)},
            )
        username = str(form.get("username") or "").strip()
        password = str(form.get("password") or "")
        if not db.verify_admin_user(path(), username, password):
            limiter.fail(ip)
            db.audit(path(), username or "-", "login.failed", target=ip)
            return render(
                request, "login.html", status_code=400, username=username,
                error="用户名或密码错误", next=str(form.get("next") or ""),
            )
        limiter.reset(ip)
        request.session.clear()
        request.session["user"] = username
        request.session["csrf"] = secrets.token_urlsafe(24)
        db.audit(path(), username, "login", target=ip, detail="成功")
        return RedirectResponse(_safe_next(form.get("next")), status_code=303)

    @app.post("/logout")
    async def logout(request: Request):
        await form_or_403(request)
        user = request.session.get("user")
        if user:
            db.audit(path(), user, "logout")
        request.session.clear()
        return RedirectResponse("/login", status_code=303)

    # -- 概览 -------------------------------------------------------------

    @app.get("/", response_class=HTMLResponse)
    async def dashboard(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        workflows = db.list_workflows(path())
        keys = db.list_api_keys(path())
        settings = db.all_settings(path())
        return render(
            request, "dashboard.html", active="dashboard",
            workflows=workflows,
            active_count=sum(1 for row in workflows if row["is_active"]),
            key_count=sum(1 for row in keys if row["is_active"]),
            comfy_url=settings.get("comfy_url", ""),
            env_comfy_url=os.environ.get("H3_COMFY_URL", ""),
            audit=db.list_audit(path(), 8),
            users=db.list_admin_users(path()),
        )

    # -- 设置 -------------------------------------------------------------

    @app.get("/settings", response_class=HTMLResponse)
    async def settings_page(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        return render(
            request, "settings.html", active="settings",
            comfy_url=db.get_setting(path(), "comfy_url", ""),
            env_comfy_url=os.environ.get("H3_COMFY_URL", ""),
            db_path=path(),
        )

    @app.post("/settings")
    async def save_settings(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        form = await form_or_403(request)
        value = str(form.get("comfy_url") or "").strip()
        db.set_setting(path(), "comfy_url", value)
        audit(request, "settings.save", "comfy_url", value)
        flash(request, "设置已保存，网关会在 5 秒内读取新地址。" if value else "已清空管理端地址，网关将沿用环境变量。")
        return RedirectResponse("/settings", status_code=303)

    @app.post("/settings/test", response_class=HTMLResponse)
    async def test_settings(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        form = await form_or_403(request)
        url = str(form.get("comfy_url") or "").strip() or db.get_setting(path(), "comfy_url", "").strip()
        if not url:
            flash(request, "请先填写 ComfyUI 地址", "error")
        else:
            try:
                info = comfy.ComfyClient(url, timeout=10).object_info()
                flash(request, f"ComfyUI 可用：返回 {len(info)} 个节点（{url.rstrip('/')}）")
            except comfy.ComfyError as exc:
                flash(request, f"ComfyUI 不可达：{exc}", "error")
        return render(
            request, "settings.html", active="settings",
            comfy_url=db.get_setting(path(), "comfy_url", ""),
            env_comfy_url=os.environ.get("H3_COMFY_URL", ""),
            db_path=path(),
        )

    # -- 工作流 -----------------------------------------------------------

    @app.get("/workflows", response_class=HTMLResponse)
    async def workflows_page(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        return render(
            request, "workflows.html", active="workflows",
            workflows=db.list_workflows(path()),
        )

    @app.get("/workflows/new", response_class=HTMLResponse)
    async def workflow_new(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        return render(
            request, "workflow_form.html", active="workflows",
            values=workflow_values(), mode="new", error="",
        )

    @app.post("/workflows/new", response_class=HTMLResponse)
    async def workflow_create(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        form = await form_or_403(request)
        values = submitted_values(form)
        try:
            row = db.upsert_workflow(path(), store_payload(values))
        except ValueError as exc:
            return render(
                request, "workflow_form.html", status_code=400,
                values=values, mode="new", error=str(exc), active="workflows",
            )
        audit(request, "workflow.create", row["slug"], row["name"])
        flash(request, f"工作流 {row['slug']} 已保存")
        return RedirectResponse("/workflows", status_code=303)

    @app.get("/workflows/import", response_class=HTMLResponse)
    async def import_list(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        files, error, url = [], "", db.get_setting(path(), "comfy_url", "")
        try:
            client, url = client_for(request)
            files = client.list_saved_workflows()
        except comfy.ComfyError as exc:
            error = str(exc)
        return render(
            request, "import_list.html", active="workflows",
            files=files, error=error, comfy_url=url,
        )

    @app.get("/workflows/import/preview", response_class=HTMLResponse)
    async def import_preview(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        file_path = request.query_params.get("path") or ""
        if not file_path:
            flash(request, "请选择要导入的工作流文件", "error")
            return RedirectResponse("/workflows/import", status_code=303)
        try:
            client, _url = client_for(request)
            object_info = client.object_info()
            ui_graph = client.read_saved_workflow(file_path)
            graph = comfy.convert_ui_workflow(ui_graph, object_info)
            comfy.validate_dependencies(graph, object_info)
        except (comfy.ComfyError, comfy.WorkflowImportError) as exc:
            flash(request, f"导入失败：{exc}", "error")
            return RedirectResponse("/workflows/import", status_code=303)

        output = comfy.suggest_output(graph)
        mapping = comfy.suggest_input_map(graph)
        example = {}
        for name, spec in mapping.items():
            targets = spec.get("targets") or [{"node": spec.get("node"), "input": spec.get("input")}]
            target = targets[0] if targets else {}
            node = graph.get(str(target.get("node") or "")) or {}
            value = (node.get("inputs") or {}).get(target.get("input"))
            if isinstance(value, list) and len(value) == 2:
                continue
            if name == "prompt" and not value:
                value = "描述画面或声音内容的提示词"
            if name == "negative_prompt" and not value:
                continue
            example[name] = value
        values = {
            "slug": _slugify(file_path),
            "name": _slugify(file_path),
            "kind": comfy.suggest_kind(graph),
            "description": "",
            "workflow_json": _pretty(graph),
            "input_map": _pretty(mapping),
            "output_node": output.get("node") or "",
            "output_key": output.get("key") or "",
            "output_exts": ",".join(output.get("exts") or []),
            "example_json": _pretty(example),
            "is_active": True,
            "source": "comfyui",
            "source_file": file_path,
        }
        return render(
            request, "import_preview.html", active="workflows",
            values=values, path=file_path, node_count=len(graph),
        )

    @app.post("/workflows/import", response_class=HTMLResponse)
    async def import_save(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        form = await form_or_403(request)
        values = submitted_values(form)
        values["source"] = "comfyui"
        values["source_file"] = str(form.get("path") or values.get("source_file") or "")
        try:
            row = db.upsert_workflow(path(), store_payload(values))
        except ValueError as exc:
            return render(
                request, "import_preview.html", status_code=400,
                values=values, path=values["source_file"], node_count=0, error=str(exc),
                active="workflows",
            )
        audit(request, "workflow.import", row["slug"], values["source_file"])
        flash(request, f"已从 ComfyUI 导入 {row['slug']}（{row['name']}）")
        return RedirectResponse("/workflows", status_code=303)

    @app.get("/workflows/{slug}/edit", response_class=HTMLResponse)
    async def workflow_edit(request: Request, slug: str):
        if (redirect := requires_login(request)):
            return redirect
        row = db.get_workflow(path(), slug)
        if not row:
            raise HTTPException(status_code=404, detail="工作流不存在")
        return render(
            request, "workflow_form.html", active="workflows",
            values=workflow_values(row), mode="edit", error="",
        )

    @app.post("/workflows/{slug}/edit", response_class=HTMLResponse)
    async def workflow_update(request: Request, slug: str):
        if (redirect := requires_login(request)):
            return redirect
        form = await form_or_403(request)
        values = submitted_values(form)
        try:
            row = db.upsert_workflow(path(), store_payload(values))
        except ValueError as exc:
            return render(
                request, "workflow_form.html", status_code=400,
                values=values, mode="edit", error=str(exc), active="workflows",
            )
        audit(request, "workflow.update", row["slug"], row["name"])
        flash(request, f"工作流 {row['slug']} 已更新")
        return RedirectResponse("/workflows", status_code=303)

    @app.post("/workflows/{slug}/toggle")
    async def workflow_toggle(request: Request, slug: str):
        if (redirect := requires_login(request)):
            return redirect
        await form_or_403(request)
        row = db.get_workflow(path(), slug)
        if not row:
            raise HTTPException(status_code=404, detail="工作流不存在")
        db.set_workflow_active(path(), slug, not row["is_active"])
        audit(request, "workflow.toggle", slug, "启用" if not row["is_active"] else "停用")
        flash(request, f"{slug} 已{'启用' if not row['is_active'] else '停用'}")
        return RedirectResponse("/workflows", status_code=303)

    @app.post("/workflows/{slug}/delete")
    async def workflow_delete(request: Request, slug: str):
        if (redirect := requires_login(request)):
            return redirect
        await form_or_403(request)
        if db.delete_workflow(path(), slug):
            audit(request, "workflow.delete", slug)
            flash(request, f"工作流 {slug} 已删除")
        return RedirectResponse("/workflows", status_code=303)

    @app.get("/workflows/{slug}/test", response_class=HTMLResponse)
    async def workflow_test_page(request: Request, slug: str):
        if (redirect := requires_login(request)):
            return redirect
        row = db.get_workflow(path(), slug)
        if not row:
            raise HTTPException(status_code=404, detail="工作流不存在")
        return render(
            request, "workflow_test.html", active="workflows",
            workflow=row, inputs=_pretty(row.get("example") or {}), result="", error="",
        )

    @app.post("/workflows/{slug}/test", response_class=HTMLResponse)
    async def workflow_test_run(request: Request, slug: str):
        if (redirect := requires_login(request)):
            return redirect
        form = await form_or_403(request)
        row = db.get_workflow(path(), slug)
        if not row:
            raise HTTPException(status_code=404, detail="工作流不存在")
        raw_inputs = str(form.get("inputs") or "{}")
        result, error = "", ""
        try:
            inputs = json.loads(raw_inputs)
            if not isinstance(inputs, dict):
                raise ValueError("输入必须是 JSON 对象")
            client, _url = client_for(request)
            object_info = client.object_info()
            comfy.validate_dependencies(row["workflow"], object_info)
            if form.get("run"):
                # 复用网关的输入注入，保证管理端测试与实际任务一致
                from h3_gateway import BadRequest, build_job_graph, validate_job_inputs

                validate_job_inputs(row, inputs)

                def no_upload(_value):
                    raise BadRequest("管理端测试暂不支持上传参考图，请改用网关任务")

                graph = build_job_graph(row, inputs, no_upload)
                response = client.submit(graph)
                prompt_id = response.get("prompt_id") or ""
                result = f"已提交到 ComfyUI：prompt_id={prompt_id}"
                audit(request, "workflow.run", slug, prompt_id)
            else:
                result = f"校验通过：{len(row['workflow'])} 个节点，依赖齐全"
                audit(request, "workflow.validate", slug)
        except (ValueError, json.JSONDecodeError) as exc:
            error = f"输入不合法：{exc}"
        except comfy.WorkflowImportError as exc:
            error = f"依赖不完整：{exc}"
        except comfy.ComfyError as exc:
            error = f"ComfyUI 请求失败：{exc}"
        except Exception as exc:  # 网关 BadRequest / 其他兼容异常，统一展示
            error = str(exc)
        return render(
            request, "workflow_test.html", status_code=400 if error else 200,
            workflow=row, inputs=raw_inputs, result=result, error=error,
            active="workflows",
        )

    # -- API Key ----------------------------------------------------------

    @app.get("/keys", response_class=HTMLResponse)
    async def keys_page(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        return render(
            request, "keys.html", active="keys",
            keys=db.list_api_keys(path()), new_key="",
        )

    @app.post("/keys", response_class=HTMLResponse)
    async def key_create(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        form = await form_or_403(request)
        try:
            plain, record = db.create_api_key(path(), form.get("name") or "")
        except ValueError as exc:
            return render(
                request, "keys.html", status_code=400, active="keys",
                keys=db.list_api_keys(path()), new_key="", error=str(exc),
            )
        audit(request, "key.create", record["key_prefix"], record["name"])
        return render(
            request, "keys.html", active="keys",
            keys=db.list_api_keys(path()), new_key=plain, error="",
        )

    @app.post("/keys/{key_id}/revoke")
    async def key_revoke(request: Request, key_id: int):
        if (redirect := requires_login(request)):
            return redirect
        await form_or_403(request)
        if db.revoke_api_key(path(), key_id):
            audit(request, "key.revoke", str(key_id))
            flash(request, "API Key 已吊销")
        return RedirectResponse("/keys", status_code=303)

    # -- 审计 -------------------------------------------------------------

    @app.get("/audit", response_class=HTMLResponse)
    async def audit_page(request: Request):
        if (redirect := requires_login(request)):
            return redirect
        return render(
            request, "audit.html", active="audit",
            logs=db.list_audit(path(), 300),
        )

    return app
