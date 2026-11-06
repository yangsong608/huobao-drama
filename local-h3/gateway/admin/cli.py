#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""管理端命令行：init-db / create-admin / reset-password / create-key / serve。"""
from __future__ import annotations

import argparse
import getpass
import os
import sys

try:
    from admin import db
    from admin import seed
except ModuleNotFoundError:  # python -m admin.cli 与直接执行兼容
    import db  # type: ignore
    import seed  # type: ignore

GATEWAY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.environ.get("H3_DB_PATH") or os.path.join(GATEWAY_DIR, "data", "gateway.db")


def _password(args, env_name):
    value = getattr(args, "password", None) or os.environ.get(env_name)
    if value:
        return value
    return getpass.getpass("密码（至少 8 位）：")


def cmd_init_db(args):
    db.init_db(args.db)
    print(f"数据库已初始化：{args.db}")
    return 0


def cmd_create_admin(args):
    username = args.username or os.environ.get("H3_ADMIN_USER") or "admin"
    try:
        db.create_admin_user(args.db, username, _password(args, "H3_ADMIN_PASSWORD"))
    except ValueError as exc:
        print(f"创建失败：{exc}", file=sys.stderr)
        return 1
    print(f"管理员已创建：{username}")
    return 0


def cmd_reset_password(args):
    username = args.username or os.environ.get("H3_ADMIN_USER") or "admin"
    try:
        changed = db.reset_admin_password(
            args.db, username, _password(args, "H3_ADMIN_PASSWORD")
        )
    except ValueError as exc:
        print(f"重置失败：{exc}", file=sys.stderr)
        return 1
    if not changed:
        print(f"用户不存在：{username}", file=sys.stderr)
        return 1
    print(f"密码已重置：{username}")
    return 0


def cmd_create_key(args):
    try:
        key, record = db.create_api_key(args.db, args.name)
    except ValueError as exc:
        print(f"创建失败：{exc}", file=sys.stderr)
        return 1
    print(f"API Key 已创建（只显示一次）：{record['name']}")
    print(key)
    return 0


def cmd_list_keys(args):
    keys = db.list_api_keys(args.db)
    if not keys:
        print("没有 API Key")
        return 0
    for item in keys:
        state = "可用" if item["is_active"] else "已吊销"
        print(f"{item['id']:>3}  {state:<4}  {item['key_prefix']}…  {item['name']}")
    return 0


def cmd_seed_workflows(args):
    imported = seed.import_seeds(args.db, args.dir)
    if not imported:
        print("种子工作流已存在，跳过")
        return 0
    print("已导入种子工作流：" + ", ".join(imported))
    return 0


def cmd_serve(args):
    try:
        import uvicorn
    except ModuleNotFoundError:
        print("缺少依赖：请先创建管理端 venv 并安装 requirements-admin.txt", file=sys.stderr)
        return 1
    try:
        from admin.app import create_app
    except ModuleNotFoundError:
        from app import create_app  # type: ignore

    app = create_app(
        db_path=args.db,
        secret_key=os.environ.get("H3_ADMIN_SECRET"),
        secure_cookies=bool(args.secure_cookies or os.environ.get("H3_ADMIN_SECURE_COOKIE") == "1"),
        bootstrap_user=os.environ.get("H3_ADMIN_USER"),
        bootstrap_password=os.environ.get("H3_ADMIN_PASSWORD"),
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="admin.cli", description="火宝 H3 网关管理台")
    parser.add_argument("--db", default=DEFAULT_DB, help=f"SQLite 路径（默认 {DEFAULT_DB}）")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db", help="初始化数据库").set_defaults(func=cmd_init_db)

    create_admin = sub.add_parser("create-admin", help="创建管理员")
    create_admin.add_argument("--username")
    create_admin.add_argument("--password", help="不建议写在命令行，可用 H3_ADMIN_PASSWORD")
    create_admin.set_defaults(func=cmd_create_admin)

    reset = sub.add_parser("reset-password", help="重置管理员密码")
    reset.add_argument("--username")
    reset.add_argument("--password")
    reset.set_defaults(func=cmd_reset_password)

    create_key = sub.add_parser("create-key", help="创建 API Key")
    create_key.add_argument("--name", required=True)
    create_key.set_defaults(func=cmd_create_key)

    sub.add_parser("list-keys", help="列出 API Key").set_defaults(func=cmd_list_keys)

    seed_cmd = sub.add_parser("seed-workflows", help="导入内置工作流（E12 时间线 / Stable Audio）")
    seed_cmd.add_argument("--dir", default=None, help="种子目录（默认 gateway/seed）")
    seed_cmd.set_defaults(func=cmd_seed_workflows)

    serve = sub.add_parser("serve", help="启动管理台 Web 服务")
    serve.add_argument("--host", default=os.environ.get("H3_ADMIN_HOST", "127.0.0.1"))
    serve.add_argument("--port", type=int, default=int(os.environ.get("H3_ADMIN_PORT", "8193")))
    serve.add_argument("--log-level", default="info")
    serve.add_argument("--secure-cookies", action="store_true")
    serve.set_defaults(func=cmd_serve)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    db.init_db(args.db)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
