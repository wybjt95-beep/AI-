#!/usr/bin/env python3
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from xml.sax.saxutils import escape as xml_escape
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROMPT_PATH = ROOT / "prompts" / "storyboard_split.md"
ANALYSIS_PROMPT_PATH = ROOT / "prompts" / "script_analysis.md"
DATA_DIR = ROOT / ".data"
STORE_PATH = DATA_DIR / "store.json"
DB_PATH = DATA_DIR / "app.db"
SECRET_PATH = DATA_DIR / "app_secret"
MAX_BODY_BYTES = 5_000_000
DEFAULT_SESSION_MAX_AGE = 1209600
CONFIG_KEYS = [
    "AI_PROVIDER",
    "AI_API_BASE_URL",
    "AI_API_KEY",
    "AI_TEXT_MODEL",
    "AI_IMAGE_MODEL",
    "AI_TEMPERATURE",
]


class ApiRequestError(Exception):
    def __init__(self, code, body, reason=""):
        self.code = code
        self.body = body
        self.reason = reason
        super().__init__(f"HTTP {code}: {body or reason}")


def env_file_path():
    return ROOT / ".env"


def load_env_file():
    for key, value in parse_env_file().items():
        os.environ.setdefault(key, value)


def parse_env_file():
    env_path = env_file_path()
    values = {}
    if not env_path.exists():
        return values
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def env(name, default=""):
    return os.environ.get(name, default).strip()


def env_value(value):
    return json.dumps(str(value or ""), ensure_ascii=False)


def now_ts():
    return int(time.time())


def configure_runtime_paths():
    global DATA_DIR, STORE_PATH, DB_PATH, SECRET_PATH
    configured = env("APP_DATA_DIR")
    DATA_DIR = Path(configured).expanduser() if configured else ROOT / ".data"
    if not DATA_DIR.is_absolute():
        DATA_DIR = ROOT / DATA_DIR
    STORE_PATH = DATA_DIR / "store.json"
    DB_PATH = DATA_DIR / "app.db"
    SECRET_PATH = DATA_DIR / "app_secret"


def ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def app_secret():
    ensure_data_dir()
    if env("APP_SECRET"):
        return env("APP_SECRET").encode("utf-8")
    if not SECRET_PATH.exists():
        SECRET_PATH.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    return SECRET_PATH.read_text(encoding="utf-8").strip().encode("utf-8")


@contextmanager
def db_connection():
    ensure_data_dir()
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_user(row):
    if not row:
        return None
    try:
        api_config = json.loads(row["api_config_json"] or "{}")
    except json.JSONDecodeError:
        api_config = {}
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "salt": row["salt"],
        "passwordHash": row["password_hash"],
        "apiConfig": api_config,
        "createdAt": row["created_at"],
    }


def init_db():
    ensure_data_dir()
    with db_connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                api_config_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                user_id TEXT NOT NULL,
                id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(user_id, id),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects(user_id, updated_at DESC)")
        migrate_legacy_store(conn)


def migrate_legacy_store(conn):
    if not STORE_PATH.exists():
        return
    user_count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
    if user_count:
        return
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return
    now = now_ts()
    for raw_user in data.get("users", []):
        user_id = str(raw_user.get("id") or f"user-{secrets.token_hex(8)}")
        email = str(raw_user.get("email") or "").strip().lower()
        if not email:
            continue
        conn.execute(
            """
            INSERT OR IGNORE INTO users
            (id, email, name, salt, password_hash, api_config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                email,
                str(raw_user.get("name") or email.split("@")[0]),
                str(raw_user.get("salt") or ""),
                str(raw_user.get("passwordHash") or ""),
                json.dumps(raw_user.get("apiConfig") or {}, ensure_ascii=False),
                int(raw_user.get("createdAt") or now),
                now,
            ),
        )
    for sid, session in (data.get("sessions") or {}).items():
        user_id = str(session.get("userId") or "")
        if not user_id:
            continue
        created_at = int(session.get("createdAt") or now)
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (str(sid), user_id, created_at, created_at + 1209600),
        )
    for user_id, projects in (data.get("projects") or {}).items():
        for payload in projects or []:
            if not isinstance(payload, dict):
                continue
            project_id = str(payload.get("id") or f"project-{secrets.token_hex(8)}")
            payload["id"] = project_id
            updated_at = str(payload.get("updatedAt") or now)
            conn.execute(
                """
                INSERT OR REPLACE INTO projects (user_id, id, payload_json, updated_at, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (str(user_id), project_id, json.dumps(payload, ensure_ascii=False), updated_at, now),
            )


def save_store(_store=None):
    return None


def find_user(_store=None, user_id=None, email=None, name=None):
    normalized_email = str(email or "").strip().lower()
    normalized_name = str(name or "").strip()
    if not user_id and not normalized_email and not normalized_name:
        return None
    with db_connection() as conn:
        if user_id:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (str(user_id),)).fetchone()
        elif normalized_email:
            row = conn.execute("SELECT * FROM users WHERE email = ?", (normalized_email,)).fetchone()
        else:
            row = conn.execute("SELECT * FROM users WHERE lower(name) = lower(?) ORDER BY created_at DESC LIMIT 1", (normalized_name,)).fetchone()
    return row_to_user(row)


def find_user_by_identifier(identifier):
    value = str(identifier or "").strip()
    if not value:
        return None
    if "@" in value:
        return find_user(email=value)
    return find_user(name=value)


def public_user(user):
    if not user:
        return None
    return {
        "id": user.get("id"),
        "email": user.get("email"),
        "name": user.get("name") or user.get("email"),
    }


def hash_password(password, salt=None):
    salt_bytes = base64.b64decode(salt) if salt else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, 160_000)
    return base64.b64encode(salt_bytes).decode("ascii"), base64.b64encode(digest).decode("ascii")


def verify_password(password, salt, digest):
    _, check = hash_password(password, salt)
    return hmac.compare_digest(check, digest)


def stream_key(secret, nonce, length):
    output = b""
    counter = 0
    while len(output) < length:
        output += hmac.new(secret, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return output[:length]


def encrypt_secret(value):
    if not value:
        return ""
    data = value.encode("utf-8")
    nonce = secrets.token_bytes(16)
    mask = stream_key(app_secret(), nonce, len(data))
    cipher = bytes(a ^ b for a, b in zip(data, mask))
    tag = hmac.new(app_secret(), nonce + cipher, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(nonce + tag + cipher).decode("ascii")


def decrypt_secret(token):
    if not token:
        return ""
    raw = base64.urlsafe_b64decode(token.encode("ascii"))
    nonce, tag, cipher = raw[:16], raw[16:32], raw[32:]
    expected = hmac.new(app_secret(), nonce + cipher, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(tag, expected):
        raise ValueError("API Key 解密校验失败")
    mask = stream_key(app_secret(), nonce, len(cipher))
    data = bytes(a ^ b for a, b in zip(cipher, mask))
    return data.decode("utf-8")


def parse_cookies(handler):
    cookies = {}
    for part in (handler.headers.get("Cookie") or "").split(";"):
        if "=" in part:
            key, value = part.strip().split("=", 1)
            cookies[key] = value
    return cookies


def session_max_age():
    try:
        return max(60, int(env("SESSION_MAX_AGE_SECONDS", str(DEFAULT_SESSION_MAX_AGE))))
    except ValueError:
        return DEFAULT_SESSION_MAX_AGE


def cookie_secure_enabled():
    value = env("COOKIE_SECURE").lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return env("APP_ENV").lower() in {"production", "prod"}


def session_cookie_header(sid, max_age=None):
    parts = [
        f"sid={sid}",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        f"Max-Age={session_max_age() if max_age is None else max_age}",
    ]
    if cookie_secure_enabled():
        parts.append("Secure")
    return "; ".join(parts)


def current_user(handler):
    sid = parse_cookies(handler).get("sid")
    if not sid:
        return None, None
    with db_connection() as conn:
        row = conn.execute(
            """
            SELECT users.*
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ? AND sessions.expires_at > ?
            """,
            (sid, now_ts()),
        ).fetchone()
        if not row:
            conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
            return None, None
    return row_to_user(row), None


def set_session_cookie(handler, sid):
    handler.send_header("Set-Cookie", session_cookie_header(sid))


def clear_session_cookie(handler):
    handler.send_header("Set-Cookie", session_cookie_header("", 0))


def create_session(_store, user):
    sid = secrets.token_urlsafe(32)
    created_at = now_ts()
    with db_connection() as conn:
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (sid, user["id"], created_at, created_at + session_max_age()),
        )
    return sid


def register_user(payload):
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    name = str(payload.get("name") or "").strip()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise ValueError("请输入有效邮箱")
    if len(password) < 6:
        raise ValueError("密码至少 6 位")
    if find_user(email=email):
        raise ValueError("该邮箱已注册")
    if name and find_user(name=name):
        raise ValueError("该用户名已被使用")
    salt, digest = hash_password(password)
    user = {
        "id": f"user-{secrets.token_hex(8)}",
        "email": email,
        "name": name or email.split("@")[0],
        "salt": salt,
        "passwordHash": digest,
        "apiConfig": {},
        "createdAt": now_ts(),
    }
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO users (id, email, name, salt, password_hash, api_config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user["id"],
                user["email"],
                user["name"],
                user["salt"],
                user["passwordHash"],
                json.dumps(user["apiConfig"], ensure_ascii=False),
                user["createdAt"],
                user["createdAt"],
            ),
        )
    return None, "", user


def login_user(payload):
    identifier = str(payload.get("identifier") or payload.get("email") or payload.get("name") or "").strip()
    password = str(payload.get("password") or "")
    user = find_user_by_identifier(identifier)
    if not user or not verify_password(password, user.get("salt", ""), user.get("passwordHash", "")):
        raise ValueError("用户名/邮箱或密码不正确")
    sid = create_session(None, user)
    return None, sid, user


def logout_user(handler):
    sid = parse_cookies(handler).get("sid")
    if sid:
        with db_connection() as conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))


