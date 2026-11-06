# -*- coding: utf-8 -*-
"""内置工作流种子：E12 整集时间线与 Stable Audio Open。

种子只在数据库缺少对应 slug 时写入，避免安装升级覆盖管理端改过的模型名与参数。
"""
import json
import os

try:
    from admin import db
except ModuleNotFoundError:  # 直接执行 admin/cli.py 时 admin 包不可见
    import db  # type: ignore

DEFAULT_SEED_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed"
)


def load_seeds(directory=None):
    directory = directory or DEFAULT_SEED_DIR
    with open(os.path.join(directory, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    items = []
    for entry in manifest.get("workflows") or []:
        file_name = str(entry.get("file") or "")
        if not file_name:
            raise ValueError(f"种子 {entry.get('slug')} 缺少 file")
        with open(os.path.join(directory, file_name), encoding="utf-8") as fh:
            workflow = json.load(fh)
        items.append({
            "slug": str(entry.get("slug") or ""),
            "name": str(entry.get("name") or ""),
            "kind": str(entry.get("kind") or ""),
            "description": entry.get("description") or "",
            "workflow": workflow,
            "input_map": entry.get("input_map") or {},
            "output_node": entry.get("output_node") or "",
            "output_key": entry.get("output_key") or "",
            "output_exts": entry.get("output_exts") or [],
            "example": entry.get("example") or {},
            "source": "seed",
            "source_file": f"seed/{file_name}",
        })
    return items


def import_seeds(db_path, directory=None):
    db.init_db(db_path)
    imported = []
    for payload in load_seeds(directory):
        if db.get_workflow(db_path, payload["slug"]):
            continue
        db.upsert_workflow(db_path, payload)
        imported.append(payload["slug"])
    return imported
