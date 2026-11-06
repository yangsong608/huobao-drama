# -*- coding: utf-8 -*-
"""管理端数据层：SQLite schema、工作流注册表、API Key、管理员口令。

只依赖标准库：网关（系统 python3）与管理端（venv）读同一个库。
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time

SCHEMA_VERSION = 1
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
KINDS = ("video", "image", "audio")
INPUT_TYPES = ("text", "number", "integer", "boolean", "json", "image")
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1

# comfy_url 不设默认值：空值表示沿用网关环境变量，避免管理端初始化覆盖既有部署
DEFAULT_SETTINGS = {}


def now():
    return time.time()


def connect(path):
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  last_login_at REAL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  last_used_at REAL
);
CREATE TABLE IF NOT EXISTS gateway_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow_json TEXT NOT NULL,
  input_map TEXT NOT NULL DEFAULT '{}',
  output_node TEXT NOT NULL DEFAULT '',
  output_key TEXT NOT NULL DEFAULT '',
  output_exts TEXT NOT NULL DEFAULT '[]',
  example_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'manual',
  source_file TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);
"""


def init_db(path):
    conn = connect(path)
    try:
        with conn:
            conn.executescript(SCHEMA)
            stamp = now()
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, stamp),
            )
            for key, value in DEFAULT_SETTINGS.items():
                conn.execute(
                    "INSERT OR IGNORE INTO gateway_settings (key, value, updated_at) VALUES (?, ?, ?)",
                    (key, value, stamp),
                )
    finally:
        conn.close()
    return path


# ---------------------------------------------------------------------------
# 行序列化
# ---------------------------------------------------------------------------

def _json_load(raw, fallback):
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return fallback
    return value if isinstance(value, type(fallback)) else fallback


def normalize_exts(value):
    if isinstance(value, str):
        value = value.split(",")
    exts = []
    for item in value or []:
        text = str(item or "").strip().lower().lstrip(".")
        if text and re.fullmatch(r"[a-z0-9]{1,8}", text) and text not in exts:
            exts.append(text)
    return exts


def workflow_row(row):
    if row is None:
        return None
    data = dict(row)
    data["workflow"] = _json_load(data.pop("workflow_json", "{}"), {})
    data["input_map"] = _json_load(data.get("input_map"), {})
    data["example"] = _json_load(data.get("example_json"), {})
    data["output_exts"] = normalize_exts(_json_load(data.get("output_exts"), []))
    data["is_active"] = bool(data.get("is_active"))
    return data


def public_workflow(row):
    """给客户端/列表用的公开视图：不返回工作流 JSON 与内部路径。"""
    data = workflow_row(row) if "workflow_json" in row.keys() else dict(row)
    inputs = {}
    for name, spec in (data.get("input_map") or {}).items():
        if not isinstance(spec, dict):
            continue
        inputs[name] = {
            "type": spec.get("type") or "text",
            "required": not bool(spec.get("optional")),
        }
    return {
        "slug": data["slug"],
        "name": data["name"],
        "kind": data["kind"],
        "description": data.get("description") or "",
        "inputs": inputs,
        "output": {
            "node": data.get("output_node") or "",
            "key": data.get("output_key") or "",
            "exts": data.get("output_exts") or [],
        },
        "example": data.get("example") or {},
        "source": data.get("source") or "manual",
        "is_active": bool(data.get("is_active")),
        "updated_at": data.get("updated_at"),
    }


