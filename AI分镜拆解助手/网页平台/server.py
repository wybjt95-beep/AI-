#!/usr/bin/env python3
import argparse
import base64
from contextlib import contextmanager
import hashlib
import hmac
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


def find_user(_store=None, user_id=None, email=None):
    normalized_email = str(email or "").strip().lower()
    if not user_id and not normalized_email:
        return None
    with db_connection() as conn:
        if user_id:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (str(user_id),)).fetchone()
        else:
            row = conn.execute("SELECT * FROM users WHERE email = ?", (normalized_email,)).fetchone()
    return row_to_user(row)


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
    sid = create_session(None, user)
    return None, sid, user


def login_user(payload):
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    user = find_user(email=email)
    if not user or not verify_password(password, user.get("salt", ""), user.get("passwordHash", "")):
        raise ValueError("邮箱或密码不正确")
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
            conn.executemany("DELETE FROM projects WHERE user_id = ? AND id = ?", [(user["id"], project_id) for project_id in stale_ids])
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
    return unique(re.split(r"[\n,，、;；]", str(value or "")))


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


def mock_analyze(payload, source="mock"):
    script = str(payload.get("script") or "")
    has = lambda word: word in script
    quoted = [match.group(1).strip() for match in re.finditer(r"[“\"『「]([^”\"』」]{2,80})[”\"』」]", script)]
    narration = [match.group(1).strip() for match in re.finditer(r"(?:旁白|口播|VO|字幕|文案)[：:]([^。！？!?；;\n]+)", script, re.I)]

    people_candidates = [
        "年轻上班族",
        "主人公",
        "主角",
        "用户",
        "顾客",
        "年轻女性",
        "年轻男性",
        "女性用户",
        "男性用户",
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
    location_candidates = ["办公楼前", "城市街道", "通勤路口", "城市道路", "路口", "办公室", "会议室", "家中", "客厅", "厨房", "门店", "商场", "校园", "公园", "地铁站", "室内", "户外"]
    prop_candidates = ["智能仪表", "车把", "启动键", "车轮", "头盔", "背包", "电量", "速度", "品牌口号", "手机", "电脑", "杯子", "海报", "包装", "屏幕", "早餐", "食物", "界面"]
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
    duration = int_duration(project)
    bank = storyboard_bank()
    base = max(1, duration // len(bank))
    remain = max(0, duration - base * len(bank))
    people = analysis.get("people") or []
    locations = analysis.get("locations") or []
    products = analysis.get("product") or []
    times = analysis.get("times") or []
    dialogue = analysis.get("dialogue") or []
    narration = analysis.get("narration") or []
    include_dialogue = bool(payload.get("includeDialogue"))
    include_narration = bool(payload.get("includeNarration"))

    shots = []
    for index, item in enumerate(bank):
        shot_duration = base + (1 if remain > 0 else 0)
        remain -= 1
        office_locations = [x for x in locations if "办公楼" in str(x)]
        location = office_locations[0] if index >= 6 and office_locations else (locations[0] if locations else "待补充地点")
        shots.append(
            {
                "no": str(index + 1).zfill(2),
                "type": item[0],
                "content": item[1],
                "shotSize": item[2],
                "camera": item[3],
                "duration": f"{shot_duration}s",
                "people": people[0] if people else "待补充人物",
                "location": location,
                "props": item[4],
                "product": products[0] if products else "待补充产品",
                "time": times[0] if times else "待补充时间段",
                "dialogue": dialogue[0] if include_dialogue and dialogue else "无台词",
                "narration": narration[0] if include_narration and narration else "无旁白",
                "focus": item[5],
            }
        )
    return {
        "source": source,
        "shots": shots,
        "warning": "当前未配置真实模型，已使用后端本地演示拆分镜。",
    }


def build_prompt(payload):
    template = PROMPT_PATH.read_text(encoding="utf-8")
    project = payload.get("project") or {}
    analysis = payload.get("analysis") or {}
    script = str(payload.get("script") or "").strip()
    project_context = {
        **project,
        "tone": payload.get("tone") or "",
        "visualStyle": payload.get("visualStyle") or "",
        "boardStyle": payload.get("boardStyle") or "",
        "creativity": payload.get("creativity") or "",
        "includeDialogue": bool(payload.get("includeDialogue")),
        "includeNarration": bool(payload.get("includeNarration")),
    }
    return (
        template.replace("{{PROJECT_JSON}}", json.dumps(project_context, ensure_ascii=False, indent=2))
        .replace("{{ANALYSIS_JSON}}", json.dumps(analysis, ensure_ascii=False, indent=2))
        .replace("{{SCRIPT_TEXT}}", script)
    )


def build_analysis_prompt(payload):
    template = ANALYSIS_PROMPT_PATH.read_text(encoding="utf-8")
    project = payload.get("project") or {}
    script = str(payload.get("script") or "").strip()
    return (
        template.replace("{{PROJECT_JSON}}", json.dumps(project, ensure_ascii=False, indent=2))
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
    return {
        "source": "ai",
        "model": model,
        "shots": normalize_shots(shots_from_parsed(parsed)),
    }


def enforce_script_toggles(result, payload):
    if not bool(payload.get("includeDialogue")):
        for shot in result.get("shots", []):
            shot["dialogue"] = "无台词"
    if not bool(payload.get("includeNarration")):
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
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'")
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
                _, sid, user = register_user(read_json_body(self))
                return json_response(self, 200, {"user": public_user(user), "config": config_status(user)}, {"Set-Cookie": session_cookie_header(sid)})
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
