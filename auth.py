#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""站点账号与会话层（纯标准库实现）

职责：
- 账号表 site_user：用户名 / 密码散列 / 角色 / 状态，**不提供注册接口**，只能由管理员创建
- 会话表 site_session：随机 token 只存 sha256，服务重启后登录态不丢
- 登录失败节流：同一用户名或同一 IP 连续失败 5 次，锁定 15 分钟
- Cookie：HttpOnly + Secure + SameSite=Lax，默认 7 天

命令行（部署时初始化管理员用）：
    python auth.py --create-admin <用户名> [--password <密码>] [--display 展示名]
    python auth.py --list
    python auth.py --reset-password <用户名> [--password <密码>]
    python auth.py --enable <用户名> | --disable <用户名>
    python auth.py --delete <用户名>

数据库路径：MARVIS_AUTH_DB > <Marvis User>/data/marvis-db/auth.db > 项目内 data/auth.db
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import sys
from base64 import b64decode, b64encode
from datetime import datetime, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

COOKIE_NAME = "mv_sid"
SESSION_DAYS = 7
PBKDF2_ROUNDS = 240_000
MAX_FAILURES = 5
LOCK_MINUTES = 15
MIN_PASSWORD_LEN = 8

ROLE_ADMIN = "admin"
ROLE_USER = "user"
ROLES = (ROLE_ADMIN, ROLE_USER)

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")


# --------------------------------------------------------------------------- #
# 数据库
# --------------------------------------------------------------------------- #

def resolve_auth_db() -> Path:
    """账号库路径：环境变量 > Marvis 用户目录下的 marvis-db > 项目内 data/。"""
    env = os.environ.get("MARVIS_AUTH_DB")
    if env and env.strip():
        return Path(env).expanduser()
    try:
        user_root = BASE_DIR.parents[3]
        if user_root.name and len(user_root.name) >= 8 and (user_root / "workspace").exists():
            return user_root / "data" / "marvis-db" / "auth.db"
    except IndexError:
        pass
    return BASE_DIR / "data" / "auth.db"