def _validate_workflow_payload(data):
    slug = str(data.get("slug") or "").strip().lower()
    if not SLUG_RE.fullmatch(slug):
        raise ValueError("工作流标识只能使用小写字母、数字、下划线、短横线（最长 64）")
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("工作流名称不能为空")
    kind = str(data.get("kind") or "").strip().lower()
    if kind not in KINDS:
        raise ValueError("工作流类型必须是 video/image/audio")
    workflow = data.get("workflow")
    if isinstance(workflow, str):
        try:
            workflow = json.loads(workflow)
        except ValueError as exc:
            raise ValueError("工作流 JSON 不合法") from exc
    if not isinstance(workflow, dict) or not workflow:
        raise ValueError("工作流必须是 ComfyUI API 格式的节点对象")
    for node_id, node in workflow.items():
        if not isinstance(node, dict) or not node.get("class_type") or not isinstance(node.get("inputs"), dict):
            raise ValueError(f"节点 {node_id} 不是 API 格式（需要 class_type/inputs），请用 ComfyUI「导出（API）」")
    input_map = data.get("input_map") or {}
    if isinstance(input_map, str):
        try:
            input_map = json.loads(input_map)
        except ValueError as exc:
            raise ValueError("输入映射不是合法 JSON") from exc
    if not isinstance(input_map, dict):
        raise ValueError("输入映射必须是对象")
    for key, spec in input_map.items():
        if not isinstance(spec, dict):
            raise ValueError(f"输入映射 {key} 必须是对象")
        targets = spec.get("targets")
        if targets is None:
            targets = [{"node": spec.get("node"), "input": spec.get("input")}]
        if not isinstance(targets, list) or not targets:
            raise ValueError(f"输入映射 {key} 缺少目标节点")
        for target in targets:
            if not isinstance(target, dict):
                raise ValueError(f"输入映射 {key} 的目标必须是对象")
            node_id = str(target.get("node") or "")
            if node_id not in workflow:
                raise ValueError(f"输入映射 {key} 指向不存在的节点 {node_id}")
            node_inputs = workflow[node_id].get("inputs") or {}
            if not target.get("input") or target.get("input") not in node_inputs:
                raise ValueError(f"输入映射 {key} 指向节点 {node_id} 不存在的输入 {target.get('input')}")
        spec_type = str(spec.get("type") or "text")
        if spec_type not in INPUT_TYPES:
            raise ValueError(f"输入映射 {key} 的类型 {spec_type} 不受支持")
    output_node = str(data.get("output_node") or "").strip()
    if output_node and output_node not in workflow:
        raise ValueError(f"输出节点 {output_node} 不存在")
    example = data.get("example") or {}
    if isinstance(example, str):
        try:
            example = json.loads(example)
        except ValueError as exc:
            raise ValueError("示例输入不是合法 JSON") from exc
    if not isinstance(example, dict):
        raise ValueError("示例输入必须是对象")
    return {
        "slug": slug,
        "name": name,
        "kind": kind,
        "description": str(data.get("description") or "").strip(),
        "workflow": workflow,
        "input_map": input_map,
        "output_node": output_node,
        "output_key": str(data.get("output_key") or "").strip(),
        "output_exts": normalize_exts(data.get("output_exts")),
        "example": example,
        "source": str(data.get("source") or "manual").strip()[:32] or "manual",
        "source_file": str(data.get("source_file") or "").strip()[:512],
        "is_active": bool(data.get("is_active", True)),
    }