def require_user(handler):
    user, store = current_user(handler)
    if not user:
        raise PermissionError("请先登录")
    return user, store


def user_projects(_store, user_id=None):
    if user_id is None:
        user_id = _store
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT payload_json FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
            (str(user_id),),
        ).fetchall()
    projects = []
    for row in rows:
        try:
            projects.append(json.loads(row["payload_json"]))
        except json.JSONDecodeError:
            continue
    return projects


def save_user_project(store, user, payload):
    project_id = str(payload.get("id") or f"project-{secrets.token_hex(8)}")
    payload["id"] = project_id
    payload["updatedAt"] = payload.get("updatedAt") or str(now_ts())
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO projects (user_id, id, payload_json, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, id) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at
            """,
            (user["id"], project_id, json.dumps(payload, ensure_ascii=False), str(payload["updatedAt"]), now_ts()),
        )
        stale_rows = conn.execute(
            """
            SELECT id FROM projects
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT -1 OFFSET 100
            """,
            (user["id"],),
        ).fetchall()
        stale_ids = [row["id"] for row in stale_rows]
        if stale_ids:
            conn.executemany("DELETE FROM projects WHERE user_id = ? AND id = ?", [(user["id"], stale_id) for stale_id in stale_ids])
    return payload


def delete_user_project(store, user, project_id):
    with db_connection() as conn:
        conn.execute("DELETE FROM projects WHERE user_id = ? AND id = ?", (user["id"], str(project_id)))


def user_api_config(user):
    raw = (user or {}).get("apiConfig") or {}
    api_key = ""
    if raw.get("apiKeyEncrypted"):
        api_key = decrypt_secret(raw.get("apiKeyEncrypted"))
    return {
        "provider": raw.get("provider") or "mock",
        "apiBaseUrl": raw.get("apiBaseUrl") or "https://api.openai.com/v1",
        "apiKey": api_key,
        "textModel": raw.get("textModel") or "",
        "imageModel": raw.get("imageModel") or "",
        "temperature": raw.get("temperature") or "0.7",
    }


def config_status(user=None):
    cfg = user_api_config(user) if user else {}
    api_key = cfg.get("apiKey", "")
    warnings = []
    api_base = cfg.get("apiBaseUrl") or "https://api.openai.com/v1"
    text_model = cfg.get("textModel") or ""
    if "api.openai.com" in api_base and text_model.lower().startswith("gemini"):
        warnings.append("当前 Base URL 是 OpenAI，但文本模型名像 Gemini，二者通常不匹配。")
    if not user:
        warnings.append("请先登录。上线后每个用户都需要配置自己的 API Key。")
    return {
        "provider": cfg.get("provider") or "mock",
        "apiBaseUrl": api_base,
        "textModel": text_model,
        "imageModel": cfg.get("imageModel") or "",
        "temperature": cfg.get("temperature") or "0.7",
        "apiKeyConfigured": bool(api_key),
        "apiKeyHint": f"已配置，尾号 {api_key[-4:]}" if api_key else "未配置 API Key",
        "textConfigured": bool(api_base and api_key and text_model),
        "imageConfigured": bool(api_base and api_key and cfg.get("imageModel")),
        "warnings": warnings,
    }


def save_config(payload, user):
    if not user:
        raise PermissionError("请先登录后再保存 API 配置")
    existing = user.get("apiConfig") or {}
    provider = str(payload.get("provider") or env("AI_PROVIDER", "mock")).strip() or "mock"
    if provider not in {"mock", "openai-compatible", "custom"}:
        raise ValueError("服务商配置不支持")

    api_key = str(payload.get("apiKey") or "").strip()
    if not api_key:
        api_key = decrypt_secret(existing.get("apiKeyEncrypted")) if existing.get("apiKeyEncrypted") else ""

    temperature = str(payload.get("temperature") or env("AI_TEMPERATURE", "0.7")).strip() or "0.7"
    try:
        temperature_number = float(temperature)
    except ValueError as exc:
        raise ValueError("Temperature 必须是数字") from exc
    temperature = str(min(2, max(0, temperature_number)))

    api_config = {
        "provider": provider,
        "apiBaseUrl": str(payload.get("apiBaseUrl") or existing.get("apiBaseUrl") or "https://api.openai.com/v1").strip(),
        "apiKeyEncrypted": encrypt_secret(api_key),
        "textModel": str(payload.get("textModel") or existing.get("textModel") or "").strip(),
        "imageModel": str(payload.get("imageModel") or existing.get("imageModel") or "").strip(),
        "temperature": temperature,
        "updatedAt": now_ts(),
    }
    user["apiConfig"] = api_config
    with db_connection() as conn:
        conn.execute(
            "UPDATE users SET api_config_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(api_config, ensure_ascii=False), now_ts(), user["id"]),
        )
    return config_status(user)


def json_response(handler, status, payload, extra_headers=None):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for key, value in (extra_headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def binary_response(handler, status, body, content_type, filename):
    encoded_filename = urllib.parse.quote(filename)
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded_filename}")
    handler.end_headers()
    handler.wfile.write(body)


def read_json_body(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    if length > MAX_BODY_BYTES:
        raise ValueError("请求内容过大")
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def unique(items):
    seen = []
    for item in items:
        value = str(item or "").strip()
        if value and value not in seen:
            seen.append(value)
    return seen


def as_text(value, fallback="待补充"):
    if isinstance(value, list):
        text = "、".join(unique(value))
    else:
        text = str(value or "").strip()
    return text or fallback


def as_list(value):
    if isinstance(value, list):
        return unique(value)
    return unique(re.split(r"[\n,，、;；+＋]", str(value or "")))


def tag_list(value, limit=3):
    if isinstance(value, list):
        items = value
    else:
        items = re.split(r"[\n,，、;；+＋]", str(value or ""))
    return unique(items)[:limit]


def tag_text(value, limit=3):
    return "、".join(tag_list(value, limit))


DEFAULT_VISUAL_STYLE_TAGS = "真实电影摄影风格、高端TVC广告风格、都市生活方式风格"
DEFAULT_COLOR_TONE_TAGS = "自然真实色调、中低对比度、自然肤色色调"


def canonical_visual_style(payload):
    return payload.get("overallVisualStyle") or payload.get("visualStyle") or ""


def canonical_color_tone(payload):
    return payload.get("overallColorTone") or payload.get("overallTone") or payload.get("tone") or ""


def is_default_tag_value(value, default_value):
    return tag_text(value, 3) == tag_text(default_value, 3)


def explicit_visual_style(payload):
    value = canonical_visual_style(payload)
    if value and not is_default_tag_value(value, DEFAULT_VISUAL_STYLE_TAGS):
        return tag_text(value, 3)
    return ""


def explicit_color_tone(payload):
    value = canonical_color_tone(payload)
    if value and not is_default_tag_value(value, DEFAULT_COLOR_TONE_TAGS):
        return tag_text(value, 3)
    return ""


def contains_any(text, words):
    return any(word in text for word in words)


def recommend_visual_look(payload, analysis=None, script=""):
    project = payload.get("project") or {}
    analysis = analysis or payload.get("analysis") or {}
    context = " ".join(
        [
            str(project.get("type") or ""),
            str(project.get("style") or ""),
            str(project.get("platform") or ""),
            str(payload.get("globalNotes") or ""),
            creativity_label(payload.get("creativity")),
            script,
            " ".join(str(item) for values in analysis.values() if isinstance(values, list) for item in values),
        ]
    )

    style = explicit_visual_style(payload)
    color_tone = explicit_color_tone(payload)
    if not style:
        if contains_any(context, ["工厂", "制造", "机械", "设备", "工程", "生产线", "工业", "车间"]):
            style = "工业纪录片风格、智能制造宣传片风格、硬朗写实风格"
        elif contains_any(context, ["汽车", "电动车", "车辆", "骑行", "驾驶", "通勤"]):
            style = "电影级实拍风格、汽车广告风格、都市生活方式风格"
        elif contains_any(context, ["AI", "人工智能", "科技", "数据", "软件", "APP", "平台", "智能"]):
            style = "真实摄影风格、科技产品广告风格、极简科技风格"
        elif contains_any(context, ["食品", "饮料", "咖啡", "餐", "早餐", "美食"]):
            style = "商业摄影风格、食品广告风格、生活方式广告风格"
        elif contains_any(context, ["美妆", "护肤", "口红", "香水", "时尚", "服装"]):
            style = "产品商业摄影风格、美妆广告风格、时尚广告风格"
        elif contains_any(context, ["家庭", "亲子", "母亲", "父亲", "孩子", "家中", "客厅", "温柔", "温情"]):
            style = "自然实拍风格、家庭生活风格、温情故事风格"
        elif contains_any(context, ["公园", "河边", "山", "森林", "户外", "自然", "治愈"]):
            style = "生活方式摄影风格、自然治愈风格、清新文艺风格"
        elif contains_any(context, ["复古", "怀旧", "年代", "老上海", "港风", "胶片", "VHS"]):
            style = "老胶片电影风格、复古年代广告风格、生活方式摄影风格"
        elif contains_any(context, ["潮流", "年轻", "社媒", "小红书", "抖音", "种草", "多巴胺"]):
            style = "年轻化品牌风格、社交媒体视觉风格、生活方式广告风格"
        elif contains_any(context, ["诗意", "梦境", "超现实", "实验", "意识流"]):
            style = "视觉诗风格、艺术摄影风格、概念艺术风格"
        else:
            style = DEFAULT_VISUAL_STYLE_TAGS

    if not color_tone:
        if contains_any(context, ["工厂", "制造", "机械", "设备", "工程", "生产线", "工业", "车间"]):
            color_tone = "工业蓝灰色调、金属质感色调、硬朗低饱和色调"
        elif contains_any(context, ["汽车", "电动车", "车辆", "骑行", "驾驶", "通勤"]):
            color_tone = "低饱和冷灰蓝色调、中低对比度、自然肤色色调"
        elif contains_any(context, ["AI", "人工智能", "科技", "数据", "软件", "APP", "平台", "智能"]):
            color_tone = "科技蓝色调、冷白科技色调、青绿色数字色调"
        elif contains_any(context, ["食品", "饮料", "咖啡", "餐", "早餐", "美食"]):
            color_tone = "奶油暖色调、高明度低饱和色调、自然柔和肤色"
        elif contains_any(context, ["美妆", "护肤", "口红", "香水", "时尚", "服装"]):
            color_tone = "清透自然色调、柔和粉彩色调、自然肤色色调"
        elif contains_any(context, ["家庭", "亲子", "母亲", "父亲", "孩子", "家中", "客厅", "温柔", "温情"]):
            color_tone = "奶油暖白色调、低对比自然色调、温馨家庭暖调"
        elif contains_any(context, ["公园", "河边", "山", "森林", "户外", "自然", "治愈"]):
            color_tone = "清透自然色调、自然植被绿色调、自然日光色调"
        elif contains_any(context, ["复古", "怀旧", "年代", "老上海", "港风", "胶片", "VHS"]):
            color_tone = "复古电影色调、泛黄色调、棕褐复古色调"
        elif contains_any(context, ["夜", "霓虹", "赛博"]):
            color_tone = "霓虹蓝粉色调、冷蓝紫色调、黑蓝科技色调"
        elif contains_any(context, ["清新", "年轻", "社媒", "小红书", "抖音", "种草", "多巴胺"]):
            color_tone = "清新明亮色调、高明度低饱和色调、轻盈空气感色调"
        else:
            color_tone = DEFAULT_COLOR_TONE_TAGS

    return {
        "overallVisualStyle": tag_text(style, 3),
        "overallColorTone": tag_text(color_tone, 3),
    }


def pick(mapping, *keys, default=None):
    if not isinstance(mapping, dict):
        return default
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return default


def int_duration(project):
    try:
        return max(1, int(float(project.get("duration") or 30)))
    except (TypeError, ValueError):
        return 30


def requested_shot_count(payload):
    raw = str(payload.get("shotCount") or "").strip()
    if not raw:
        return None
    try:
        value = int(float(raw))
    except ValueError:
        return None
    return min(24, max(1, value))


def storyboard_bank():
    return [
        ["地点建立", "办公楼前建立镜头，年轻上班族推着新能源电动车进入画面，先交代地点、人物和产品关系。", "远景", "固定轻推", "道路线、环境", "地点、人物、产品关系"],
        ["启动细节", "手部特写触发车辆启动，智能仪表亮起，表现启动平稳和操作轻便。", "特写", "微距推进", "车把、启动键、智能仪表", "启动细节与智能感"],
        ["创意机位", "低机位贴近车轮跟拍，车辆从城市街道轻快经过，地面线条快速后退。", "近景", "低机位跟拍", "车轮、道路线", "轻便、速度与稳定"],
        ["驾驶体验", "人物骑行经过路口，背景自然后移，画面重点放在安静、顺滑和真实通勤状态。", "中远景", "横向跟拍", "头盔、背包", "通勤体验"],
        ["信息特写", "智能仪表清晰显示速度和电量，画面干净，不堆砌信息。", "特写", "轻微推进", "智能仪表、电量、速度", "智能卖点"],
        ["安全瞬间", "人物在关键位置完成观察、停顿或确认动作，让安全感通过动作表达。", "中景", "跟随转定镜", "车灯、道路线", "安全感"],
        ["轻松收尾", "人物到达办公楼前轻松停车，车辆停在画面前景，人物状态轻松。", "中景", "小幅环绕", "停车点、背包", "轻松收尾"],
        ["口号留白", "广告收束，人物与车辆形成最后记忆点，画面侧边预留口号或字幕位置。", "广角", "慢慢拉远", "品牌口号占位", "品牌记忆"],
    ]


def script_units(script, max_units=8):
    text = re.sub(r"\s+", " ", str(script or "")).strip()
    if not text:
        return []
    rough = re.split(r"[。！？!?；;\n]+", text)
    units = []
    for part in rough:
        part = part.strip(" ，,")
        if not part:
            continue
        clauses = re.split(r"[，,]", part) if len(part) > 42 else [part]
        for clause in clauses:
            clause = clause.strip()
            if clause:
                units.append(clause)
    merged = []
    for unit in units:
        if merged and len(merged[-1]) + len(unit) < 28:
            merged[-1] = f"{merged[-1]}，{unit}"
        else:
            merged.append(unit)
    return merged[:max_units]


def creativity_label(value):
    try:
        level = int(float(value))
    except (TypeError, ValueError):
        level = 60
    level = max(0, min(100, level))
    if level <= 20:
        return "保守：镜头拆解贴近原脚本，少做额外创意延展。"
    if level <= 45:
        return "稳妥：允许轻微优化镜头顺序和画面表达。"
    if level <= 75:
        return "平衡：在不偏离脚本的前提下提供可讨论的构图和动作创意。"
    return "脑洞：允许更有个性的镜头角度、转场和视觉表达，但必须服务脚本目的。"


def pick_from_text(options, text, fallback, offset=0):
    values = [str(item).strip() for item in (options or []) if str(item).strip()]
    if not values:
        return fallback
    for item in values:
        if item and item in text:
            return item
    return values[offset % len(values)]


def infer_prop_text(text, fallback="环境元素"):
    if any(word in text for word in ["树", "草", "河", "湖", "路"]):
        return "树木、路面、环境"
    if any(word in text for word in ["电脑", "屏幕", "办公"]):
        return "电脑、书桌"
    if any(word in text for word in ["杯", "水", "咖啡", "饮料"]):
        return "杯子"
    if any(word in text for word in ["书", "资料", "文件"]):
        return "书本、资料"
    if any(word in text for word in ["手机", "APP", "界面"]):
        return "手机、界面"
    return fallback


def infer_mock_shot_size(text, index, total):
    if any(word in text for word in ["手", "眼神", "表情", "电脑", "手机", "杯", "道具", "细节", "特写"]):
        return "特写" if index else "近景"
    if index == 0:
        return "远景"
    if index == total - 1:
        return "中景"
    return ["中景", "近景", "中远景"][index % 3]


def infer_mock_camera(text, index):
    if any(word in text for word in ["走", "跑", "穿过", "移动", "经过", "骑", "跟"]):
        return "跟拍"
    if any(word in text for word in ["看", "相视", "对视", "发现", "望"]):
        return "轻推至反应"
    if any(word in text for word in ["放下", "拿起", "递", "打开", "启动"]):
        return "微距推进"
    return ["固定镜头", "缓慢推进", "横向轻移", "小幅环绕"][index % 4]


def infer_mock_angle(text, index):
    if any(word in text for word in ["肩", "背影", "身后", "跟随"]):
        return "过肩视角"
    if any(word in text for word in ["桌面", "俯拍", "摆放", "书桌", "电脑", "手机", "产品", "餐", "杯"]):
        return "俯视角度"
    if any(word in text for word in ["高楼", "大楼", "天空", "仰望", "宏大"]):
        return "低机位仰拍"
    if any(word in text for word in ["手", "眼神", "表情", "细节", "特写"]):
        return "平视近角度"
    if index == 0:
        return "正面平视"
    return ["正面平视", "侧面视角", "三分之四侧前方", "过肩视角"][index % 4]


def mock_shot_type(text, index, total):
    if index == 0:
        return "场景建立"
    if index == total - 1:
        return "情绪收束"
    if any(word in text for word in ["电脑", "手机", "杯", "道具", "手", "细节"]):
        return "细节强调"
    if any(word in text for word in ["看", "笑", "相视", "对话", "说"]):
        return "关系反应"
    return "动作推进"


def mock_analyze(payload, source="mock"):
    script = str(payload.get("script") or "")
    has = lambda word: word in script
    quoted = [match.group(1).strip() for match in re.finditer(r"[“\"『「]([^”\"』」]{2,80})[”\"』」]", script)]
    narration = [match.group(1).strip() for match in re.finditer(r"(?:旁白|口播|VO|字幕|文案)[：:]([^。！？!?；;\n]+)", script, re.I)]

    people_candidates = [
        "年轻上班族",
        "主人公",
        "主角",
        "女主",
        "男主",
        "母亲",
        "父亲",
        "用户",
        "顾客",
        "年轻女性",
        "年轻男性",
        "女性用户",
        "男性用户",
        "女生",
        "男生",
        "女士",
        "男士",
        "学生",
        "妈妈",
        "孩子",
        "老人",
        "员工",
        "同事",
        "朋友",
        "家人",
        "店员",
        "客户",
        "讲述者",
    ]
    product_candidates = ["新能源电动车", "健康饮食APP", "电动车", "车辆", "汽车", "手机", "APP", "小程序", "咖啡", "饮料", "护肤品", "课程", "产品", "服务"]
    location_candidates = ["办公楼前", "城市街道", "通勤路口", "城市道路", "路口", "办公室", "会议室", "书房", "河边公园", "河边", "家中", "客厅", "厨房", "门店", "商场", "校园", "公园", "地铁站", "室内", "户外"]
    prop_candidates = ["智能仪表", "车把", "启动键", "车轮", "头盔", "背包", "电量", "速度", "品牌口号", "手机", "电脑", "笔记本电脑", "水杯", "杯子", "书桌", "书本", "海报", "包装", "屏幕", "早餐", "食物", "界面"]
    time_candidates = ["清晨", "上午", "中午", "下午", "傍晚", "夜晚", "白天", "深夜"]
    selling_candidates = ["轻便", "安全", "智能", "平稳", "安静", "清晰", "高效", "便捷", "舒适", "可靠", "省时", "专业", "年轻", "高级"]

    analysis = {
        "people": unique([item for item in people_candidates if has(item)]),
        "product": unique([item for item in product_candidates if has(item)]),
        "locations": unique([item for item in location_candidates if has(item)]),
        "props": unique([item for item in prop_candidates if has(item)]),
        "times": unique([item for item in time_candidates if has(item)]),
        "sellingPoints": unique([item for item in selling_candidates if has(item)]),
        "dialogue": unique(quoted),
        "narration": unique(narration),
    }
    return {
        "source": source,
        "analysis": analysis,
        "warning": "当前未配置真实模型，已使用后端本地演示剧本分析。",
    }


def mock_split(payload, source="mock"):
    project = payload.get("project") or {}
    analysis = payload.get("analysis") or {}
    script = str(payload.get("script") or "")
    duration = int_duration(project)
    target_count = requested_shot_count(payload)
    units = script_units(script, target_count or 8)
    if not units:
        units = [
            f"在{(analysis.get('locations') or ['主要场景'])[0]}建立人物和空间关系",
            f"围绕{(analysis.get('props') or analysis.get('product') or ['核心物件'])[0]}呈现关键动作",
            "捕捉人物反应和情绪变化",
            "用留白或稳定构图完成收束",
        ]
    total = target_count or (min(8, max(4, len(units))) if duration >= 15 else min(6, max(3, len(units))))
    while len(units) < total:
        units.append(units[-1])
    units = units[:total]
    base = max(1, duration // len(units))
    remain = max(0, duration - base * len(units))
    people = analysis.get("people") or []
    locations = analysis.get("locations") or []
    props = analysis.get("props") or []
    products = analysis.get("product") or []
    times = analysis.get("times") or []
    selling_points = analysis.get("sellingPoints") or []
    dialogue = analysis.get("dialogue") or []
    narration = analysis.get("narration") or []
    include_dialogue = payload.get("includeDialogue") is not False
    include_narration = payload.get("includeNarration") is not False

    shots = []
    current_location = locations[0] if locations else ""
    for index, unit in enumerate(units):
        shot_duration = base + (1 if remain > 0 else 0)
        remain -= 1
        matched_location = next((str(item).strip() for item in locations if str(item).strip() and str(item).strip() in unit), "")
        if matched_location:
            current_location = matched_location
        location = current_location or "待补充地点"
        people_text = pick_from_text(people, unit, "待补充人物", index)
        product = pick_from_text(products, unit, "待补充产品", index)
        matched_prop = next((str(item).strip() for item in props if str(item).strip() and str(item).strip() in unit), "")
        prop_text = matched_prop or infer_prop_text(unit)
        time_text = pick_from_text(times, unit, "待补充时间段", index)
        focus = pick_from_text(selling_points, unit, "画面关系与情绪变化", index)
        shots.append(
            {
                "no": str(index + 1).zfill(2),
                "type": mock_shot_type(unit, index, len(units)),
                "content": unit,
                "shotSize": infer_mock_shot_size(unit, index, len(units)),
                "angle": infer_mock_angle(unit, index),
                "camera": infer_mock_camera(unit, index),
                "duration": f"{shot_duration}s",
                "people": people_text,
                "location": location,
                "props": prop_text,
                "product": product,
                "time": time_text,
                "dialogue": pick_from_text(dialogue, unit, "无台词", index) if include_dialogue and dialogue else "无台词",
                "narration": pick_from_text(narration, unit, "无旁白", index) if include_narration and narration else "无旁白",
                "focus": focus,
            }
        )
    look = recommend_visual_look(payload, analysis, script)
    return {
        "source": source,
        "shots": shots,
        "overallVisualStyle": look["overallVisualStyle"],
        "overallColorTone": look["overallColorTone"],
        "warning": "当前未配置真实模型，已使用后端本地演示拆分镜。",
    }


def build_prompt(payload):
    template = PROMPT_PATH.read_text(encoding="utf-8")
    project = payload.get("project") or {}
    analysis = payload.get("analysis") or {}
    script = str(payload.get("script") or "").strip()
    current_visual_style = explicit_visual_style(payload)
    current_color_tone = explicit_color_tone(payload)
    project_context = {
        **project,
        "projectStyleTags": tag_list(project.get("style"), 6),
        "overallVisualStyle": current_visual_style,
        "overallColorTone": current_color_tone,
        "tone": current_color_tone,
        "visualStyle": current_visual_style,
        "colorToneTags": tag_list(current_color_tone, 3),
        "visualStyleTags": tag_list(current_visual_style, 3),
        "boardStyle": payload.get("boardStyle") or "",
        "creativity": payload.get("creativity") or "",
        "creativityInstruction": creativity_label(payload.get("creativity")),
        "shotCount": payload.get("shotCount") or "由系统根据脚本和片长自由判断",
        "globalNotes": payload.get("globalNotes") or "",
        "includeDialogue": payload.get("includeDialogue") is not False,
        "includeNarration": payload.get("includeNarration") is not False,
    }
    return (
        template.replace("{{PROJECT_JSON}}", json.dumps(project_context, ensure_ascii=False, indent=2))
        .replace("{{ANALYSIS_JSON}}", json.dumps(analysis, ensure_ascii=False, indent=2))
        .replace("{{SCRIPT_TEXT}}", script)
    )


def build_analysis_prompt(payload):
    template = ANALYSIS_PROMPT_PATH.read_text(encoding="utf-8")
    project = payload.get("project") or {}
    project_context = {
        **project,
        "projectStyleTags": tag_list(project.get("style"), 6),
        "globalNotes": payload.get("globalNotes") or "",
        "shotCount": payload.get("shotCount") or "未指定",
        "creativity": payload.get("creativity") or "",
        "creativityInstruction": creativity_label(payload.get("creativity")),
    }
    script = str(payload.get("script") or "").strip()
    return (
        template.replace("{{PROJECT_JSON}}", json.dumps(project_context, ensure_ascii=False, indent=2))
        .replace("{{SCRIPT_TEXT}}", script)
    )


def extract_json(text):
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    if stripped.startswith("["):
        return json.loads(stripped)
    match = re.search(r"\{.*\}", stripped, re.S)
    if not match:
        array_match = re.search(r"\[.*\]", stripped, re.S)
        if array_match:
            return json.loads(array_match.group(0))
        raise ValueError("模型返回内容不是 JSON")
    return json.loads(match.group(0))


def shots_from_parsed(parsed):
    if isinstance(parsed, list):
        return parsed
    if not isinstance(parsed, dict):
        return []
    for key in ("shots", "storyboard", "storyboards", "shotList", "shot_list", "frames", "分镜", "分镜列表", "镜头", "镜头列表"):
        value = parsed.get(key)
        if isinstance(value, list):
            return value
    data = parsed.get("data")
    if isinstance(data, dict):
        return shots_from_parsed(data)
    return []


def look_tags_from_parsed(parsed):
    if not isinstance(parsed, dict):
        return {}
    visual_style = tag_text(
        pick(parsed, "overallVisualStyle", "visualStyle", "overallStyle", "styleTags", "整体视觉风格", "整体风格", default=[]),
        3,
    )
    tone = tag_text(
        pick(parsed, "overallColorTone", "overallTone", "tone", "colorTone", "colorToneTags", "toneTags", "整体色调", default=[]),
        3,
    )
    result = {}
    if visual_style:
        result["overallVisualStyle"] = visual_style
    if tone:
        result["overallColorTone"] = tone
    return result


def normalize_shots(raw_shots):
    normalized = []
    for index, raw in enumerate(raw_shots or []):
        if not isinstance(raw, dict):
            continue
        normalized.append(
            {
                "no": str(pick(raw, "no", "shotNo", "shot_no", "镜号", "序号", default=index + 1)).zfill(2),
                "type": as_text(pick(raw, "type", "title", "name", "镜头类型", "镜头名称", default="镜头"), "镜头"),
                "content": as_text(pick(raw, "content", "description", "visual", "画面内容", "画面", "镜头内容", default="请补充画面内容"), "请补充画面内容"),
                "shotSize": as_text(pick(raw, "shotSize", "shot_size", "size", "景别", default="中景"), "中景"),
                "angle": as_text(pick(raw, "angle", "viewpoint", "cameraAngle", "shotAngle", "拍摄角度", "角度", "视角", "机位角度", default="正面平视"), "正面平视"),
                "duration": as_text(pick(raw, "duration", "timeLength", "时长", default="3s"), "3s"),
                "camera": as_text(pick(raw, "camera", "movement", "cameraMove", "运镜", "镜头运动", default="固定镜头"), "固定镜头"),
                "people": as_text(pick(raw, "people", "characters", "person", "人物", "角色", default="待补充人物"), "待补充人物"),
                "location": as_text(pick(raw, "location", "scene", "place", "场景", "地点", default="待补充地点"), "待补充地点"),
                "props": as_text(pick(raw, "props", "objects", "items", "道具", default="待补充道具"), "待补充道具"),
                "product": as_text(pick(raw, "product", "products", "产品", default="待补充产品"), "待补充产品"),
                "time": as_text(pick(raw, "time", "timeOfDay", "时间段", default="待补充时间段"), "待补充时间段"),
                "dialogue": as_text(pick(raw, "dialogue", "lines", "台词", default="无台词"), "无台词"),
                "narration": as_text(pick(raw, "narration", "voiceover", "旁白", "口播", default="无旁白"), "无旁白"),
                "focus": as_text(pick(raw, "focus", "keyPoint", "画面重点", "重点", "创意意图", default="待补充"), "待补充"),
            }
        )
    if not normalized:
        raise ValueError("模型返回的 shots 为空")
    return normalized


def chat_completion_urls(api_base):
    base = api_base.rstrip("/")
    if base.endswith("/v1"):
        return [f"{base}/chat/completions"]
    return [f"{base}/v1/chat/completions", f"{base}/chat/completions"]


def image_generation_urls(api_base):
    base = api_base.rstrip("/")
    if base.endswith("/v1"):
        return [f"{base}/images/generations"]
    return [f"{base}/v1/images/generations", f"{base}/images/generations"]


def request_chat_completion(url, api_key, request_body):
    data = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ApiRequestError(exc.code, body, str(exc.reason)) from exc


def request_image_generation(url, api_key, request_body):
    data = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ApiRequestError(exc.code, body, str(exc.reason)) from exc


def post_chat_completion(api_base, api_key, request_body):
    last_error = None
    for url in chat_completion_urls(api_base):
        try:
            return request_chat_completion(url, api_key, request_body)
        except ApiRequestError as exc:
            last_error = exc
            if exc.code not in {404, 405} and "1010" not in exc.body:
                raise
        except urllib.error.URLError as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise ValueError("没有可用的 Chat Completions 地址")


def post_image_generation(api_base, api_key, request_body):
    last_error = None
    for url in image_generation_urls(api_base):
        try:
            return request_image_generation(url, api_key, request_body)
        except ApiRequestError as exc:
            last_error = exc
            if exc.code not in {404, 405} and "1010" not in exc.body:
                raise
        except urllib.error.URLError as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise ValueError("没有可用的 Images Generations 地址")


def http_error_message(exc):
    if isinstance(exc, ApiRequestError):
        body = re.sub(r"\s+", " ", exc.body or "").strip()
        if len(body) > 260:
            body = body[:260] + "..."
        return f"HTTP {exc.code}: {body or exc.reason}"
    try:
        body = exc.read().decode("utf-8", errors="replace")
    except Exception:
        body = ""
    body = re.sub(r"\s+", " ", body).strip()
    if len(body) > 260:
        body = body[:260] + "..."
    return f"HTTP {exc.code}: {body or exc.reason}"


def call_text_model_json(prompt, system_prompt, api_config):
    api_base = (api_config.get("apiBaseUrl") or "").rstrip("/")
    api_key = api_config.get("apiKey") or ""
    model = api_config.get("textModel") or ""
    temperature = float(api_config.get("temperature") or 0.7)
    if not api_base or not api_key or not model:
        raise ValueError("未配置真实文本模型")

    request_body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    try:
        response_body = post_chat_completion(api_base, api_key, request_body)
    except (urllib.error.HTTPError, ApiRequestError) as exc:
        if getattr(exc, "code", None) not in {400, 422}:
            raise ValueError(http_error_message(exc)) from exc
        request_body.pop("response_format", None)
        try:
            response_body = post_chat_completion(api_base, api_key, request_body)
        except (urllib.error.HTTPError, ApiRequestError) as retry_exc:
            raise ValueError(http_error_message(retry_exc)) from retry_exc
    content = response_body["choices"][0]["message"]["content"]
    return extract_json(content), model


def parse_project_aspect(aspect_value):
    text = str(aspect_value or "").strip()
    normalized = text.replace("：", ":").replace("×", "x").replace("X", "x")
    match = re.search(r"(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)", normalized)
    if match:
        width = float(match.group(1))
        height = float(match.group(2))
        if width > 0 and height > 0:
            return width, height, f"{match.group(1)}:{match.group(2)}"
    if any(word in text for word in ["竖屏", "竖版", "手机竖屏"]):
        return 9, 16, "9:16"
    if any(word in text for word in ["横屏", "横版", "宽屏"]):
        return 16, 9, "16:9"
    if any(word in text for word in ["方形", "正方形"]):
        return 1, 1, "1:1"
    return 16, 9, "16:9"


def image_size_for_aspect(aspect_value):
    width, height, _ = parse_project_aspect(aspect_value)
    ratio = width / height if height else 1
    if 0.92 <= ratio <= 1.08:
        return "1024x1024"
    if ratio > 1:
        target_width = min(1792, max(1024, int(round(1024 * ratio / 64) * 64)))
        return f"{target_width}x1024"
    target_height = min(1792, max(1024, int(round(1024 / ratio / 64) * 64)))
    return f"1024x{target_height}"


def image_prompt_for_shot(shot, payload, index):
    board_style = str(payload.get("boardStyle") or "写实版")
    is_realistic = board_style == "写实版"
    tone = tag_text(canonical_color_tone(payload), 3) if is_realistic else ""
    visual_style = tag_text(canonical_visual_style(payload), 3) if is_realistic else ""
    project = payload.get("project") or {}
    project_style = tag_text(project.get("style"), 3) if is_realistic else ""
    _, _, aspect_label = parse_project_aspect(project.get("aspect"))
    global_notes = str(payload.get("globalNotes") or "").strip()
    ref_meta = shot.get("refMeta") if isinstance(shot.get("refMeta"), dict) else {}
    if board_style == "线稿":
        style_line = "黑白分镜线稿，清晰线条，少量灰度阴影，广告分镜草图，主体和空间关系必须明确，不要彩色写实渲染。"
    elif board_style == "火柴人":
        style_line = "极简火柴人分镜草图，构图清晰，动作关系明确。"
    else:
        style_line = "写实广告分镜参考图，realistic cinematic storyboard frame，真实人物比例，自然光影，真实空间透视，电影感构图，不要卡通，不要火柴人，不要线稿，不要矢量图，不要抽象图标。"
    ref_line = ""
    if ref_meta:
        subject_x = ref_meta.get("subjectX", 0.5)
        subject_y = ref_meta.get("subjectY", 0.52)
        aspect = ref_meta.get("aspect", "")
        brightness = float(ref_meta.get("brightness", 0.62) or 0.62)
        warmth = float(ref_meta.get("warmth", 0.5) or 0.5)
        balance = ref_meta.get("balance", "center")
        horizontal = "画面左侧" if subject_x < 0.4 else "画面右侧" if subject_x > 0.6 else "画面中部"
        vertical = "偏上留白" if subject_y < 0.42 else "偏下主体" if subject_y > 0.62 else "中部主体"
        light_hint = "偏明亮" if brightness >= 0.58 else "偏低调"
        warm_hint = "偏暖" if warmth >= 0.56 else "偏冷" if warmth <= 0.44 else "中性色温"
        balance_hint = {"left": "左侧视觉重量更强", "right": "右侧视觉重量更强"}.get(balance, "左右视觉重量均衡")
        ref_line = (
            f"参考用户上传图片的构图关系：主体大致位于{horizontal}，{vertical}，画面比例约为{aspect or '常规横图'}，"
            f"{balance_hint}，整体{light_hint}、{warm_hint}。只借鉴构图、主体位置、画面层次和光线倾向；如果参考图比例与项目画幅冲突，必须以项目画幅 {aspect_label} 为准；必须重新绘制，"
            "不要复刻原图具体人物、脸、服装、背景、品牌和可识别细节。"
        )
    fields = {
        "镜号": shot.get("no") or str(index + 1).zfill(2),
        "画面内容": shot.get("content") or "",
        "景别": shot.get("shotSize") or "",
        "拍摄角度": shot.get("angle") or "",
        "运镜": shot.get("camera") or "",
        "人物": shot.get("people") or "",
        "场景": shot.get("location") or "",
        "道具": shot.get("props") or "",
        "产品": shot.get("product") or "",
        "时间段": shot.get("time") or "",
        "画面重点": shot.get("focus") or "",
        "项目画幅比例": aspect_label,
        "全局创作要求": global_notes,
    }
    if is_realistic:
        fields["项目风格"] = project_style or visual_style
        fields["整体视觉风格"] = visual_style
        fields["整体色调"] = tone
    field_text = "\n".join(f"{key}：{value}" for key, value in fields.items() if value)
    return (
        f"{style_line}\n"
        f"{ref_line}\n"
        f"请生成一张可用于广告/短视频前期沟通的分镜参考图，必须按照项目画幅比例 {aspect_label} 构图，不要默认使用 16:9，除非项目画幅本身就是 16:9。\n"
        f"{'整体视觉风格和整体色调只作用于当前写实版真实生图，请严格参考。' if is_realistic else '当前不是写实版真实生图，不要受整体色调或整体视觉风格标签限制，只保持草图清晰可读。'}\n"
        "必须直接表现当前镜头内容，不要生成文字说明页、不要 UI 截图、不要多宫格、不要水印、不要乱码文字。\n"
        "画面必须具体可读，不能只用符号、几何形状或抽象示意代替真实场景。\n"
        "如果出现人物，保持自然真实姿态；如果有道具，要能看出道具和人物关系。\n"
        f"{field_text}"
    ).strip()


def image_from_generation_response(response_body):
    data = response_body.get("data") if isinstance(response_body, dict) else None
    if isinstance(data, list) and data:
        item = data[0] or {}
        if item.get("b64_json"):
            return f"data:image/png;base64,{item['b64_json']}"
        if item.get("url"):
            return item["url"]
        if item.get("image"):
            image = str(item["image"])
            return image if image.startswith("data:image") else f"data:image/png;base64,{image}"
    for key in ("b64_json", "image", "url"):
        value = response_body.get(key) if isinstance(response_body, dict) else None
        if value:
            value = str(value)
            if key == "url" or value.startswith("data:image"):
                return value
            return f"data:image/png;base64,{value}"
    raise ValueError("图片模型没有返回可用图片")


def generate_storyboard_images(payload, user=None):
    api_config = user_api_config(user) if user else {"provider": "mock"}
    provider = (api_config.get("provider") or "mock").lower()
    api_base = (api_config.get("apiBaseUrl") or "").rstrip("/")
    api_key = api_config.get("apiKey") or ""
    image_model = api_config.get("imageModel") or ""
    if provider in {"mock", "local", "demo"} or not api_base or not api_key or not image_model:
        raise ValueError("未配置真实图片模型")

    shots = payload.get("shots") or []
    if not isinstance(shots, list) or not shots:
        raise ValueError("缺少要生成图片的分镜")

    project = payload.get("project") or {}
    image_size = image_size_for_aspect(project.get("aspect"))
    results = []
    for index, shot in enumerate(shots[:8]):
        if not isinstance(shot, dict):
            continue
        prompt = image_prompt_for_shot(shot, payload, index)
        request_body = {
            "model": image_model,
            "prompt": prompt,
            "n": 1,
            "size": image_size,
            "response_format": "b64_json",
        }
        try:
            response_body = post_image_generation(api_base, api_key, request_body)
        except (urllib.error.HTTPError, ApiRequestError) as exc:
            if getattr(exc, "code", None) not in {400, 422}:
                raise ValueError(http_error_message(exc)) from exc
            request_body.pop("response_format", None)
            try:
                response_body = post_image_generation(api_base, api_key, request_body)
            except (urllib.error.HTTPError, ApiRequestError) as retry_exc:
                if image_size == "1024x1024" or getattr(retry_exc, "code", None) not in {400, 422}:
                    raise ValueError(http_error_message(retry_exc)) from retry_exc
                request_body["size"] = "1024x1024"
                try:
                    response_body = post_image_generation(api_base, api_key, request_body)
                except (urllib.error.HTTPError, ApiRequestError) as final_exc:
                    raise ValueError(http_error_message(final_exc)) from final_exc
        results.append({
            "no": str(shot.get("no") or index + 1).zfill(2),
            "image": image_from_generation_response(response_body),
            "model": image_model,
            "source": "ai-image",
        })
    if not results:
        raise ValueError("没有生成任何分镜图")
    return {"source": "ai-image", "model": image_model, "images": results}


def normalize_analysis(raw_analysis):
    if isinstance(raw_analysis, dict) and isinstance(raw_analysis.get("analysis"), dict):
        raw_analysis = raw_analysis["analysis"]
    if not isinstance(raw_analysis, dict):
        raw_analysis = {}
    return {
        "people": as_list(pick(raw_analysis, "people", "characters", "persons", "人物", "角色", default=[])),
        "product": as_list(pick(raw_analysis, "product", "products", "service", "产品", "服务", "核心对象", default=[])),
        "locations": as_list(pick(raw_analysis, "locations", "scenes", "places", "场景", "地点", "空间", default=[])),
        "props": as_list(pick(raw_analysis, "props", "objects", "items", "道具", "画面元素", default=[])),
        "times": as_list(pick(raw_analysis, "times", "time", "timeOfDay", "时间段", "时间", default=[])),
        "sellingPoints": as_list(pick(raw_analysis, "sellingPoints", "selling_points", "benefits", "卖点", "表达重点", default=[])),
        "dialogue": as_list(pick(raw_analysis, "dialogue", "lines", "台词", default=[])),
        "narration": as_list(pick(raw_analysis, "narration", "voiceover", "旁白", "口播", default=[])),
    }


def call_script_analysis(payload, api_config):
    parsed, model = call_text_model_json(
        build_analysis_prompt(payload),
        "你是一个专业但克制的剧本信息抽取助手。必须只输出合法 JSON。",
        api_config,
    )
    analysis = normalize_analysis(parsed)
    if not any(analysis.values()):
        raise ValueError("模型返回的剧本分析为空")
    return {
        "source": "ai",
        "model": model,
        "analysis": analysis,
    }


def analyze_script(payload, user=None):
    api_config = user_api_config(user) if user else {"provider": "mock"}
    provider = (api_config.get("provider") or "mock").lower()
    if provider in {"mock", "local", "demo"}:
        return mock_analyze(payload)
    try:
        return call_script_analysis(payload, api_config)
    except (urllib.error.URLError, urllib.error.HTTPError, ApiRequestError, KeyError, ValueError, json.JSONDecodeError) as exc:
        fallback = mock_analyze(payload, source="mock-fallback")
        fallback["warning"] = f"真实模型剧本分析失败，已使用本地演示分析。原因：{exc}"
        return fallback


def call_openai_compatible(payload, api_config):
    parsed, model = call_text_model_json(
        build_prompt(payload),
        "你是一个专业但克制的广告分镜拆解助手。必须只输出合法 JSON。",
        api_config,
    )
    result = {
        "source": "ai",
        "model": model,
        "shots": normalize_shots(shots_from_parsed(parsed)),
    }
    result.update(look_tags_from_parsed(parsed))
    fallback_look = recommend_visual_look(payload, payload.get("analysis") or {}, str(payload.get("script") or ""))
    result.setdefault("overallVisualStyle", fallback_look["overallVisualStyle"])
    result.setdefault("overallColorTone", fallback_look["overallColorTone"])
    return result


def enforce_script_toggles(result, payload):
    if payload.get("includeDialogue") is False:
        for shot in result.get("shots", []):
            shot["dialogue"] = "无台词"
    if payload.get("includeNarration") is False:
        for shot in result.get("shots", []):
            shot["narration"] = "无旁白"
    return result


def split_storyboard(payload, user=None):
    api_config = user_api_config(user) if user else {"provider": "mock"}
    provider = (api_config.get("provider") or "mock").lower()
    if provider in {"mock", "local", "demo"}:
        return mock_split(payload)
    try:
        return enforce_script_toggles(call_openai_compatible(payload, api_config), payload)
    except (urllib.error.URLError, urllib.error.HTTPError, ApiRequestError, KeyError, ValueError, json.JSONDecodeError) as exc:
        fallback = mock_split(payload, source="mock-fallback")
        fallback["warning"] = f"真实模型调用失败，已使用本地演示结果。原因：{exc}"
        return enforce_script_toggles(fallback, payload)


def xml_clean(value):
    text = str(value or "")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    return xml_escape(text, {'"': "&quot;", "'": "&apos;"})


def export_text(value, fallback=""):
    if isinstance(value, list):
        return "、".join(unique(value)) or fallback
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value or "").strip() or fallback


def short_text(value, length=80):
    text = re.sub(r"\s+", " ", export_text(value)).strip()
    return text if len(text) <= length else text[: length - 1] + "…"


def safe_export_filename(payload, extension):
    project = payload.get("project") or {}
    name = export_text(project.get("name"), "AI分镜拆解助手导出")
    name = re.sub(r'[\\/:*?"<>|]+', "_", name).strip(" .") or "AI分镜拆解助手导出"
    return f"{name}_分镜交付.{extension}"


def export_project_rows(payload):
    project = payload.get("project") or {}
    return [
        ["项目名称", project.get("name")],
        ["项目类型", project.get("type")],
        ["项目时长", f"{project.get('duration') or ''} 秒".strip()],
        ["画幅比例", project.get("aspect")],
        ["项目风格", project.get("style")],
        ["目标平台", project.get("platform")],
        ["整体色调", canonical_color_tone(payload)],
        ["整体风格", canonical_visual_style(payload)],
        ["分镜图类型", payload.get("boardStyle")],
        ["创意强度", payload.get("creativityLabel") or payload.get("creativity")],
        ["指定镜头数量", payload.get("shotCount") or "由系统判断"],
        ["全局创作要求", payload.get("globalNotes")],
        ["导出说明", "本文件不包含用户 API Key 或平台级 API 配置。"],
    ]


def export_analysis_rows(payload):
    detected = payload.get("detected") or {}
    labels = [
        ("people", "人物"),
        ("locations", "场景"),
        ("props", "道具"),
        ("product", "产品"),
        ("times", "时间段"),
        ("sellingPoints", "卖点"),
        ("dialogue", "台词"),
        ("narration", "旁白"),
    ]
    return [["分析项", "识别结果"]] + [[label, export_text(detected.get(key), "未识别")] for key, label in labels]


def export_shot_headers():
    return [
        "镜号",
        "镜头类型",
        "画面内容",
        "景别",
        "角度",
        "运镜",
        "时长",
        "人物",
        "场景",
        "道具",
        "产品",
        "时间段",
        "台词",
        "旁白",
        "画面重点",
        "状态",
        "参考图",
        "分镜图记录",
        "备注",
    ]


def export_shot_rows(payload):
    rows = [export_shot_headers()]
    for shot in payload.get("shots") or []:
        if not isinstance(shot, dict):
            continue
        board_state = "已生成真实图片" if shot.get("hasBoardImage") else "本地草图/未生成真实图片"
        if shot.get("boardSource"):
            board_state += f"；来源：{shot.get('boardSource')}"
        if shot.get("boardModel"):
            board_state += f"；模型：{shot.get('boardModel')}"
        rows.append(
            [
                shot.get("no"),
                shot.get("type"),
                shot.get("content"),
                shot.get("shotSize"),
                shot.get("angle"),
                shot.get("camera"),
                shot.get("duration"),
                shot.get("people"),
                shot.get("location"),
                shot.get("props"),
                shot.get("product"),
                shot.get("time"),
                shot.get("dialogue"),
                shot.get("narration"),
                shot.get("focus"),
                shot.get("status"),
                shot.get("refName") or "未上传",
                board_state,
                shot.get("boardWarning") or "",
            ]
        )
    return rows


def col_name(index):
    name = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def xlsx_cell(row_index, col_index, value, style=None):
    ref = f"{col_name(col_index)}{row_index}"
    style_attr = f' s="{style}"' if style else ""
    text = xml_clean(export_text(value))
    return f'<c r="{ref}" t="inlineStr"{style_attr}><is><t xml:space="preserve">{text}</t></is></c>'


def xlsx_sheet_xml(rows, freeze_header=False):
    max_cols = max((len(row) for row in rows), default=1)
    cols = "".join(f'<col min="{i}" max="{i}" width="18" customWidth="1"/>' for i in range(1, max_cols + 1))
    sheet_view = '<sheetViews><sheetView workbookViewId="0">'
    if freeze_header:
        sheet_view += '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    sheet_view += "</sheetView></sheetViews>"
    row_xml = []
    for row_index, row in enumerate(rows, 1):
        cells = "".join(xlsx_cell(row_index, col_index, value, "1" if freeze_header and row_index == 1 else None) for col_index, value in enumerate(row, 1))
        row_xml.append(f'<row r="{row_index}">{cells}</row>')
    dimension = f'A1:{col_name(max_cols)}{max(len(rows), 1)}'
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<dimension ref="{dimension}"/>{sheet_view}{cols}<sheetData>{"".join(row_xml)}</sheetData>'
        "</worksheet>"
    )


def build_xlsx(payload):
    sheets = [
        ("项目信息", [["字段", "内容"]] + export_project_rows(payload)),
        ("标准分镜表", export_shot_rows(payload)),
        ("剧本分析", export_analysis_rows(payload)),
    ]
    workbook_sheets = "".join(f'<sheet name="{xml_clean(name)}" sheetId="{i}" r:id="rId{i}"/>' for i, (name, _) in enumerate(sheets, 1))
    workbook_rels = "".join(
        f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
        for i in range(1, len(sheets) + 1)
    )
    workbook_rels += '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    content_types = "".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, len(sheets) + 1)
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            f"{content_types}</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{workbook_sheets}</sheets></workbook>",
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{workbook_rels}</Relationships>",
        )
        zf.writestr(
            "xl/styles.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
            "</styleSheet>",
        )
        for index, (_, rows) in enumerate(sheets, 1):
            zf.writestr(f"xl/worksheets/sheet{index}.xml", xlsx_sheet_xml(rows, freeze_header=True))
    return buffer.getvalue()


def docx_text_run(text):
    parts = str(text or "").splitlines() or [""]
    body = []
    for index, part in enumerate(parts):
        if index:
            body.append("<w:br/>")
        body.append(f"<w:t xml:space=\"preserve\">{xml_clean(part)}</w:t>")
    return "".join(body)


def docx_paragraph(text, style=None):
    style_xml = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{style_xml}<w:r>{docx_text_run(text)}</w:r></w:p>"


def docx_table(rows):
    row_xml = []
    for row_index, row in enumerate(rows):
        cells = []
        for value in row:
            bold = "<w:rPr><w:b/></w:rPr>" if row_index == 0 else ""
            cells.append(
                "<w:tc><w:tcPr><w:tcW w:w=\"2400\" w:type=\"dxa\"/></w:tcPr>"
                f"<w:p><w:r>{bold}{docx_text_run(value)}</w:r></w:p></w:tc>"
            )
        row_xml.append(f"<w:tr>{''.join(cells)}</w:tr>")
    return (
        "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/>"
        '<w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="999999"/>'
        '<w:left w:val="single" w:sz="6" w:space="0" w:color="999999"/>'
        '<w:bottom w:val="single" w:sz="6" w:space="0" w:color="999999"/>'
        '<w:right w:val="single" w:sz="6" w:space="0" w:color="999999"/>'
        '<w:insideH w:val="single" w:sz="6" w:space="0" w:color="CCCCCC"/>'
        '<w:insideV w:val="single" w:sz="6" w:space="0" w:color="CCCCCC"/></w:tblBorders></w:tblPr>'
        f"{''.join(row_xml)}</w:tbl>"
    )


def build_docx(payload):
    project = payload.get("project") or {}
    body = [
        docx_paragraph(project.get("name") or "AI分镜拆解助手导出", "Title"),
        docx_paragraph("项目交付文档", "Subtitle"),
        docx_paragraph("项目信息", "Heading1"),
        docx_table([["字段", "内容"]] + export_project_rows(payload)),
        docx_paragraph("剧本分析", "Heading1"),
        docx_table(export_analysis_rows(payload)),
        docx_paragraph("标准分镜表", "Heading1"),
        docx_table(export_shot_rows(payload)),
        docx_paragraph("原始脚本", "Heading1"),
        docx_paragraph(payload.get("script") or "未填写脚本。"),
    ]
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(body)}"
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
        "</w:body></w:document>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:color w:val="666666"/><w:sz w:val="24"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>'
        "</w:styles>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            "</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        zf.writestr("word/document.xml", document_xml)
        zf.writestr("word/styles.xml", styles_xml)
        zf.writestr(
            "word/_rels/document.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            "</Relationships>",
        )
    return buffer.getvalue()


def ppt_paragraph(text, font_size=2200, bold=False):
    bold_attr = ' b="1"' if bold else ""
    return (
        "<a:p><a:r>"
        f'<a:rPr lang="zh-CN" sz="{font_size}"{bold_attr}/>'
        f"<a:t>{xml_clean(text)}</a:t>"
        "</a:r></a:p>"
    )


def ppt_text_box(shape_id, x, y, cx, cy, paragraphs):
    body = "".join(paragraphs)
    return (
        "<p:sp>"
        f'<p:nvSpPr><p:cNvPr id="{shape_id}" name="TextBox {shape_id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>{body}</p:txBody>'
        "</p:sp>"
    )


def ppt_slide_xml(title, lines, slide_index):
    shapes = [
        ppt_text_box(2, 620000, 420000, 10500000, 900000, [ppt_paragraph(title, 3200, True)]),
        ppt_text_box(3, 660000, 1420000, 10800000, 4800000, [ppt_paragraph(line, 1900, False) for line in lines]),
    ]
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        "<p:cSld><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        f"{''.join(shapes)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    )


def ppt_slides(payload):
    project = payload.get("project") or {}
    analysis = payload.get("detected") or {}
    shots = [shot for shot in (payload.get("shots") or []) if isinstance(shot, dict)]
    slides = [
        (
            project.get("name") or "AI分镜拆解助手导出",
            [
                "AI分镜拆解助手项目展示",
                f"类型：{export_text(project.get('type'), '未填写')}  时长：{export_text(project.get('duration'), '未填写')}秒",
                f"风格：{export_text(project.get('style'), '未填写')}  平台：{export_text(project.get('platform'), '未填写')}",
                "说明：导出文件不包含用户 API Key 或平台级 API 配置。",
            ],
        ),
        (
            "项目信息与创作要求",
            [f"{key}：{export_text(value, '未填写')}" for key, value in export_project_rows(payload)[:12]],
        ),
        (
            "剧本分析结果",
            [f"{label}：{export_text(analysis.get(key), '未识别')}" for key, label in [
                ("people", "人物"),
                ("locations", "场景"),
                ("props", "道具"),
                ("product", "产品"),
                ("times", "时间段"),
                ("sellingPoints", "卖点"),
            ]],
        ),
    ]
    overview = []
    for shot in shots[:6]:
        overview.append(f"{shot.get('no')} {short_text(shot.get('type'), 14)}：{short_text(shot.get('content'), 42)}")
    slides.append(("分镜概览", overview or ["暂无分镜数据。"]))
    for start in range(0, len(shots), 3):
        chunk = shots[start : start + 3]
        lines = []
        for shot in chunk:
            lines.extend(
                [
                    f"{shot.get('no')} {export_text(shot.get('type'), '镜头')}｜{export_text(shot.get('shotSize'), '景别')}｜{export_text(shot.get('angle'), '角度')}｜{export_text(shot.get('camera'), '运镜')}｜{export_text(shot.get('duration'), '时长')}",
                    f"画面：{short_text(shot.get('content'), 80)}",
                    f"人物/场景/道具：{short_text(shot.get('people'), 20)} / {short_text(shot.get('location'), 20)} / {short_text(shot.get('props'), 24)}",
                    "",
                ]
            )
        slides.append((f"分镜明细 {start + 1}-{start + len(chunk)}", lines))
    return slides[:12]


def build_pptx(payload):
    slides = ppt_slides(payload)
    slide_overrides = "".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, len(slides) + 1)
    )
    presentation_rels = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    presentation_rels += "".join(
        f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'
        for i in range(1, len(slides) + 1)
    )
    slide_ids = "".join(f'<p:sldId id="{255 + i}" r:id="rId{i + 1}"/>' for i in range(1, len(slides) + 1))
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
            '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
            '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
            '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
            f"{slide_overrides}</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "ppt/presentation.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
            f"<p:sldIdLst>{slide_ids}</p:sldIdLst>"
            '<p:sldSz cx="12192000" cy="6858000" type="wide"/><p:notesSz cx="6858000" cy="9144000"/>'
            "</p:presentation>",
        )
        zf.writestr(
            "ppt/_rels/presentation.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{presentation_rels}</Relationships>",
        )
        zf.writestr(
            "ppt/slideMasters/slideMaster1.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
            '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
            '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>',
        )
        zf.writestr(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "ppt/slideLayouts/slideLayout1.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">'
            '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
            '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
        )
        zf.writestr(
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "ppt/theme/theme1.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Storyboard Lab">'
            '<a:themeElements><a:clrScheme name="BlackWhite"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
            '<a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="F5F5F5"/></a:lt2>'
            '<a:accent1><a:srgbClr val="111111"/></a:accent1><a:accent2><a:srgbClr val="666666"/></a:accent2><a:accent3><a:srgbClr val="999999"/></a:accent3>'
            '<a:accent4><a:srgbClr val="DDDDDD"/></a:accent4><a:accent5><a:srgbClr val="000000"/></a:accent5><a:accent6><a:srgbClr val="444444"/></a:accent6>'
            '<a:hlink><a:srgbClr val="000000"/></a:hlink><a:folHlink><a:srgbClr val="666666"/></a:folHlink></a:clrScheme>'
            '<a:fontScheme name="Microsoft YaHei"><a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>'
            '<a:fmtScheme name="Default"><a:fillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst/><a:bgFillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
            "</a:themeElements></a:theme>",
        )
        zf.writestr(
            "docProps/core.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f"<dc:title>{xml_clean((payload.get('project') or {}).get('name') or 'AI分镜拆解助手导出')}</dc:title>"
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created></cp:coreProperties>',
        )
        zf.writestr(
            "docProps/app.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
            "<Application>AI分镜拆解助手</Application></Properties>",
        )
        for index, (title, lines) in enumerate(slides, 1):
            zf.writestr(f"ppt/slides/slide{index}.xml", ppt_slide_xml(title, lines, index))
    return buffer.getvalue()


def build_export_file(payload):
    fmt = str(payload.get("format") or "").lower().strip()
    if fmt in {"excel", "xlsx"}:
        return (
            build_xlsx(payload),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            safe_export_filename(payload, "xlsx"),
        )
    if fmt in {"word", "docx"}:
        return (
            build_docx(payload),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            safe_export_filename(payload, "docx"),
        )
    if fmt in {"ppt", "pptx"}:
        return (
            build_pptx(payload),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            safe_export_filename(payload, "pptx"),
        )
    raise ValueError("不支持的导出格式")


class StoryboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            user, _ = current_user(self)
            cfg = config_status(user)
            return json_response(
                self,
                200,
                {
                    "ok": True,
                    "provider": cfg["provider"],
                    "configured": cfg["textConfigured"],
                    "model": cfg["textModel"] if cfg["textConfigured"] else "",
                    "user": public_user(user),
                },
            )
        if path == "/api/auth/me":
            user, _ = current_user(self)
            return json_response(self, 200, {"user": public_user(user), "config": config_status(user)})
        if path == "/api/config":
            user, _ = current_user(self)
            return json_response(self, 200, config_status(user))
        if path == "/api/projects":
            try:
                user, store = require_user(self)
                return json_response(self, 200, {"projects": user_projects(store, user["id"])})
            except PermissionError as exc:
                return json_response(self, 401, {"error": str(exc), "projects": []})
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/api/auth/register":
            try:
                _, _, user = register_user(read_json_body(self))
                return json_response(
                    self,
                    200,
                    {"user": public_user(user), "config": config_status(None), "message": "注册成功，请使用用户名或邮箱登录。"},
                )
            except (ValueError, json.JSONDecodeError) as exc:
                return json_response(self, 400, {"error": str(exc)})
        if path == "/api/auth/login":
            try:
                _, sid, user = login_user(read_json_body(self))
                return json_response(self, 200, {"user": public_user(user), "config": config_status(user)}, {"Set-Cookie": session_cookie_header(sid)})
            except (ValueError, json.JSONDecodeError) as exc:
                return json_response(self, 400, {"error": str(exc)})
        if path == "/api/auth/logout":
            logout_user(self)
            return json_response(self, 200, {"ok": True}, {"Set-Cookie": session_cookie_header("", 0)})
        if path == "/api/config":
            try:
                user, store = require_user(self)
                status = save_config(read_json_body(self), user)
                save_store(store)
                return json_response(self, 200, status)
            except PermissionError as exc:
                return json_response(self, 401, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                return json_response(self, 400, {"error": str(exc)})
            except Exception as exc:
                return json_response(self, 500, {"error": f"配置保存失败：{exc}"})
        if path == "/api/projects":
            try:
                user, store = require_user(self)
                project = save_user_project(store, user, read_json_body(self))
                return json_response(self, 200, {"project": project})
            except PermissionError as exc:
                return json_response(self, 401, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                return json_response(self, 400, {"error": str(exc)})
        if path == "/api/export":
            try:
                require_user(self)
                body, content_type, filename = build_export_file(read_json_body(self))
                return binary_response(self, 200, body, content_type, filename)
            except PermissionError as exc:
                return json_response(self, 401, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                return json_response(self, 400, {"error": str(exc)})
            except Exception as exc:
                return json_response(self, 500, {"error": f"文件导出失败：{exc}"})
        if path == "/api/script/analyze":
            try:
                user, _ = require_user(self)
                payload = read_json_body(self)
                script = str(payload.get("script") or "").strip()
                if not script:
                    return json_response(self, 400, {"error": "脚本文案不能为空"})
                return json_response(self, 200, analyze_script(payload, user))
            except PermissionError as exc:
                return json_response(self, 401, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                return json_response(self, 400, {"error": str(exc)})
            except Exception as exc:
                return json_response(self, 500, {"error": f"剧本分析失败：{exc}"})
        if path == "/api/storyboard/images":
            try:
                user, _ = require_user(self)
                payload = read_json_body(self)
                return json_response(self, 200, generate_storyboard_images(payload, user))
            except PermissionError as exc:
                return json_response(self, 401, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                return json_response(self, 400, {"error": str(exc)})
            except Exception as exc:
                return json_response(self, 500, {"error": f"分镜图生成失败：{exc}"})
        if path != "/api/storyboard/split":
            return json_response(self, 404, {"error": "接口不存在"})
        try:
            user, _ = require_user(self)
            payload = read_json_body(self)
            script = str(payload.get("script") or "").strip()
            if not script:
                return json_response(self, 400, {"error": "脚本文案不能为空"})
            result = split_storyboard(payload, user)
            return json_response(self, 200, result)
        except PermissionError as exc:
            return json_response(self, 401, {"error": str(exc)})
        except (ValueError, json.JSONDecodeError) as exc:
            return json_response(self, 400, {"error": str(exc)})
        except Exception as exc:
            return json_response(self, 500, {"error": f"服务器处理失败：{exc}"})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/projects":
            return json_response(self, 404, {"error": "接口不存在"})
        try:
            user, store = require_user(self)
            project_id = urllib.parse.parse_qs(parsed.query).get("id", [""])[0]
            if not project_id:
                return json_response(self, 400, {"error": "缺少项目 ID"})
            delete_user_project(store, user, project_id)
            return json_response(self, 200, {"ok": True})
        except PermissionError as exc:
            return json_response(self, 401, {"error": str(exc)})


def main():
    load_env_file()
    configure_runtime_paths()
    init_db()
    parser = argparse.ArgumentParser(description="AI分镜拆解助手本地后端")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5176")))
    args = parser.parse_args()
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer((args.host, args.port), StoryboardHandler)
    print(f"AI分镜拆解助手已启动：http://{args.host}:{args.port}/", flush=True)
    print("AI_MODE=BYOK，未登录或未配置用户使用 mock 模式", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