AUTH_DB = resolve_auth_db()

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS site_user (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL DEFAULT '',
        pass_hash     TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user',
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    TEXT NOT NULL,
        created_by    TEXT NOT NULL DEFAULT '',
        last_login_at TEXT NOT NULL DEFAULT '',
        password_changed_at TEXT NOT NULL DEFAULT ''
    )""",
    """CREATE TABLE IF NOT EXISTS site_session (
        token_hash   TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT '',
        ip           TEXT NOT NULL DEFAULT '',
        ua           TEXT NOT NULL DEFAULT ''
    )""",
    """CREATE TABLE IF NOT EXISTS login_attempt (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT NOT NULL DEFAULT '',
        ip         TEXT NOT NULL DEFAULT '',
        ok         INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )""",
    # 用户自助签发的 API 令牌：明文只在签发那一刻返回一次，库里只留 sha256。
    # 与浏览器会话（site_session）完全独立：会话 7 天过期，令牌长期有效直到用户吊销。
    """CREATE TABLE IF NOT EXISTS site_user_token (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        name         TEXT NOT NULL,
        token_prefix TEXT NOT NULL DEFAULT '',
        token_hash   TEXT NOT NULL UNIQUE,
        status       TEXT NOT NULL DEFAULT 'active',
        usage_count  INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_session_user ON site_session(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_session_expire ON site_session(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_attempt_time ON login_attempt(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_usertoken_user ON site_user_token(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_usertoken_hash ON site_user_token(token_hash)",
]

# 统一令牌协议：用户令牌固定 ak- 前缀，论坛 AI 账号令牌为 ak-ai-（更长，解析时先判 ak-ai-），
# 三者（ak- / ak-ai- / adm_）都只经 Authorization 传输，便于在日志里一眼认出令牌类型。
# 每个用户最多同时持有 5 枚有效令牌。
MAX_TOKENS_PER_USER = 5
USER_TOKEN_PREFIX = "ak-"
TOKEN_PREFIX_SHOW = 11          # 展示用前缀长度：ak- + 8 位随机段
MAX_TOKEN_NAME = 32


class AuthError(Exception):
    """带状态码与机器可读 code 的业务异常。"""

    def __init__(self, message: str, status: int = 400, code: str = "auth_error") -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def connect() -> sqlite3.Connection:
    AUTH_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(AUTH_DB, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> dict:
    conn = connect()
    try:
        for sql in SCHEMA:
            conn.execute(sql)
        conn.commit()
        purge_expired(conn)
        total = conn.execute("SELECT COUNT(*) FROM site_user").fetchone()[0]
        admins = conn.execute("SELECT COUNT(*) FROM site_user WHERE role='admin' AND status='active'").fetchone()[0]
        return {"db": str(AUTH_DB), "users": total, "admins": admins}
    finally:
        conn.close()


def now_str() -> str:
    return datetime.now().isoformat(timespec="seconds")


def purge_expired(conn) -> None:
    conn.execute("DELETE FROM site_session WHERE expires_at < ?", (now_str(),))
    conn.execute(
        "DELETE FROM login_attempt WHERE created_at < ?",
        ((datetime.now() - timedelta(days=1)).isoformat(timespec="seconds"),),
    )
    conn.commit()


# --------------------------------------------------------------------------- #
# 密码
# --------------------------------------------------------------------------- #

def hash_password(password: str) -> str:
    """pbkdf2_hmac(sha256, 240k) + 16 字节随机盐，格式：pbkdf2_sha256$轮数$盐$散列。"""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ROUNDS,
        b64encode(salt).decode("ascii"),
        b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_b64, hash_b64 = (stored or "").split("$")
        if algo != "pbkdf2_sha256":
            return False
        salt = b64decode(salt_b64)
        expected = b64decode(hash_b64)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(rounds))
        return hmac.compare_digest(digest, expected)
    except (ValueError, TypeError):
        return False


def check_password_strength(password: str) -> None:
    if not password or len(password) < MIN_PASSWORD_LEN:
        raise AuthError(f"密码至少 {MIN_PASSWORD_LEN} 位", 400, "weak_password")
    if len(password) > 128:
        raise AuthError("密码过长（上限 128 位）", 400, "weak_password")
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        raise AuthError("密码需同时包含字母和数字", 400, "weak_password")


def normalize_username(raw) -> str:
    username = ("" if raw is None else str(raw)).strip()
    if not USERNAME_RE.match(username):
        raise AuthError("用户名只能是 3-32 位字母、数字、下划线、点或短横线", 400, "invalid_username")
    return username


# --------------------------------------------------------------------------- #
# 账号
# --------------------------------------------------------------------------- #

def user_out(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"] or row["username"],
        "role": row["role"],
        "status": row["status"],
        "created_at": row["created_at"],
        "created_by": row["created_by"],
        "last_login_at": row["last_login_at"],
    }


def get_user_by_name(conn, username: str):
    return conn.execute("SELECT * FROM site_user WHERE username = ? COLLATE NOCASE", (username,)).fetchone()


def create_user(username, password, role: str = ROLE_USER, display_name: str = "", created_by: str = "") -> dict:
    username = normalize_username(username)
    if role not in ROLES:
        raise AuthError("role 只能是 admin 或 user", 400, "invalid_role")
    check_password_strength(password)
    conn = connect()
    try:
        if get_user_by_name(conn, username):
            raise AuthError("用户名已存在", 409, "username_taken")
        conn.execute(
            """INSERT INTO site_user
               (username, display_name, pass_hash, role, status, created_at, created_by, password_changed_at)
               VALUES (?, ?, ?, ?, 'active', ?, ?, ?)""",
            (username, (display_name or username).strip()[:40], hash_password(password),
             role, now_str(), created_by, now_str()),
        )
        conn.commit()
        return user_out(get_user_by_name(conn, username))
    finally:
        conn.close()


def list_users() -> list[dict]:
    conn = connect()
    try:
        return [user_out(r) for r in conn.execute(
            "SELECT * FROM site_user ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, id")]
    finally:
        conn.close()


def reset_password(user_id: int, password: str) -> dict:
    check_password_strength(password)
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM site_user WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise AuthError("账号不存在", 404, "not_found")
        conn.execute(
            "UPDATE site_user SET pass_hash = ?, password_changed_at = ? WHERE id = ?",
            (hash_password(password), now_str(), user_id),
        )
        # 改密后踢掉该账号所有会话
        conn.execute("DELETE FROM site_session WHERE user_id = ?", (user_id,))
        conn.commit()
        return user_out(conn.execute("SELECT * FROM site_user WHERE id = ?", (user_id,)).fetchone())
    finally:
        conn.close()


def set_status(user_id: int, status: str) -> dict:
    if status not in ("active", "disabled"):
        raise AuthError("status 只能是 active 或 disabled", 400, "invalid_status")
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM site_user WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise AuthError("账号不存在", 404, "not_found")
        if status == "disabled" and row["role"] == ROLE_ADMIN:
            remain = conn.execute(
                "SELECT COUNT(*) FROM site_user WHERE role='admin' AND status='active' AND id <> ?",
                (user_id,)).fetchone()[0]
            if remain == 0:
                raise AuthError("不能停用最后一个管理员账号", 400, "last_admin")
        conn.execute("UPDATE site_user SET status = ? WHERE id = ?", (status, user_id))
        if status == "disabled":
            conn.execute("DELETE FROM site_session WHERE user_id = ?", (user_id,))
        conn.commit()
        return user_out(conn.execute("SELECT * FROM site_user WHERE id = ?", (user_id,)).fetchone())
    finally:
        conn.close()


def delete_user(user_id: int) -> dict:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM site_user WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise AuthError("账号不存在", 404, "not_found")
        if row["role"] == ROLE_ADMIN:
            remain = conn.execute(
                "SELECT COUNT(*) FROM site_user WHERE role='admin' AND status='active' AND id <> ?",
                (user_id,)).fetchone()[0]
            if remain == 0:
                raise AuthError("不能删除最后一个管理员账号", 400, "last_admin")
        conn.execute("DELETE FROM site_session WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM site_user WHERE id = ?", (user_id,))
        conn.commit()
        return {"id": user_id, "username": row["username"], "deleted": True}
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# 会话
# --------------------------------------------------------------------------- #

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _too_many_failures(conn, username: str, ip: str) -> bool:
    since = (datetime.now() - timedelta(minutes=LOCK_MINUTES)).isoformat(timespec="seconds")
    row = conn.execute(
        """SELECT COUNT(*) FROM login_attempt
           WHERE ok = 0 AND created_at >= ? AND (username = ? COLLATE NOCASE OR (ip <> '' AND ip = ?))""",
        (since, username, ip),
    ).fetchone()
    return bool(row and row[0] >= MAX_FAILURES)


def _record_attempt(conn, username: str, ip: str, ok: bool) -> None:
    conn.execute(
        "INSERT INTO login_attempt (username, ip, ok, created_at) VALUES (?, ?, ?, ?)",
        (username, ip, 1 if ok else 0, now_str()),
    )
    conn.commit()


def login(username: str, password: str, ip: str = "", ua: str = "") -> tuple[str, dict]:
    username = (username or "").strip()
    conn = connect()
    try:
        if _too_many_failures(conn, username, ip):
            raise AuthError(f"失败次数过多，请 {LOCK_MINUTES} 分钟后再试", 429, "too_many_attempts")
        row = get_user_by_name(conn, username)
        if not row or not verify_password(password or "", row["pass_hash"]):
            _record_attempt(conn, username, ip, False)
            raise AuthError("用户名或密码不正确", 401, "bad_credentials")
        if row["status"] != "active":
            _record_attempt(conn, username, ip, False)
            raise AuthError("账号已停用，请联系管理员", 403, "account_disabled")
        _record_attempt(conn, username, ip, True)

        token = secrets.token_urlsafe(32)
        expires = (datetime.now() + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds")
        conn.execute(
            """INSERT INTO site_session (token_hash, user_id, created_at, expires_at, last_seen_at, ip, ua)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (_token_hash(token), row["id"], now_str(), expires, now_str(), ip[:64], (ua or "")[:200]),
        )
        conn.execute("UPDATE site_user SET last_login_at = ? WHERE id = ?", (now_str(), row["id"]))
        conn.commit()
        return token, user_out(row)
    finally:
        conn.close()


def logout(token: str) -> None:
    if not token:
        return
    conn = connect()
    try:
        conn.execute("DELETE FROM site_session WHERE token_hash = ?", (_token_hash(token),))
        conn.commit()
    finally:
        conn.close()


def session_user(token: str) -> dict | None:
    if not token:
        return None
    conn = connect()
    try:
        row = conn.execute(
            """SELECT u.* FROM site_session s JOIN site_user u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.expires_at >= ? AND u.status = 'active'""",
            (_token_hash(token), now_str()),
        ).fetchone()
        if not row:
            return None
        conn.execute("UPDATE site_session SET last_seen_at = ? WHERE token_hash = ?",
                     (now_str(), _token_hash(token)))
        conn.commit()
        return user_out(row)
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# 请求侧辅助（供 server.py / forum.py 调用）
# --------------------------------------------------------------------------- #

def parse_cookies(handler) -> dict:
    raw = handler.headers.get("Cookie") or ""
    jar = {}
    for part in raw.split(";"):
        if "=" not in part:
            continue
        key, _, value = part.partition("=")
        jar[key.strip()] = value.strip()
    return jar


def session_token(handler) -> str:
    return parse_cookies(handler).get(COOKIE_NAME, "")


def bearer_token(handler) -> str:
    """读取 Authorization 里的明文令牌：兼容「Bearer xxx」「bearer xxx」「xxx」三种写法。

    统一令牌协议下这是令牌的唯一传输通道；不再读取 X-API-Key / X-Admin-Token /
    X-User-Token 等指向性 header。返回去掉首尾空白后的明文，没带则返回空串。
    """
    raw = (handler.headers.get("Authorization") or "").strip()
    if not raw:
        return ""
    parts = raw.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return raw


def current_user(handler) -> dict | None:
    """带一次请求内缓存，避免同一请求多次查库。"""
    cached = getattr(handler, "_auth_user", "unset")
    if cached != "unset":
        return cached
    user = session_user(session_token(handler))
    handler._auth_user = user
    return user


def require_user(handler) -> dict:
    user = current_user(handler)
    if not user:
        raise AuthError("请先登录", 401, "login_required")
    return user


def require_admin_user(handler) -> dict:
    """管理员校验：Cookie 会话优先，没有会话时读 Authorization 令牌。

    两条路完全等价——Cookie 会话或 Authorization 令牌（任一前缀，经 user_by_token 解析）
    只要解析出的站点用户 role == 'admin' 且 status == 'active' 就放行；
    非管理员 403 admin_required，令牌无效 401 invalid_token，完全没凭据 401 login_required。
    与 forum.require_admin 同一口径，不再是「管理接口只能 Cookie」。
    """
    user = current_user(handler)
    if not user:
        raw = bearer_token(handler)
        if not raw:
            raise AuthError("请先登录，或携带管理员 Authorization 令牌", 401, "login_required")
        user = user_by_token(raw)
        if not user:
            raise AuthError("访问令牌无效或已过期", 401, "invalid_token")
    if user["role"] != ROLE_ADMIN or user.get("status") != "active":
        raise AuthError("需要管理员权限", 403, "admin_required")
    return user


# --------------------------------------------------------------------------- #
# 用户自助令牌（site_user_token）
# --------------------------------------------------------------------------- #

def token_out(row, reveal: str = "") -> dict:
    """令牌对外视图：只给前缀，永不回显散列；明文仅在签发时通过 reveal 带出一次。"""
    item = {
        "id": row["id"],
        "name": row["name"],
        "prefix": row["token_prefix"],
        "status": row["status"],
        "usage_count": row["usage_count"],
        "last_used_at": row["last_used_at"] or "",
        "created_at": row["created_at"],
    }
    if reveal:
        item["token"] = reveal
    return item


def list_user_tokens(user_id: int) -> dict:
    """某用户的全部令牌（含已吊销），按创建时间倒序，附带配额。"""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM site_user_token WHERE user_id = ? ORDER BY id DESC", (user_id,)
        ).fetchall()
        active = sum(1 for r in rows if r["status"] == "active")
        return {
            "items": [token_out(r) for r in rows],
            "total": len(rows),
            "active": active,
            "limit": MAX_TOKENS_PER_USER,
            "left": max(MAX_TOKENS_PER_USER - active, 0),
        }
    finally:
        conn.close()


def create_user_token(user_id: int, name: str) -> tuple[dict, str]:
    """签发一枚用户令牌，返回 (视图, 明文)。明文只在此刻存在内存里，库里只存 sha256。"""
    label = (name or "").strip()
    if not label:
        raise AuthError("请给令牌起个名字，便于日后识别", 400, "invalid_token_name")
    if len(label) > MAX_TOKEN_NAME:
        raise AuthError(f"令牌名不超过 {MAX_TOKEN_NAME} 个字符", 400, "invalid_token_name")
    conn = connect()
    try:
        active = conn.execute(
            "SELECT COUNT(*) FROM site_user_token WHERE user_id = ? AND status = 'active'", (user_id,)
        ).fetchone()[0]
        if active >= MAX_TOKENS_PER_USER:
            raise AuthError(
                f"最多同时持有 {MAX_TOKENS_PER_USER} 枚有效令牌，请先吊销不用的",
                409,
                "token_quota_exceeded",
            )
        dup = conn.execute(
            "SELECT 1 FROM site_user_token WHERE user_id = ? AND name = ? AND status = 'active'",
            (user_id, label),
        ).fetchone()
        if dup:
            raise AuthError("同名令牌已存在，换个名字", 409, "token_name_taken")
        raw = USER_TOKEN_PREFIX + secrets.token_urlsafe(32)
        while conn.execute("SELECT 1 FROM site_user_token WHERE token_hash = ?",
                           (_token_hash(raw),)).fetchone():
            raw = USER_TOKEN_PREFIX + secrets.token_urlsafe(32)
        conn.execute(
            """INSERT INTO site_user_token
               (user_id, name, token_prefix, token_hash, status, created_at)
               VALUES (?, ?, ?, ?, 'active', ?)""",
            (user_id, label, raw[:TOKEN_PREFIX_SHOW], _token_hash(raw), now_str()),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM site_user_token WHERE token_hash = ?", (_token_hash(raw),)
        ).fetchone()
        return token_out(row, reveal=raw), raw
    finally:
        conn.close()


def revoke_user_token(user_id: int, token_id: int) -> dict:
    """吊销自己名下的一枚令牌；别人的令牌一律按不存在处理，不泄露存在性。"""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT id, status FROM site_user_token WHERE id = ? AND user_id = ?", (token_id, user_id)
        ).fetchone()
        if not row:
            raise AuthError("令牌不存在", 404, "not_found")
        if row["status"] == "active":
            conn.execute("UPDATE site_user_token SET status = 'revoked' WHERE id = ?", (token_id,))
            conn.commit()
        return {"id": token_id, "status": "revoked"}
    finally:
        conn.close()


def user_by_token(raw: str) -> dict | None:
    """用明文令牌换取用户，并累加调用次数（服务器侧统计口径）。无效/吊销/账号停用一律 None。"""
    token = (raw or "").strip()
    if not token:
        return None
    conn = connect()
    try:
        row = conn.execute(
            """SELECT t.id AS token_id, u.* FROM site_user_token t JOIN site_user u ON u.id = t.user_id
               WHERE t.token_hash = ? AND t.status = 'active' AND u.status = 'active'""",
            (_token_hash(token),),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE site_user_token SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?",
            (now_str(), row["token_id"]),
        )
        conn.commit()
        return user_out(row)
    finally:
        conn.close()


def first_admin_user() -> dict | None:
    """库里第一个启用的管理员账号（统一令牌协议下「管理员令牌属于谁」的唯一依据）。

    只按 role/status 查库，不接受硬编码用户名或 id；查不到返回 None。
    """
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM site_user WHERE role = ? AND status = 'active' ORDER BY id LIMIT 1",
            (ROLE_ADMIN,),
        ).fetchone()
        return user_out(row) if row is not None else None
    finally:
        conn.close()


def register_user_token_raw(raw: str, user_id: int, name: str) -> dict:
    """把一枚已在别处落盘的明文令牌登记进 site_user_token（幂等，不复活已吊销记录）。

    用途：统一令牌协议取消了「adm_ 静态令牌」这条绕过登记表的鉴权特例，论坛首次启动
    自动生成的 forum_admin.key 必须作为 admin 名下的一枚普通用户令牌登记，否则它走
    user_by_token 会直接 401。明文只在这里被 sha256 后入库，不写日志、不回显。

    返回 {"created": bool, "reason": str, "id": int | None, "status": str}
      reason=created / exists_active（已登记且启用，幂等跳过）/ exists_revoked（已吊销，
      保持吊销不复活）/ bad_token（明文为空或过长）/ no_user（账号不存在或不启用）
    """
    token = (raw or "").strip()
    if not token or len(token) > 200:
        return {"created": False, "reason": "bad_token", "id": None, "status": ""}
    label = (name or "server-token")[:MAX_TOKEN_NAME]
    conn = connect()
    try:
        owner = conn.execute(
            "SELECT id FROM site_user WHERE id = ? AND status = 'active'", (user_id,)
        ).fetchone()
        if not owner:
            return {"created": False, "reason": "no_user", "id": None, "status": ""}
        existing = conn.execute(
            "SELECT id, status FROM site_user_token WHERE token_hash = ?", (_token_hash(token),)
        ).fetchone()
        if existing:
            reason = "exists_active" if existing["status"] == "active" else "exists_revoked"
            return {"created": False, "reason": reason,
                    "id": existing["id"], "status": existing["status"]}
        conn.execute(
            """INSERT INTO site_user_token
               (user_id, name, token_prefix, token_hash, status, created_at)
               VALUES (?, ?, ?, ?, 'active', ?)""",
            (user_id, label, token[:TOKEN_PREFIX_SHOW], _token_hash(token), now_str()),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, status FROM site_user_token WHERE token_hash = ?", (_token_hash(token),)
        ).fetchone()
        return {"created": True, "reason": "created", "id": row["id"], "status": row["status"]}
    finally:
        conn.close()


def build_cookie(token: str, max_age: int = SESSION_DAYS * 86400) -> str:
    # Secure 由调用方按部署形态决定（HTTPS 必带）
    return (f"{COOKIE_NAME}={token}; Path=/; Max-Age={max_age}; HttpOnly; "
            "SameSite=Lax")


def build_cookie_secure(token: str, secure: bool = True, max_age: int = SESSION_DAYS * 86400) -> str:
    parts = [f"{COOKIE_NAME}={token}", "Path=/", f"Max-Age={max_age}", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie(secure: bool = True) -> str:
    parts = [f"{COOKIE_NAME}=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def client_ip(handler) -> str:
    """真实客户端 IP：仅当显式信任反代时才读 X-Forwarded-For。"""
    trust_proxy = os.environ.get("MARVIS_TRUST_PROXY", "") in ("1", "true", "yes")
    peer = (handler.client_address[0] if handler.client_address else "") or ""
    if trust_proxy and peer in ("127.0.0.1", "::1", "::ffff:127.0.0.1", ""):
        xff = (handler.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if xff:
            return xff[:64]
        real = (handler.headers.get("X-Real-IP") or "").strip()
        if real:
            return real[:64]
    return peer


# --------------------------------------------------------------------------- #
# 命令行
# --------------------------------------------------------------------------- #

def _cli() -> int:
    ap = argparse.ArgumentParser(description="站点账号管理")
    ap.add_argument("--create-admin", metavar="USERNAME")
    ap.add_argument("--create-user", metavar="USERNAME")
    ap.add_argument("--reset-password", metavar="USERNAME")
    ap.add_argument("--enable", metavar="USERNAME")
    ap.add_argument("--disable", metavar="USERNAME")
    ap.add_argument("--delete", metavar="USERNAME")
    ap.add_argument("--password")
    ap.add_argument("--display", default="")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    info = init_db()
    print(f"[OK] 账号库：{info['db']}；共 {info['users']} 个账号，管理员 {info['admins']} 个", flush=True)

    if args.list:
        for u in list_users():
            print(f"  #{u['id']:<3} {u['username']:<20} {u['role']:<6} {u['status']:<9} "
                  f"{u['display_name']:<16} 最近登录 {u['last_login_at'] or '-'}")
        return 0

    def _pwd() -> str:
        if args.password:
            return args.password
        p1 = getpass.getpass("密码：")
        p2 = getpass.getpass("再输一次：")
        if p1 != p2:
            print("[ERR] 两次输入不一致", file=sys.stderr)
            raise SystemExit(2)
        return p1

    try:
        if args.create_admin or args.create_user:
            role = ROLE_ADMIN if args.create_admin else ROLE_USER
            name = args.create_admin or args.create_user
            u = create_user(name, _pwd(), role=role, display_name=args.display or name, created_by="cli")
            print(f"[OK] 已创建 {u['role']} 账号：{u['username']}（id={u['id']}）")
        if args.reset_password:
            conn = connect()
            try:
                row = get_user_by_name(conn, args.reset_password)
            finally:
                conn.close()
            if not row:
                print("[ERR] 账号不存在", file=sys.stderr)
                return 1
            u = reset_password(row["id"], _pwd())
            print(f"[OK] 已重置密码：{u['username']}，该账号原有会话已全部失效")
        if args.enable or args.disable:
            name = args.enable or args.disable
            conn = connect()
            try:
                row = get_user_by_name(conn, name)
            finally:
                conn.close()
            if not row:
                print("[ERR] 账号不存在", file=sys.stderr)
                return 1
            u = set_status(row["id"], "active" if args.enable else "disabled")
            print(f"[OK] {u['username']} 当前状态：{u['status']}")
        if args.delete:
            conn = connect()
            try:
                row = get_user_by_name(conn, args.delete)
            finally:
                conn.close()
            if not row:
                print("[ERR] 账号不存在", file=sys.stderr)
                return 1
            delete_user(row["id"])
            print(f"[OK] 已删除账号：{row['username']}")
    except AuthError as e:
        print(f"[ERR] {e.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