def upsert_workflow(path, data):
    clean = _validate_workflow_payload(data)
    stamp = now()
    conn = connect(path)
    try:
        with conn:
            existing = conn.execute("SELECT id FROM workflows WHERE slug = ?", (clean["slug"],)).fetchone()
            if existing:
                conn.execute(
                    """UPDATE workflows SET name=?, kind=?, description=?, workflow_json=?, input_map=?,
                       output_node=?, output_key=?, output_exts=?, example_json=?, source=?, source_file=?,
                       is_active=?, updated_at=? WHERE id=?""",
                    (
                        clean["name"], clean["kind"], clean["description"],
                        json.dumps(clean["workflow"], ensure_ascii=False),
                        json.dumps(clean["input_map"], ensure_ascii=False),
                        clean["output_node"], clean["output_key"],
                        json.dumps(clean["output_exts"]),
                        json.dumps(clean["example"], ensure_ascii=False),
                        clean["source"], clean["source_file"],
                        1 if clean["is_active"] else 0, stamp, existing["id"],
                    ),
                )
                workflow_id = existing["id"]
            else:
                cursor = conn.execute(
                    """INSERT INTO workflows
                       (slug, name, kind, description, workflow_json, input_map, output_node, output_key,
                        output_exts, example_json, source, source_file, is_active, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        clean["slug"], clean["name"], clean["kind"], clean["description"],
                        json.dumps(clean["workflow"], ensure_ascii=False),
                        json.dumps(clean["input_map"], ensure_ascii=False),
                        clean["output_node"], clean["output_key"],
                        json.dumps(clean["output_exts"]),
                        json.dumps(clean["example"], ensure_ascii=False),
                        clean["source"], clean["source_file"],
                        1 if clean["is_active"] else 0, stamp, stamp,
                    ),
                )
                workflow_id = cursor.lastrowid
            row = conn.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    finally:
        conn.close()
    return workflow_row(row)


def list_workflows(path, active_only=False):
    conn = connect(path)
    try:
        query = "SELECT * FROM workflows"
        if active_only:
            query += " WHERE is_active = 1"
        query += " ORDER BY updated_at DESC, id DESC"
        return [workflow_row(row) for row in conn.execute(query).fetchall()]
    finally:
        conn.close()


def get_workflow(path, slug):
    conn = connect(path)
    try:
        row = conn.execute("SELECT * FROM workflows WHERE slug = ?", (slug,)).fetchone()
        return workflow_row(row)
    finally:
        conn.close()


def set_workflow_active(path, slug, active):
    conn = connect(path)
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE workflows SET is_active=?, updated_at=? WHERE slug=?",
                (1 if active else 0, now(), slug),
            )
            return cursor.rowcount > 0
    finally:
        conn.close()


def delete_workflow(path, slug):
    conn = connect(path)
    try:
        with conn:
            cursor = conn.execute("DELETE FROM workflows WHERE slug = ?", (slug,))
            return cursor.rowcount > 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 设置 / API Key / 管理员
# ---------------------------------------------------------------------------

def get_setting(path, key, default=""):
    conn = connect(path)
    try:
        row = conn.execute("SELECT value FROM gateway_settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_setting(path, key, value):
    conn = connect(path)
    try:
        with conn:
            conn.execute(
                """INSERT INTO gateway_settings (key, value, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
                (key, str(value), now()),
            )
    finally:
        conn.close()


def all_settings(path):
    conn = connect(path)
    try:
        return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM gateway_settings")}
    finally:
        conn.close()


def hash_api_key(key):
    return hashlib.sha256(str(key).encode()).hexdigest()


def create_api_key(path, name, prefix="h3"):
    label = str(name or "").strip()
    if not label:
        raise ValueError("API Key 名称不能为空")
    key = f"{prefix}_{secrets.token_urlsafe(32)}"
    digest = hash_api_key(key)
    stamp = now()
    conn = connect(path)
    try:
        with conn:
            cursor = conn.execute(
                """INSERT INTO api_keys (name, key_prefix, key_hash, is_active, created_at)
                   VALUES (?, ?, ?, 1, ?)""",
                (label[:80], key[:12], digest, stamp),
            )
            record = {
                "id": cursor.lastrowid,
                "name": label[:80],
                "key_prefix": key[:12],
                "is_active": True,
                "created_at": stamp,
            }
    finally:
        conn.close()
    return key, record


def list_api_keys(path):
    conn = connect(path)
    try:
        return [dict(row) for row in conn.execute(
            "SELECT id, name, key_prefix, is_active, created_at, last_used_at FROM api_keys ORDER BY id DESC"
        )]
    finally:
        conn.close()


def revoke_api_key(path, key_id):
    conn = connect(path)
    try:
        with conn:
            cursor = conn.execute("UPDATE api_keys SET is_active = 0 WHERE id = ?", (int(key_id),))
            return cursor.rowcount > 0
    finally:
        conn.close()


def _hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        str(password).encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def _verify_password(password, stored):
    try:
        scheme, n, r, p, salt_hex, digest_hex = str(stored).split("$")
        if scheme != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.scrypt(
            str(password).encode(), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def create_admin_user(path, username, password):
    name = str(username or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{2,64}", name):
        raise ValueError("用户名需为 2-64 位字母、数字或 _ . @ -")
    if len(str(password or "")) < 8:
        raise ValueError("密码至少 8 位")
    stamp = now()
    conn = connect(path)
    try:
        with conn:
            cursor = conn.execute(
                """INSERT INTO admin_users (username, password_hash, is_active, created_at, updated_at)
                   VALUES (?, ?, 1, ?, ?)""",
                (name, _hash_password(password), stamp, stamp),
            )
            return cursor.lastrowid
    finally:
        conn.close()


def reset_admin_password(path, username, password):
    if len(str(password or "")) < 8:
        raise ValueError("密码至少 8 位")
    conn = connect(path)
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE admin_users SET password_hash=?, updated_at=? WHERE username=?",
                (_hash_password(password), now(), str(username).strip()),
            )
            return cursor.rowcount > 0
    finally:
        conn.close()


def verify_admin_user(path, username, password):
    conn = connect(path)
    try:
        row = conn.execute(
            "SELECT * FROM admin_users WHERE username = ? AND is_active = 1",
            (str(username or "").strip(),),
        ).fetchone()
    finally:
        conn.close()
    if not row or not _verify_password(password, row["password_hash"]):
        return False
    conn = connect(path)
    try:
        with conn:
            conn.execute("UPDATE admin_users SET last_login_at=? WHERE id=?", (now(), row["id"]))
    finally:
        conn.close()
    return True


def list_admin_users(path):
    conn = connect(path)
    try:
        return [dict(row) for row in conn.execute(
            "SELECT id, username, is_active, created_at, last_login_at FROM admin_users ORDER BY id"
        )]
    finally:
        conn.close()


def audit(path, actor, action, target="", detail=""):
    conn = connect(path)
    try:
        with conn:
            conn.execute(
                "INSERT INTO audit_logs (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)",
                (str(actor)[:80], str(action)[:80], str(target)[:160], str(detail)[:2000], now()),
            )
    finally:
        conn.close()


def list_audit(path, limit=200):
    conn = connect(path)
    try:
        return [dict(row) for row in conn.execute(
            "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", (int(limit),),
        )]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 网关只读视图
# ---------------------------------------------------------------------------

class GatewayStore:
    """网关进程的只读视图；数据库缺失时静默降级为“没有命名工作流/Key”。"""

    def __init__(self, path):
        self.path = path or ""
        self._setting_cache = (0.0, {})
        self._lock = __import__("threading").Lock()

    def _available(self):
        return bool(self.path) and os.path.isfile(self.path)

    def get_setting(self, key, default=""):
        if not self._available():
            return default
        with self._lock:
            stamp, cached = self._setting_cache
            if time.time() - stamp > 5:
                try:
                    conn = connect(self.path)
                    try:
                        cached = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM gateway_settings")}
                    finally:
                        conn.close()
                except sqlite3.Error:
                    cached = {}
                self._setting_cache = (time.time(), cached)
        return cached.get(key, default)

    def list_workflows(self, active_only=True):
        if not self._available():
            return []
        try:
            return list_workflows(self.path, active_only=active_only)
        except sqlite3.Error:
            return []

    def get_workflow(self, slug, active_only=True):
        if not self._available():
            return None
        try:
            row = get_workflow(self.path, slug)
        except sqlite3.Error:
            return None
        if not row or (active_only and not row.get("is_active")):
            return None
        return row

    def api_key_hashes(self):
        if not self._available():
            return set()
        try:
            conn = connect(self.path)
            try:
                return {row["key_hash"] for row in conn.execute(
                    "SELECT key_hash FROM api_keys WHERE is_active = 1"
                )}
            finally:
                conn.close()
        except sqlite3.Error:
            return set()

    def touch_api_key(self, digest):
        if not self._available() or not digest:
            return
        try:
            conn = connect(self.path)
            try:
                with conn:
                    conn.execute(
                        "UPDATE api_keys SET last_used_at=? WHERE key_hash=? AND (last_used_at IS NULL OR last_used_at < ?)",
                        (now(), digest, now() - 60),
                    )
            finally:
                conn.close()
        except sqlite3.Error:
            pass
