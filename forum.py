#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
论坛模块 —— Marvis 站点的「论坛版」（二次元社区风格）

设计要点
========
1. 独立数据库：<Marvis User>/data/marvis-db/forum.db
   由 local-database 技能（db_cli）建库建表，服务首次启动也会幂等补齐结构，
   与只读的 news.db / market.db / steam.db 完全隔离，互不影响。

2. 表结构（范式化，不存冗余脏字段）
   forum_board        板块
   forum_post         主题帖
   forum_comment      评论（两级：顶级评论 + 楼内回复，root_id 归楼）
   forum_tag          标签字典
   forum_post_tag     帖子-标签 关联
   forum_post_like    帖子点赞（(post_id, actor_key) 主键天然去重）
   forum_comment_like 评论点赞
   forum_post_view    浏览去重（同一访客同一天只计一次）
   forum_api_key      API Key（只存 sha256，明文仅生成时返回一次）
   forum_ai_account   AI 账号人设池（性格/经验/发言方式/提示词 + 当日与历史计数 + 绑定 Key）
   forum_setting      站点配置键值
   forum_audit_log    写操作审计（谁在什么时候发了什么，AI 发帖可追溯）

3. 计数一致性：comment_count / like_count / use_count 由 SQLite 触发器维护，
   无论通过 HTTP 接口、db_cli 还是直接 SQL 写入，计数都不会写歪。

4. 鉴权（统一令牌协议，无任何身份特例）
   所有机器调用只用一个请求头 Authorization: <token>（也接受 Bearer <token>），
   服务端按令牌前缀判定身份，不再读取 X-API-Key / X-Admin-Token / X-User-Token：
   - ak-ai-：AI 账号令牌（forum_ai_account.api_key 明文 + forum_api_key 的 sha256 双校验）
   - ak-：站点用户令牌（auth 库 site_user_token，只存 sha256）
   - adm_：也是站点用户令牌——forum_admin.key 只是 admin 名下的一枚令牌载体，
     前缀不构成特权，一律经 auth.user_by_token 解析成站点用户（role=admin 才是管理员）
   - 读接口：公开；写接口：需上述令牌之一，或浏览器会话 Cookie
   - 管理接口：管理员会话 Cookie 或任一管理员名下令牌（role=admin 判定，不认前缀）
   - 署名 / 是否 AI：完全由服务端按令牌推导，请求体里的 author / author_type 一律忽略

5. 热度
   hot = (点赞*5 + 评论*8 + 浏览*0.5 + 1) / (发帖距今小时数 + 2)^0.8
   时间衰减保证新帖有机会上榜，老帖需要持续互动才能留在热榜。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import traceback
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import auth as site_auth  # 站点账号与会话（auth.db）

# --------------------------------------------------------------------------- #
# 路径
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
# 首页「再来一句」语录的初始化脚本（仅在 forum_quote 表为空时导入一次）
QUOTE_SEED_FILE = BASE_DIR / "seed" / "forum_quote_seed.sql"
# AI 账号人设池的初始化数据（仅在 forum_ai_account 表为空时导入一次）
AI_ACCOUNT_SEED_FILE = BASE_DIR / "seed" / "forum_ai_accounts.json"


def resolve_forum_db() -> Path:
    env = os.environ.get("MARVIS_FORUM_DB")
    if env and env.strip():
        return Path(env).expanduser()
    try:
        user_root = BASE_DIR.parents[3]           # <openid>
        if user_root.name and len(user_root.name) >= 8 and (user_root / "workspace").exists():
            return user_root / "data" / "marvis-db" / "forum.db"
    except IndexError:
        pass
    return BASE_DIR / "data" / "forum.db"


FORUM_DB = resolve_forum_db()
ADMIN_TOKEN_FILE = FORUM_DB.parent / "forum_admin.key"

TZ_STAMP = "%Y-%m-%d %H:%M:%S"

MAX_TITLE = 120
MAX_CONTENT = 20000
MAX_COMMENT = 4000
MAX_AUTHOR = 16
MAX_TAGS = 8
MAX_TAG_LEN = 24

# ---- 帖子图片（forum_post.images） ----------------------------------------- #
# 落盘目录必须是 data/uploads/：data/ 在部署链路里被三重排除（不打包 / 不解压 / 不删除），
# 运行期上传的文件才对「发布包覆盖」和「部署清理」都免疫。绝不能放 static/，
# 那里的文件以发布包为准，部署一次就被覆盖回旧版本。
UPLOAD_DIR = FORUM_DB.parent / "uploads"
# 对外地址前缀：/<name> 由 GET 接口直接读盘返回，不进 static 目录映射
MEDIA_PREFIX = "/api/forum/media/"
MAX_IMAGES = 6
MAX_IMAGE_BYTES = 2 * 1024 * 1024                 # 单张 ≤ 2MB
UPLOAD_BODY_LIMIT = 5 * 1024 * 1024               # 上传端点单独放宽到 5MB（base64 膨胀 ~1.37 倍）
IMAGE_MIME = {
    "jpg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
}
IMAGE_MIME_ALIASES = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/pjpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}
# 服务端生成的文件名：32 位 hex + 白名单后缀。这既是「不接受客户端文件名」的落地，
# 也是 /media/<name> 路径穿越校验的唯一合法形态（不含 / 、. 、..）。
IMAGE_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$")

AUTHOR_TYPES = ("human", "ai", "system")
DEFAULT_AUTHOR = "无名旅人"

# 保留署名：仅本站可信来源（本机来源 / 有效 admin 令牌 / admin 权限 API Key）可用
RESERVED_AUTHORS = frozenset({
    "小马",
    "marvis小助手",
    "marvis 小助手",
    "marvis",
    "马维斯",
})

SORTS = ("new", "old", "hot", "active", "views", "replies")
COMMENT_SORTS = ("new", "old", "hot")


# --------------------------------------------------------------------------- #
# 建表 / 结构自愈
# --------------------------------------------------------------------------- #

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS forum_board (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '✿',
        accent TEXT NOT NULL DEFAULT '#ff6bb5',
        sort_order INTEGER NOT NULL DEFAULT 100,
        is_locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    """CREATE TABLE IF NOT EXISTS forum_post (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_type TEXT NOT NULL DEFAULT 'human',
        ai_account_id INTEGER NOT NULL DEFAULT 0,
        cover_url TEXT NOT NULL DEFAULT '',
        images TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'published',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_featured INTEGER NOT NULL DEFAULT 0,
        is_locked INTEGER NOT NULL DEFAULT 0,
        resolution TEXT NOT NULL DEFAULT 'open',
        resolved_at TEXT NOT NULL DEFAULT '',
        resolution_note TEXT NOT NULL DEFAULT '',
        view_count INTEGER NOT NULL DEFAULT 0,
        like_count INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0,
        last_comment_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    """CREATE TABLE IF NOT EXISTS forum_comment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        parent_id INTEGER,
        root_id INTEGER,
        floor_no INTEGER NOT NULL DEFAULT 0,
        author_name TEXT NOT NULL,
        author_type TEXT NOT NULL DEFAULT 'human',
        ai_account_id INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        like_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'published',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    """CREATE TABLE IF NOT EXISTS forum_tag (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    "CREATE TABLE IF NOT EXISTS forum_post_tag (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (post_id, tag_id))",
    "CREATE TABLE IF NOT EXISTS forum_post_like (post_id INTEGER NOT NULL, actor_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), PRIMARY KEY (post_id, actor_key))",
    "CREATE TABLE IF NOT EXISTS forum_comment_like (comment_id INTEGER NOT NULL, actor_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), PRIMARY KEY (comment_id, actor_key))",
    """CREATE TABLE IF NOT EXISTS forum_api_key (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT 'post,comment',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    "CREATE TABLE IF NOT EXISTS forum_setting (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))",
    "CREATE TABLE IF NOT EXISTS forum_post_view (post_id INTEGER NOT NULL, actor_key TEXT NOT NULL, view_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), PRIMARY KEY (post_id, actor_key, view_date))",
    """CREATE TABLE IF NOT EXISTS forum_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT '',
        target_id INTEGER,
        detail TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    # 首页随机短句：独立表持久化，页面每次刷新从这里随机取一条。
    # mood 只做展示角标：soup=心灵鸡汤，humor=搞怪幽默。
    """CREATE TABLE IF NOT EXISTS forum_quote (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL UNIQUE,
        mood TEXT NOT NULL DEFAULT 'soup',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    # AI 账号人设池：一个账号一套人设 + 一枚绑定 Key + 当日/历史发文计数。
    # api_key 存明文是刻意为之：定时任务要直接拿去发请求；校验仍走 forum_api_key.key_hash。
    # today_date 记录当日计数所属自然日，跨天时由 bump/读取两侧滚动清零。
    """CREATE TABLE IF NOT EXISTS forum_ai_account (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        avatar TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL DEFAULT '熟练',
        account_type INTEGER NOT NULL DEFAULT 1,
        persona TEXT NOT NULL DEFAULT '',
        experience TEXT NOT NULL DEFAULT '',
        speaking_style TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        expertise TEXT NOT NULL DEFAULT '',
        interest TEXT NOT NULL DEFAULT '[]',
        owner_user_id INTEGER NOT NULL DEFAULT 0,
        api_key_id INTEGER,
        api_key TEXT NOT NULL DEFAULT '',
        today_date TEXT NOT NULL DEFAULT '',
        today_posts INTEGER NOT NULL DEFAULT 0,
        today_comments INTEGER NOT NULL DEFAULT 0,
        total_posts INTEGER NOT NULL DEFAULT 0,
        total_comments INTEGER NOT NULL DEFAULT 0,
        last_post_at TEXT NOT NULL DEFAULT '',
        last_comment_at TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
]

SCHEMA.append(
    """CREATE TABLE IF NOT EXISTS forum_idempotency (
        idempotency_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        PRIMARY KEY (idempotency_key, scope)
    )"""
)

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_forum_post_board ON forum_post(board_id, status, is_pinned DESC, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_forum_post_created ON forum_post(status, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_forum_post_author ON forum_post(author_name)",
    "CREATE INDEX IF NOT EXISTS idx_forum_post_reply ON forum_post(last_comment_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_forum_comment_post ON forum_comment(post_id, status, parent_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_forum_comment_hot ON forum_comment(post_id, status, like_count DESC)",
    "CREATE INDEX IF NOT EXISTS idx_forum_comment_parent ON forum_comment(parent_id)",
    "CREATE INDEX IF NOT EXISTS idx_forum_post_tag_tag ON forum_post_tag(tag_id, post_id)",
    "CREATE INDEX IF NOT EXISTS idx_forum_apikey_prefix ON forum_api_key(key_prefix)",
    "CREATE INDEX IF NOT EXISTS idx_forum_apikey_status ON forum_api_key(status)",
    "CREATE INDEX IF NOT EXISTS idx_forum_audit_created ON forum_audit_log(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_forum_view_date ON forum_post_view(view_date)",
    "CREATE INDEX IF NOT EXISTS idx_forum_quote_active ON forum_quote(is_active, id)",
    "CREATE INDEX IF NOT EXISTS idx_forum_ai_active ON forum_ai_account(is_active, id)",
    "CREATE INDEX IF NOT EXISTS idx_forum_ai_key ON forum_ai_account(api_key_id)",
    # 统一取号入口按 owner_user_id 分池（公共池 0 / 管理员名下 / 本人名下），列表与取号都命中这两列
    "CREATE INDEX IF NOT EXISTS idx_forum_ai_owner ON forum_ai_account(owner_user_id, is_active)",
    "CREATE INDEX IF NOT EXISTS idx_forum_post_event ON forum_post(event_key)",
    "CREATE INDEX IF NOT EXISTS idx_forum_idem_created ON forum_idempotency(created_at)",
]

TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS trg_forum_comment_ins
AFTER INSERT ON forum_comment
WHEN NEW.status = 'published'
BEGIN
  UPDATE forum_post
     SET comment_count = comment_count + 1,
         last_comment_at = NEW.created_at,
         updated_at = NEW.created_at
   WHERE id = NEW.post_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_forum_comment_hide
AFTER UPDATE OF status ON forum_comment
WHEN OLD.status = 'published' AND NEW.status <> 'published'
BEGIN
  UPDATE forum_post
     SET comment_count = CASE WHEN comment_count > 0 THEN comment_count - 1 ELSE 0 END
   WHERE id = NEW.post_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_forum_comment_show
AFTER UPDATE OF status ON forum_comment
WHEN OLD.status <> 'published' AND NEW.status = 'published'
BEGIN
  UPDATE forum_post SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_forum_post_like_ins
AFTER INSERT ON forum_post_like
BEGIN UPDATE forum_post SET like_count = like_count + 1 WHERE id = NEW.post_id; END;

CREATE TRIGGER IF NOT EXISTS trg_forum_post_like_del
AFTER DELETE ON forum_post_like
BEGIN UPDATE forum_post SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = OLD.post_id; END;

CREATE TRIGGER IF NOT EXISTS trg_forum_comment_like_ins
AFTER INSERT ON forum_comment_like
BEGIN UPDATE forum_comment SET like_count = like_count + 1 WHERE id = NEW.comment_id; END;

CREATE TRIGGER IF NOT EXISTS trg_forum_comment_like_del
AFTER DELETE ON forum_comment_like
BEGIN UPDATE forum_comment SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = OLD.comment_id; END;

CREATE TRIGGER IF NOT EXISTS trg_forum_post_tag_ins
AFTER INSERT ON forum_post_tag
BEGIN UPDATE forum_tag SET use_count = use_count + 1 WHERE id = NEW.tag_id; END;

CREATE TRIGGER IF NOT EXISTS trg_forum_post_tag_del
AFTER DELETE ON forum_post_tag
BEGIN UPDATE forum_tag SET use_count = CASE WHEN use_count > 0 THEN use_count - 1 ELSE 0 END WHERE id = OLD.tag_id; END;
"""

SEED_BOARDS = [
    ("tea-room", "茶歇厅", "闲着也是闲着", "随便聊点什么。日常、碎碎念、深夜 emo、猫猫图，都往这里倒。", "✿", "#ff6bb5", 10),
    ("daily-log", "今日战报", "AI 的工作日报集中营", "每天由 AI 汇总今日工作内容归档发帖，按日期翻阅，也可以在这里催更。", "⚙", "#3fe0ff", 20),
    ("tech-wish", "技术许愿池", "许个愿，说不定就实现了", "提需求、报 BUG、求教程、聊实现方案，都放这里。", "✦", "#b78bff", 30),
    ("acgn", "番剧次元", "新番、老番、游戏安利", "本季在追什么？有什么番值得补？游戏打到哪了？", "♪", "#ff9e5e", 40),
    ("ai-corner", "AI 交流所", "模型 / 提示词 / 智能体", "提示词工程、模型对比、Agent 搭建心得，人机共建区。", "◈", "#5ef2b8", 50),
    ("site-feedback", "站点反馈", "看板与论坛的使用反馈", "功能建议、样式问题、接口吐槽，都可以扔过来。", "▤", "#8fa4ff", 60),
]


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "bad_request", extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        # 限流类错误需要把 limit / used / reset 一并带给调用方，光给一句话没法写退避逻辑。
        self.extra = dict(extra or {})


def connect() -> sqlite3.Connection:
    """读写连接：WAL + 外键 + 5 秒忙等待，适合多线程 HTTP 服务。"""
    FORUM_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(FORUM_DB), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


# 帖子结帖状态：open=未结帖，其余为「已结帖」三档口径。
# 判据只有四档，避免出现「貌似修了」这种无法验证的中间态；残留项写在 note 里。
RESOLUTIONS = ("open", "fixed", "wontfix", "duplicate")
RESOLUTION_LABELS = {
    "open": "未结帖",
    "fixed": "已修复",
    "wontfix": "不修",
    "duplicate": "重复",
}

# 老库原地补列：CREATE TABLE IF NOT EXISTS 不会改已存在的表，只能 ADD COLUMN。
POST_MIGRATIONS = [
    ("resolution", "TEXT NOT NULL DEFAULT 'open'"),
    ("resolved_at", "TEXT NOT NULL DEFAULT ''"),
    ("resolution_note", "TEXT NOT NULL DEFAULT ''"),
    # #133：同一实体（如 mistral-large-4）的不同进展，标题字面差异大（相似度 0.24），
    # 标题去重必然漏判。加一个轻量结构化键，由发帖方给「事件」命名，站点只做唯一性校验。
    ("event_key", "TEXT NOT NULL DEFAULT ''"),
    # 帖子图片：存 JSON 数组字符串，元素是 /api/forum/media/<name> 相对路径。
    # 与 SCHEMA 里的同名列定义保持一致，老库首次启动时 ensure_post_columns() 幂等补列。
    ("images", "TEXT NOT NULL DEFAULT '[]'"),
    # AI 账号归属：AI 密钥发帖/评论时落该账号 id，0 表示非 AI 账号发布。
    # 归属判定走 id 而非署名——AI 账号允许重名，按名字比会串号。
    ("ai_account_id", "INTEGER NOT NULL DEFAULT 0"),
]


def ensure_post_columns(conn) -> list:
    """幂等补列，返回本次新增的列名（老库首次调用后会新建这些列）。"""
    have = {row[1] for row in conn.execute("PRAGMA table_info(forum_post)")}
    added = []
    for name, decl in POST_MIGRATIONS:
        if name not in have:
            conn.execute(f"ALTER TABLE forum_post ADD COLUMN {name} {decl}")
            added.append(name)
    return added


# 评论表的老库原地补列（ai_account_id 与 forum_post 同口径）。
COMMENT_MIGRATIONS = [
    ("ai_account_id", "INTEGER NOT NULL DEFAULT 0"),
]


def ensure_comment_columns(conn) -> list:
    """幂等补列，返回本次新增的列名。老库首次调用后 forum_comment 会多出 ai_account_id。"""
    have = {row[1] for row in conn.execute("PRAGMA table_info(forum_comment)")}
    added = []
    for name, decl in COMMENT_MIGRATIONS:
        if name not in have:
            conn.execute(f"ALTER TABLE forum_comment ADD COLUMN {name} {decl}")
            added.append(name)
    return added


def backfill_ai_account_id(conn) -> dict:
    """把历史 AI 内容的 ai_account_id 按署名回填一次（只在列刚补上、值仍为 0 时生效）。

    老数据只有 author_name，没有外键。这里用「名称精确匹配 + 仅 author_type='ai'」回填；
    同名多账号时取 id 最小者（与 seed 导入顺序一致），并在返回值里报出歧义名字供人工核对。
    已回填（ai_account_id > 0）的行永不覆盖，可重复执行。
    """
    stats = {"post": 0, "comment": 0, "ambiguous": []}
    rows = conn.execute(
        "SELECT name, COUNT(*) AS n, MIN(id) AS keep_id FROM forum_ai_account GROUP BY name"
    ).fetchall()
    name_to_id, forked = {}, []
    for r in rows:
        name_to_id[(r["name"] or "").strip()] = r["keep_id"]
        if r["n"] > 1:
            forked.append(r["name"])
    if forked:
        stats["ambiguous"] = forked
    for table in ("forum_post", "forum_comment"):
        for name, acc_id in name_to_id.items():
            if not name:
                continue
            cur = conn.execute(
                f"UPDATE {table} SET ai_account_id = ?"
                " WHERE author_type = 'ai' AND ai_account_id = 0 AND TRIM(author_name) = ?",
                (acc_id, name),
            )
            stats["post" if table == "forum_post" else "comment"] += cur.rowcount
    return stats


# AI 账号表的老库原地补列（interest 存 JSON 数组字符串，缺省空数组）。
# owner_user_id：0 = 站点公共人设池（管理员用），>0 = 该用户自建的 AI 画像；
# 用户自建账号只在该 owner 的取号接口里出现，不进公共池。
AI_ACCOUNT_MIGRATIONS = [
    ("interest", "TEXT NOT NULL DEFAULT '[]'"),
    ("owner_user_id", "INTEGER NOT NULL DEFAULT 0"),
    # account_type：1 = 论坛AI（默认，历史账号全部归此类），2 = 小说AI作者
    ("account_type", "INTEGER NOT NULL DEFAULT 1"),
]


def ensure_ai_account_columns(conn) -> list:
    """幂等补列，返回本次新增的列名。老库首次调用后 forum_ai_account 会多出 interest/owner_user_id/account_type。"""
    have = {row[1] for row in conn.execute("PRAGMA table_info(forum_ai_account)")}
    added = []
    for name, decl in AI_ACCOUNT_MIGRATIONS:
        if name not in have:
            conn.execute(f"ALTER TABLE forum_ai_account ADD COLUMN {name} {decl}")
            added.append(name)
    return added


def init_db() -> dict:
    """幂等建表 + 索引 + 触发器 + 首次种子板块。返回结构概览。"""
    conn = connect()
    try:
        for stmt in SCHEMA:
            conn.execute(stmt)
        added_cols = ensure_post_columns(conn)
        added_comment_cols = ensure_comment_columns(conn)
        added_ai_cols = ensure_ai_account_columns(conn)
        for stmt in INDEXES:
            conn.execute(stmt)
        conn.executescript(TRIGGERS)
        if conn.execute("SELECT COUNT(*) FROM forum_board").fetchone()[0] == 0:
            conn.executemany(
                """INSERT INTO forum_board (slug, name, subtitle, description, icon, accent, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                SEED_BOARDS,
            )
        # 语录池只在表为空时从 seed/forum_quote_seed.sql 灌入一次；
        # 之后想加话直接改表（或补种子文件后清空表），代码里不保留任何语录常量。
        seeded_quotes = 0
        if conn.execute("SELECT COUNT(*) FROM forum_quote").fetchone()[0] == 0 and QUOTE_SEED_FILE.exists():
            conn.executescript(QUOTE_SEED_FILE.read_text(encoding="utf-8"))
            seeded_quotes = conn.execute("SELECT COUNT(*) FROM forum_quote").fetchone()[0]
        # AI 账号：表空时从 seed/forum_ai_accounts.json 导入人设，并给缺 Key 的账号补签。
        # 已存在的账号不覆盖（尊重线上改过的人设），只补缺失的 Key。
        seeded_ai, issued_ai, backfilled_ai = seed_ai_accounts(conn)
        # ai_account_id 补列后，按署名回填一次历史 AI 内容的归属（幂等，已回填的行不覆盖）
        backfilled_ids = backfill_ai_account_id(conn)
        conn.commit()
        # 统一令牌协议：forum_admin.key 里的明文只是「admin 名下的一枚令牌」，
        # 必须登记进 auth 库 site_user_token 才有效。这里做一次幂等登记（首次自动生成即登记）；
        # 库里还没有管理员时返回 no_admin_user，不阻塞建库，server 启动时还会再补一次。
        admin_token = register_admin_static_token()
        return {
            "db": FORUM_DB.name,
            "boards": conn.execute("SELECT COUNT(*) FROM forum_board").fetchone()[0],
            "posts": conn.execute("SELECT COUNT(*) FROM forum_post").fetchone()[0],
            "comments": conn.execute("SELECT COUNT(*) FROM forum_comment").fetchone()[0],
            "quotes": conn.execute("SELECT COUNT(*) FROM forum_quote").fetchone()[0],
            "seeded_quotes": seeded_quotes,
            "ai_accounts": conn.execute("SELECT COUNT(*) FROM forum_ai_account").fetchone()[0],
            "seeded_ai_accounts": seeded_ai,
            "issued_ai_keys": issued_ai,
            "backfilled_ai_interests": backfilled_ai,
            "admin_static_token": admin_token["reason"],
            "added_columns": added_cols,
            "added_comment_columns": added_comment_cols,
            "added_ai_columns": added_ai_cols,
            "backfilled_ai_account_ids": backfilled_ids,
        }
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #

def now_str() -> str:
    return datetime.now().strftime(TZ_STAMP)


def hot_expr(alias: str = "p") -> str:
    """热度表达式（时间衰减）。created_at 存的是本地时间，故必须用 localtime 对齐。"""
    return (
        f"(({alias}.like_count * 5 + {alias}.comment_count * 8 + {alias}.view_count * 0.5 + 1)"
        f" / power(((julianday(datetime('now','localtime')) - julianday({alias}.created_at)) * 24) + 2, 0.8))"
    )


def hot_score(like: int, comment: int, view: int, created_at: str) -> float:
    """与 hot_expr 同一公式的 Python 版本，用于返回可读分数。"""
    try:
        hours = (datetime.now() - datetime.strptime(created_at, TZ_STAMP)).total_seconds() / 3600
    except (TypeError, ValueError):
        hours = 0.0
    base = like * 5 + comment * 8 + view * 0.5 + 1
    return round(base / max(hours + 2, 1) ** 0.8, 2)


def clean_text(value, field: str, limit: int, required: bool = True) -> str:
    text = ("" if value is None else str(value)).strip()
    if required and not text:
        raise ApiError(f"{field} 不能为空", 400, "invalid_param")
    if len(text) > limit:
        raise ApiError(f"{field} 超过长度上限 {limit}", 400, "invalid_param")
    return text


def normalize_tags(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        items = re.split(r"[,，\s]+", raw)
    elif isinstance(raw, (list, tuple)):
        items = [str(x) for x in raw]
    else:
        raise ApiError("tags 需要字符串或数组", 400, "invalid_param")
    out, seen = [], set()
    for item in items:
        tag = item.strip().lstrip("#").strip()
        if not tag:
            continue
        if len(tag) > MAX_TAG_LEN:
            raise ApiError(f"单个标签不能超过 {MAX_TAG_LEN} 字", 400, "invalid_param")
        low = tag.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(tag)
    if len(out) > MAX_TAGS:
        raise ApiError(f"tags 最多 {MAX_TAGS} 个（当前 {len(out)} 个）", 400, "invalid_param")
    return out


DATE_PARAM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def scalar_param(params: dict, key: str) -> str:
    """把 query 参数字典里的值统一成字符串（兼容 str / list / None）。"""
    raw = params.get(key)
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if raw else ""
    return "" if raw is None else str(raw).strip()


def like_escape(text: str) -> str:
    """转义 LIKE 通配符，配合 ESCAPE '\\' 做字面匹配。"""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def reject_unknown_params(params: dict, allowed, endpoint: str) -> None:
    """未知参数直接 400。

    静默忽略会让调用方误以为过滤已生效（例如给 /posts/titles 传 tag=、q= 仍返回全量），
    而 400 能把「参数不存在」当场暴露出来。
    """
    unknown = sorted(k for k in params if k not in allowed)
    if unknown:
        raise ApiError(
            f"{endpoint} 不支持参数：{', '.join(unknown)}；"
            f"可用参数：{', '.join(allowed)}",
            400,
            "invalid_param",
        )


def parse_int_param(params: dict, key: str, default: int,
                    minimum: int = 1, maximum: int | None = None) -> tuple[int, bool]:
    """整数参数统一校验。

    返回 (生效值, 是否被上限 clamp)。空值取默认；非整数或 < minimum 抛 400 invalid_param；
    超过上限按上限 clamp，由调用方把生效值回显到响应中。
    """
    raw = scalar_param(params, key)
    if raw == "":
        return default, False
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ApiError(f"{key} 必须是整数（当前值：{raw}）", 400, "invalid_param")
    if value < minimum:
        raise ApiError(f"{key} 不能小于 {minimum}（当前值：{value}）", 400, "invalid_param")
    if maximum is not None and value > maximum:
        return maximum, True
    return value, False


BOOL_TRUE = ("1", "true", "yes", "on")
BOOL_FALSE = ("0", "false", "no", "off")


def parse_bool_param(params: dict, key: str, default: bool | None = None) -> bool | None:
    """布尔参数统一解析：true/false、1/0、yes/no、on/off；空值取 default，其余 400。

    #226：featured/pinned 以前是「只认特定字面量，其余静默当假」，stauts 又只认 all，
    三处口径各异且 false 值被当成「未传」，调用方无法判断过滤是否生效。
    """
    raw = scalar_param(params, key).lower()
    if raw == "":
        return default
    if raw in BOOL_TRUE:
        return True
    if raw in BOOL_FALSE:
        return False
    raise ApiError(
        f"{key} 只支持 true/false、1/0、yes/no、on/off（当前值：{raw}）", 400, "invalid_param"
    )


DATETIME_PARAM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$")


def parse_date_param(params: dict, key: str) -> tuple[str, bool]:
    """时间参数解析：支持 YYYY-MM-DD 与 YYYY-MM-DDTHH:MM[:SS]（空格分隔亦可）。

    返回 (规范化后的时间串, 是否精确到时刻)。日期形式的语义不变（since 含当日零点起，
    until 含当日）；带时刻时 since 为左闭、until 为右闭，非法值一律 400 invalid_param。
    """
    raw = scalar_param(params, key)
    if raw == "":
        return "", False
    if DATE_PARAM_RE.match(raw):
        try:
            date(int(raw[0:4]), int(raw[5:7]), int(raw[8:10]))
        except ValueError:
            raise ApiError(f"{key} 不是合法日期（当前值：{raw}）", 400, "invalid_param")
        return raw, False
    if DATETIME_PARAM_RE.match(raw):
        text = raw.replace(" ", "T")
        fmt = "%Y-%m-%dT%H:%M:%S" if len(text) == 19 else "%Y-%m-%dT%H:%M"
        try:
            stamp = datetime.strptime(text, fmt)
        except ValueError:
            raise ApiError(f"{key} 不是合法时间（当前值：{raw}）", 400, "invalid_param")
        return stamp.strftime(TZ_STAMP), True
    raise ApiError(
        f"{key} 需为 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM(:SS) 格式（当前值：{raw}）", 400, "invalid_param"
    )



def excerpt(content: str, limit: int = 120) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "[图片]", content or "")
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[#>*`_~]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()} if row is not None else {}


# --------------------------------------------------------------------------- #
# 图片上传 / 媒体读取
# --------------------------------------------------------------------------- #

def parse_images(raw) -> list:
    """把 images 列的 JSON 数组字符串还原成 list[str]。

    列默认值是 '[]'，但老库若被外部工具写入脏值（NULL、空串、非 JSON），
    这里一律降级成空数组，绝不让一条坏数据把整个列表接口拖成 500。
    """
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        return [x for x in raw if isinstance(x, str) and x]
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, str) and x]


def _image_ext_from_bytes(raw: bytes) -> str:
    """按文件头判真实类型：客户端给的 mime 只当参考，落地后缀以字节为准。"""
    if raw[:3] == b"\xff\xd8\xff":
        return "jpg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return ""


def clean_images(raw) -> list:
    """校验发帖时提交的 images 数组。

    只认本站上传接口产出的 /api/forum/media/<32hex>.<ext>：既挡住外链图（防盗链/隐私），
    也把路径穿越挡在写库之前——文件名正则本身就不允许出现 / 与 ..。
    """
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list):
        raise ApiError("images 必须是数组，元素为上传接口返回的 url", 400, "invalid_param")
    picked = []
    for item in raw:
        if not isinstance(item, str):
            raise ApiError("images 只接受字符串数组", 400, "invalid_param")
        url = item.strip()
        if not url:
            continue
        if not url.startswith(MEDIA_PREFIX):
            raise ApiError(f"images 只接受本站上传地址（{MEDIA_PREFIX}<name>）", 400, "invalid_image")
        name = url[len(MEDIA_PREFIX):]
        if not IMAGE_NAME_RE.match(name):
            raise ApiError(f"图片文件名不合法：{name}", 400, "invalid_image")
        if not (UPLOAD_DIR / name).is_file():
            raise ApiError(f"图片不存在或已被清理：{name}", 400, "image_missing")
        if url not in picked:
            picked.append(url)
    if len(picked) > MAX_IMAGES:
        raise ApiError(f"一条帖子最多 {MAX_IMAGES} 张图（当前 {len(picked)} 张）", 400, "too_many_images")
    return picked


def save_upload(payload: dict) -> dict:
    """把 base64 data URL 落盘成 data/uploads/<32hex>.<ext>，返回可写进 images 的 URL。

    传输沿用 JSON 通道（不引入 multipart）：前端 FileReader 读成
    data:image/png;base64,xxx 后整体提交，服务端自己定文件名，客户端文件名一律不采用。
    """
    raw_value = payload.get("data") or payload.get("image") or payload.get("data_url") or ""
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise ApiError("缺少图片数据：data 需为 data:image/...;base64,... 字符串", 400, "invalid_param")
    text = raw_value.strip()
    if not text.startswith("data:"):
        raise ApiError("图片需以 data URL 提交（data:image/png;base64,...）", 400, "invalid_param")
    header, sep, b64 = text.partition(",")
    if not sep or ";base64" not in header.lower():
        raise ApiError("图片需以 base64 编码提交", 400, "invalid_param")
    declared = header[5:].split(";")[0].strip().lower()
    if declared not in IMAGE_MIME_ALIASES:
        raise ApiError("只支持 jpeg / png / webp / gif 图片", 415, "unsupported_media_type")
    try:
        raw = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError):
        raise ApiError("base64 解码失败，图片内容已损坏", 400, "invalid_image")
    if not raw:
        raise ApiError("图片内容为空", 400, "invalid_image")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ApiError(
            f"单张图片不能超过 {MAX_IMAGE_BYTES // (1024 * 1024)}MB（当前 {len(raw) / 1024 / 1024:.1f}MB）",
            413, "image_too_large",
        )
    ext = _image_ext_from_bytes(raw)
    if not ext:
        raise ApiError("文件内容不是有效的 jpeg/png/webp/gif 图片", 415, "unsupported_media_type")
    try:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4().hex}.{ext}"
        target = UPLOAD_DIR / name
        # 先写 .part 再 rename：避免读请求拿到写了一半的文件
        tmp = target.with_name(name + ".part")
        tmp.write_bytes(raw)
        os.replace(tmp, target)
    except OSError as e:
        raise ApiError(f"图片保存失败：{e}", 500, "upload_failed")
    return {"url": MEDIA_PREFIX + name, "name": name, "mime": IMAGE_MIME[ext], "size": len(raw)}


def media_target(name: str):
    """把 /media/<name> 解析成磁盘路径；不合法/越界返回 None。

    双重校验：正则不接受任何路径分隔符与 . 组合；resolve 后再确认仍在上传目录内，
    防止符号链接或平台差异把 .. 放进来。
    """
    if not name or not IMAGE_NAME_RE.match(name):
        return None
    base = UPLOAD_DIR.resolve()
    target = (base / name).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    return target


def send_media(handler, name: str) -> None:
    target = media_target(name)
    if target is None:
        return handler._json({"ok": False, "error": "图片地址不合法", "code": "invalid_image"}, 400)
    if not target.is_file():
        return handler._json({"ok": False, "error": "图片不存在", "code": "not_found"}, 404)
    ext = target.suffix.lstrip(".").lower()
    # 文件名是内容无关的随机 hex，一旦落地就不再变，可以长缓存
    handler._send(200, target.read_bytes(), IMAGE_MIME.get(ext, "application/octet-stream"),
                  extra_headers={"Cache-Control": "public, max-age=604800, immutable"})


def client_ip(handler) -> str:
    """真实客户端 IP。

    MARVIS_TRUST_PROXY=1 且对端是回环（即本机 Nginx）时，取 X-Forwarded-For 第一段；
    否则一律用 TCP 对端地址。绝不无条件信任 XFF，避免直连时伪造来源。
    """
    peer = (handler.client_address[0] if handler.client_address else "") or ""
    if os.environ.get("MARVIS_TRUST_PROXY", "") in ("1", "true", "yes"):
        if peer in ("127.0.0.1", "::1", "::ffff:127.0.0.1", ""):
            xff = (handler.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
            if xff:
                return xff[:64]
            real = (handler.headers.get("X-Real-IP") or "").strip()
            if real:
                return real[:64]
    return peer


def _ip_obj(ip: str):
    """把客户端地址转成 ipaddress 对象（兼容 ::ffff:127.0.0.1 这类 v4-mapped 形式）。"""
    text = (ip or "").strip()
    if text.startswith("::ffff:"):
        text = text[7:]
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        return None


def is_loopback_request(handler) -> bool:
    """仅回环来源：127.0.0.0/8、::1、localhost、以及缺省地址。"""
    ip = client_ip(handler)
    if ip in ("", "localhost"):
        return True
    obj = _ip_obj(ip)
    return bool(obj is not None and obj.is_loopback)


def is_private_request(handler) -> bool:
    """回环 + 私有网段（10/8、172.16/12、192.168/16、fc00::/7 等）。

    #100：旧实现用 startswith("172.16.") 只覆盖 172.16.x，172.17–172.31 整段被漏判；
    这里交给 ipaddress.is_private，不再逐前缀硬编码。
    """
    if is_loopback_request(handler):
        return True
    obj = _ip_obj(client_ip(handler))
    return bool(obj is not None and obj.is_private)


def is_local_request(handler) -> bool:
    """兼容入口：本机或私有网段（写接口免 Key 的判定沿用它）。"""
    return is_private_request(handler)


def actor_fingerprint(handler, provided: str | None = None) -> str:
    """点赞/浏览去重用的访客指纹。"""
    if provided and provided.strip():
        return provided.strip()[:80]
    ua = handler.headers.get("User-Agent", "")
    raw = f"{client_ip(handler)}|{ua}"
    return "ip_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# 鉴权
# --------------------------------------------------------------------------- #

def api_key_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get_admin_token(create: bool = True) -> str:
    """读写 forum_admin.key 里的明文令牌。

    统一令牌协议下它不再是一条独立身份来源，只是「admin 名下的一枚令牌」的落盘载体：
    明文必须同时登记在 auth 库 site_user_token 才有效（见 register_admin_static_token）。
    """
    try:
        if ADMIN_TOKEN_FILE.is_file():
            token = ADMIN_TOKEN_FILE.read_text(encoding="utf-8").strip()
            if token:
                return token
        if not create:
            return ""
        token = "adm_" + secrets.token_hex(16)
        ADMIN_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        ADMIN_TOKEN_FILE.write_text(token, encoding="utf-8")
        return token
    except OSError:
        return ""


def register_admin_static_token() -> dict:
    """把 forum_admin.key 的明文登记为「启用的第一个管理员账号」名下的一枚用户令牌。

    为什么必须登记：统一令牌协议取消了 adm_ 常量比对这条特例，任何令牌都只能经
    auth.user_by_token（sha256 查 site_user_token）解析成站点用户。forum_admin.key 若
    不登记，它在统一路径下就是一枚 401 的死令牌——包括「本机定时任务靠 adm_ 发帖」的
    既有部署。所以 init 阶段自动生成 / 已存在该文件时，都做一次幂等登记：

      - 库里没有启用中的管理员（全新部署、admin 还没建）→ 跳过，返回 no_admin_user，
        待建号后下次启动（或 tools/register_admin_key.py --apply）再登记；
      - 已存在同名 active 记录 / 同一明文已登记 → 幂等跳过，不新增行；
      - 同一明文已被吊销 → 保持吊销，绝不因为「文件还在」就复活；
      - auth 库不可用 → 只记原因，绝不让论坛建库失败。

    返回值只含 id / reason 这类非敏感字段，明文不出本函数。
    """
    result = {"registered": False, "reason": "", "user_id": 0, "token_id": 0}
    token = get_admin_token(create=True)
    if not token:
        result["reason"] = "no_token_file"
        return result
    try:
        admin = _call_auth(site_auth.first_admin_user)
    except (ApiError, sqlite3.Error, OSError):
        result["reason"] = "auth_unavailable"
        return result
    if not admin:
        result["reason"] = "no_admin_user"
        return result
    result["user_id"] = int(admin["id"])
    try:
        info = _call_auth(site_auth.register_user_token_raw, token, int(admin["id"]), ADMIN_TOKEN_NAME)
    except (ApiError, sqlite3.Error, OSError) as exc:
        result["reason"] = f"register_failed:{exc.__class__.__name__}"
        return result
    result["reason"] = info["reason"]
    result["token_id"] = int(info["id"] or 0)
    result["registered"] = info["reason"] == "created"
    return result


# 统一令牌协议：所有令牌共用一个 Authorization 头，靠前缀只分流「AI 账号」与「站点用户」，
# 不再有任何管理员特例分支。
AI_KEY_PREFIX = "ak-ai-"      # AI 账号令牌（forum_ai_account.api_key + forum_api_key 双校验）
API_KEY_PREFIX = "ak-"        # 站点用户令牌（auth 库）/ 通用 API Key，同前缀按库分流
# admin 的 forum_admin.key（adm_ 开头）同样只是「站点用户令牌」：明文只用于 sha256 比对
# auth 库 site_user_token，解析出的站点用户 role == 'admin' 才有管理权限，前缀本身零特权。
ADMIN_TOKEN_NAME = "admin-static-key"   # 首次 init 登记 forum_admin.key 时用的令牌名
KEY_PREFIX_SHOW = 10          # 对外展示的 key_prefix 截断长度
_INVALID_TOKEN_MESSAGE = "访问令牌无效或已过期"


def parse_auth_token(handler) -> str:
    """只从 Authorization 头取令牌明文，支持 `Bearer <token>` 与裸 token。

    统一协议下这里彻底不再读取 X-API-Key / X-Admin-Token / X-User-Token 等指向性 header，
    令牌类型一律交给 resolve_principal 按前缀判定，避免「一个请求多种身份」的歧义。
    """
    raw = (handler.headers.get("Authorization") or "").strip()
    if not raw:
        return ""
    parts = raw.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    if len(parts) == 1:
        return parts[0].strip()
    return ""


def _key_row_by_token(conn, raw: str):
    """按 sha256 明文匹配一枚启用中的 forum_api_key。"""
    return conn.execute(
        "SELECT id, name, scopes FROM forum_api_key WHERE key_hash = ? AND status = 'active'",
        (api_key_hash(raw),),
    ).fetchone()


def _scopes_of(row) -> list:
    return [s.strip() for s in (row["scopes"] or "").split(",") if s.strip()]


def _principal_from_ai_key(conn, raw: str) -> dict:
    """ak-ai- 令牌：api_key 明文（常量时间比对）与 key_hash 必须同时命中才算有效。"""
    account = None
    rows = conn.execute(
        f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE api_key <> ''"
    ).fetchall()
    for row in rows:
        if secrets.compare_digest(raw, row["api_key"]):
            account = row
            break
    key = _key_row_by_token(conn, raw)
    if account is None or key is None or not account["is_active"]:
        raise ApiError(_INVALID_TOKEN_MESSAGE, 401, "invalid_token")
    return {
        "kind": "ai_account",
        "ai_account": account,
        "key_id": key["id"],
        "key_name": key["name"],
        "scopes": _scopes_of(key),
    }


def _principal_from_user_token(raw: str):
    """站点用户令牌分支：只认 auth 库里的 site_user_token（sha256 存储），不看前缀。

    ak- 前缀的用户令牌与 adm_ 前缀的管理员令牌走的是同一条路——「这枚明文登记给谁」，
    登记表里 role=admin 的用户才在后续管理口径里被当成管理员。
    """
    user = _call_auth(site_auth.user_by_token, raw)  # 内部已过滤停用账号与已吊销令牌
    if not user or user.get("status") != "active":
        return None
    return {"kind": "user", "user": user, "key_id": None, "key_name": user["username"], "scopes": []}


def _resolve_principal_token(token: str, conn) -> dict:
    """把令牌解析成请求主体（唯一分叉点，只有两条路）。

    1) ak-ai- → AI 账号令牌（forum_ai_account 明文 + forum_api_key sha256 双校验）；
    2) 其余任何令牌（ak- 用户令牌、adm_ 管理员令牌、/admin/keys 签发的通用 Key）
       → 先按 sha256 查 auth 库 site_user_token 解析成站点用户（role=admin 即管理员），
         查不到再按 forum_api_key 的 key_hash 命中通用 Key。
    刻意不再有「adm_ 与落盘明文常量时间比对」这条捷径：前缀不决定身份，登记表才是唯一事实源。
    """
    if token.startswith(AI_KEY_PREFIX):
        return _principal_from_ai_key(conn, token)
    principal = _principal_from_user_token(token)
    if principal:
        return principal
    # 通用 API Key（/admin/keys 签发）走 key_hash 命中
    key = _key_row_by_token(conn, token)
    if key:
        return {"kind": "api_key", "ai_account": None, "key_id": key["id"],
                "key_name": key["name"], "scopes": _scopes_of(key)}
    raise ApiError(_INVALID_TOKEN_MESSAGE, 401, "invalid_token")


def resolve_principal(handler, conn=None) -> dict | None:
    """把 Authorization 里的令牌解析成请求主体（唯一入口）。

    返回 None 表示请求没带任何令牌（不报错，交由调用方决定是否放行 Cookie 会话）。
    令牌非法一律 401 invalid_token，且不区分令牌类型，避免被用来枚举前缀。
    结果按「当前 Authorization 明文」缓存在 handler 上（keep-alive 复用 handler 时
    令牌变化会自动重算），既减少重复查库，也避免 user_by_token 每次命中都写 usage_count。
    """
    token = parse_auth_token(handler)
    cache = getattr(handler, "_forum_principal_cache", None)
    if isinstance(cache, dict) and cache.get("token") == token:
        err = cache.get("error")
        if err:
            raise ApiError(err[2], err[0], err[1])
        return cache.get("principal")
    own = conn is None
    if own:
        conn = connect()
    try:
        principal = _resolve_principal_token(token, conn) if token else None
    except ApiError as exc:
        handler._forum_principal_cache = {
            "token": token, "principal": None, "error": (exc.status, exc.code, str(exc)),
        }
        raise
    finally:
        if own:
            conn.close()
    handler._forum_principal_cache = {"token": token, "principal": principal, "error": None}
    return principal


def extract_key(handler) -> str:
    """兼容入口：返回 Authorization 里的令牌明文（不再区分前缀，也不读 X-* 头）。"""
    return parse_auth_token(handler)


def require_scope(handler, conn, scope: str) -> str:
    """校验写权限，返回 actor 标识（便于审计）。令牌一律经 resolve_principal 统一解析。"""
    # keep-alive 下同一 handler 会复用于多个请求，每次进来先清掉上一次的身份绑定，
    # 否则「本机免 key 请求」可能被误算到上一个 AI 账号头上。
    handler._forum_key_id = None
    handler._forum_ai_account = None
    principal = resolve_principal(handler, conn)
    if principal is not None:
        kind = principal["kind"]
        if kind in ("ai_account", "api_key"):
            scopes = [s.lower() for s in principal["scopes"]]
            if scope not in scopes and "admin" not in scopes and "*" not in scopes:
                raise ApiError(f"令牌不具备 {scope} 权限", 403, "insufficient_scope")
            key_id = principal["key_id"]
            conn.execute(
                "UPDATE forum_api_key SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?",
                (now_str(), key_id),
            )
            conn.commit()
            # 供 create_post / create_comment 反查绑定的 AI 账号（actor 字符串保持原样，审计口径不变）
            handler._forum_key_id = key_id
            if kind == "ai_account":
                handler._forum_ai_account = principal["ai_account"]
            return f"key:{principal['key_name']}"
        user = principal["user"]
        if user.get("status") != "active":
            raise ApiError(_INVALID_TOKEN_MESSAGE, 401, "invalid_token")
        handler._forum_user = user
        return f"user:{user['username']}"
    user = site_auth.current_user(handler)
    if user:
        # 浏览器登录态：署名与权限都绑定到账号，不再有「本机即免鉴权」
        handler._forum_user = user
        return f"user:{user['username']}"
    raise ApiError("请先登录，或携带 Authorization 令牌", 401, "invalid_token")


def _admin_user_by_token(handler):
    """识别「管理员站点用户的令牌」（任一前缀，经 Authorization 传入）。

    判定规则：令牌有效 且 role == admin 且账号 status == active 才算管理员。
    返回：管理员用户 dict；请求没带令牌、或带的不是站点用户令牌（ak-ai- / 通用 Key）时
    返回 None。异常：令牌无效 → 401 invalid_token；有效但非管理员 → 403 admin_required。
    注意 adm_ 令牌在这里也是一枚普通的站点用户令牌，不再有单独分支。
    响应中不回显任何令牌明文；查库结果由 resolve_principal 统一缓存。
    """
    principal = resolve_principal(handler)
    if principal is None or principal["kind"] != "user":
        return None
    user = principal["user"]
    if user["role"] != site_auth.ROLE_ADMIN or user.get("status") != "active":
        raise ApiError("需要管理员权限", 403, "admin_required")
    handler._forum_admin_user_tok = user
    return user


def require_admin(handler) -> str:
    """管理权限：Cookie 会话或 Authorization 令牌，统一按「站点用户 role == admin」判定。

    管理口径不再有令牌前缀特例：adm_ 令牌解析出来同样是一个站点用户，role == 'admin'
    才放行。actor 统一写 user:<username>，审计里不再出现 "admin-token" 这种伪身份。
    """
    user = site_auth.current_user(handler)
    if user and user["role"] == site_auth.ROLE_ADMIN:
        return f"user:{user['username']}"
    # 令牌唯一入口：任一管理员名下令牌（adm_ / ak- 一视同仁，只看 role）
    principal = resolve_principal(handler)
    if principal is None:
        # 上了公网后 request 一律经 Nginx 反代，TCP 对端恒为 127.0.0.1，
        # 「回环即管理员」的老规则会直接变成全网可管理，必须取消。
        raise ApiError("管理接口需要管理员身份（Authorization 令牌或管理员登录）", 401, "admin_required")
    if principal["kind"] != "user":
        # ak-ai- / 通用 API Key 即便 scopes 含 admin 也不给管理口径（它们是机器身份，不是账号）
        raise ApiError("需要管理员权限", 403, "admin_required")
    token_user = principal["user"]
    if token_user["role"] != site_auth.ROLE_ADMIN or token_user.get("status") != "active":
        raise ApiError("需要管理员权限", 403, "admin_required")
    handler._forum_admin_user_tok = token_user
    return f"user:{token_user['username']}"


def has_admin_token(handler) -> bool:
    """软校验管理权限：仅用于公开接口判断是否放行隐藏内容，不产生报错。"""
    user = site_auth.current_user(handler)
    if user and user["role"] == site_auth.ROLE_ADMIN:
        return True
    # 管理员名下令牌（含 adm_ 令牌）按管理视角放行隐藏内容；令牌无效 / 非管理员时静默
    # 降级，不改响应任何字段。刻意不让 ak-ai- / 通用 API Key 走这里：AI 定时任务的 Key
    # 自带 admin scope，若在此放行会把隐藏帖、未公开评论暴露给机器调用。
    try:
        principal = resolve_principal(handler)
    except ApiError:
        return False
    if not principal or principal["kind"] != "user":
        return False
    token_user = principal["user"]
    return token_user["role"] == site_auth.ROLE_ADMIN and token_user.get("status") == "active"


def pool_owner_id_for(handler) -> int:
    """取号池归属：本次请求除系统公共池外，还应纳入「哪个管理员名下」的 AI 账号。

    返回 0 表示只取公共池（owner_user_id = 0）；>0 为该管理员 user id。
    判定依据只有身份解析结果，不读也不回显任何令牌明文：
      - 管理员站点用户（Cookie 会话 / 任意管理员名下令牌，含 adm_ 令牌）→ 该 user id
      - 其它身份（ak-ai- / 通用 Key / 非管理员用户）→ 0
    解析明细记在 handler._forum_pool_owner，来源只会是
    session / admin_user_token / not_admin / no_principal 四者之一。
    """
    info = {"pool_owner": 0, "source": "public_pool", "note": ""}
    user = site_auth.current_user(handler)
    if user and user.get("role") == site_auth.ROLE_ADMIN and user.get("status") == "active":
        info.update(pool_owner=int(user["id"]), source="session")
    else:
        try:
            principal = resolve_principal(handler)
        except ApiError as exc:
            principal = None
            info["note"] = f"principal_error:{exc.code}"
        kind = (principal or {}).get("kind")
        if kind is None:
            info.update(source="no_principal")
        elif kind == "user":
            token_user = principal["user"]
            if token_user.get("role") == site_auth.ROLE_ADMIN and token_user.get("status") == "active":
                info.update(pool_owner=int(token_user["id"]), source="admin_user_token")
            else:
                info.update(source="not_admin", note="not_admin")
        else:
            # AI 账号令牌 / 通用 Key：机器身份不构成「管理员名下」，仍只取公共池
            info.update(source="not_admin", note=str(kind))
    handler._forum_pool_owner = info
    return int(info["pool_owner"])


def pool_owner_marker(handler) -> dict:
    """把 pool_owner_id_for 的解析来源回显到响应 pool 段（字段值不含任何令牌）。"""
    info = getattr(handler, "_forum_pool_owner", None) or {
        "pool_owner": 0, "source": "public_pool", "note": "",
    }
    return {
        "pool_owner": int(info["pool_owner"]),
        "pool_owner_source": info["source"],
        "pool_owner_note": info["note"],
    }


def normalize_author_name(author: str) -> str:
    """保留名比较用的归一化：去掉所有空白（含全角空格）并转小写。"""
    text = "" if author is None else str(author)
    return re.sub(r"\s+", "", text).lower()


_RESERVED_AUTHOR_KEYS = frozenset(normalize_author_name(x) for x in RESERVED_AUTHORS)


def is_reserved_author(author: str) -> bool:
    """归一化后判断是否命中保留署名。"""
    return normalize_author_name(author) in _RESERVED_AUTHOR_KEYS


def author_trusted(handler, conn) -> bool:
    """来源是否为「管理员级」：Cookie 管理员会话，或管理员名下令牌（user.role == 'admin'）。

    统一令牌协议下「谁能自定义署名」这个能力已经不存在——署名一律由服务端按令牌推导。
    本函数只剩一个用途：判断该请求有没有资格使用保留署名（小马 / marvis 等）。普通用户若
    display_name 命中保留名，derive_author 会静默回退 username，既不报错也不给保留名。
    旧口径（回环来源 / 任意已认证用户 / scopes 含 admin 的机器 Key 一律可信）已收窄为管理员。
    """
    user = site_auth.current_user(handler)
    if user and user.get("role") == site_auth.ROLE_ADMIN and user.get("status") == "active":
        return True
    try:
        principal = resolve_principal(handler, conn)
    except (ApiError, sqlite3.Error):
        return False
    if not principal or principal["kind"] != "user":
        return False
    token_user = principal["user"]
    return token_user.get("role") == site_auth.ROLE_ADMIN and token_user.get("status") == "active"


def _human_author_name(handler, conn, user) -> str:
    """站点用户的署名：display_name 优先，空则 username，统一截断 MAX_AUTHOR。

    保留署名（小马 / marvis 等）只有管理员级来源才留得住，普通用户命中时静默回退 username。
    """
    name = (user.get("display_name") or "").strip()
    if name and is_reserved_author(name) and not author_trusted(handler, conn):
        name = ""
    name = name or (user.get("username") or "").strip()
    return (name or DEFAULT_AUTHOR)[:MAX_AUTHOR]


def derive_author(handler, conn, payload: dict | None = None) -> tuple[str, str]:
    """由请求主体推导 (author, author_type)：署名不再接受客户端输入。

    payload 里的 author / author_type 一律被忽略——不校验、不比对、不报错，直接丢弃。
    推导规则（服务端唯一事实源）：
      - Cookie 会话 / 站点用户令牌（含 admin 的 adm_ 令牌）→ ('human', display_name 或 username)
      - AI 账号令牌（ak-ai-）→ ('ai', 该 AI 账号 name)
      - 通用 API Key（/admin/keys 签发的机器身份）→ ('ai', key 名)
      - 完全没有主体 → 401 unauthorized（发帖 / 评论必须有身份）
    令牌非法时 resolve_principal 已按 401 invalid_token 抛出，这里不重复判。
    """
    payload = payload or {}
    user = site_auth.current_user(handler)
    if user and user.get("status") == "active":
        return _human_author_name(handler, conn, user), "human"
    principal = resolve_principal(handler, conn)
    if principal is None:
        raise ApiError("发帖 / 评论需要登录会话或 Authorization 令牌", 401, "unauthorized")
    if principal["kind"] == "ai_account":
        # forum_ai_account 行来自 sqlite3.Row，只能按下标取值，不能用 .get
        account = principal["ai_account"]
        name = ((account["name"] if account is not None else "") or "").strip()
        return (name or DEFAULT_AUTHOR)[:MAX_AUTHOR], "ai"
    if principal["kind"] == "user":
        return _human_author_name(handler, conn, principal["user"]), "human"
    # 通用 API Key：机器身份，署名沿用 Key 名，类型记为 ai
    name = (principal.get("key_name") or "").strip()
    return (name or DEFAULT_AUTHOR)[:MAX_AUTHOR], "ai"


def author_account_id(handler, conn) -> int:
    """当前请求的 AI 账号 id（0 = 不是 AI 账号令牌）。

    与 derive_author 同一套主体解析：只有 ak-ai- 令牌会落到某个 forum_ai_account 行上，
    站点用户令牌 / Cookie 会话 / 通用机器 Key 一律返回 0。
    """
    principal = resolve_principal(handler, conn)
    if not principal or principal.get("kind") != "ai_account":
        return 0
    account = principal.get("ai_account")
    if account is None:
        return 0
    try:
        return int(account["id"])
    except (KeyError, IndexError, TypeError, ValueError):
        return 0


def assert_can_delete(handler, conn, row, actor: str, what: str) -> None:
    """删除他人内容的归属校验。

    规则（按主体强弱排序，令牌前缀不参与身份判定）：
      - 管理员站点用户（Cookie 会话 / 任一管理员名下令牌，含 adm_）→ 可删任意内容；
      - AI 账号令牌 → 只能删 ai_account_id == 自己的内容（按 id，不按署名）；
      - 普通站点用户 → 只能删自己名下（署名命中 display_name / username）的内容；
      - 通用机器 Key（/admin/keys 签发）→ 保持既有行为放行（站点级运维身份）。
    """
    user = getattr(handler, "_forum_user", None)
    account = getattr(handler, "_forum_ai_account", None)
    # AI 账号主体优先判定：keep-alive 复用 handler 时 _forum_user 可能残留上一次的登录态，
    # 不能因为「浏览器先登录过管理员」就让 AI 令牌借光（反之亦然）。
    if account is not None:
        try:
            mine_id = int(account["id"])
        except (KeyError, IndexError, TypeError, ValueError):
            mine_id = 0
        theirs = int(row["ai_account_id"] or 0)
        if mine_id and theirs == mine_id:
            return
        # 存量行（加列前发的、或署名不在账号表里）ai_account_id = 0，无从按 id 归属，
        # 对这部分只能退回署名比对，否则历史内容连本账号都删不掉。
        # 新内容一律带 id，不会走到这里，因此不影响「按 id 判归属」的收紧目标。
        if theirs == 0 and mine_id:
            names = {(account[k] or "").strip() for k in ("name", "slug") if k in account.keys()}
            if row["author_name"] in names:
                return
        raise ApiError(f"只能删除自己发布的{what}", 403, "forbidden")
    if user is None:
        user = site_auth.current_user(handler)
    if user and user.get("role") == site_auth.ROLE_ADMIN:
        return
    if actor.startswith("user:"):
        mine = {(user or {}).get("display_name") or "", (user or {}).get("username") or ""}
        mine = {n.strip() for n in mine if n and n.strip()}
        if row["author_name"] in mine:
            return
        raise ApiError(f"只能删除自己的{what}", 403, "forbidden")


def mark_author_source(payload: dict, body: dict) -> dict:
    """客户端若仍传 author / author_type，在响应里标注署名来源为服务端（便于回落排查）。"""
    if "author" in payload or "author_type" in payload:
        body["author_source"] = "server"
    return body


def log_audit(conn, actor: str, action: str, target_type: str, target_id, detail: str, handler) -> None:
    try:
        conn.execute(
            """INSERT INTO forum_audit_log (actor, action, target_type, target_id, detail, ip, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (actor, action, target_type, target_id, detail[:500], client_ip(handler), now_str()),
        )
    except sqlite3.Error:
        pass


# --------------------------------------------------------------------------- #
# 查询：板块 / 统计
# --------------------------------------------------------------------------- #

def idem_header(handler) -> str:
    """读取 Idempotency-Key（#62）：重复提交同一 key 只落一条，避免任务重跑写出双份。"""
    raw = (handler.headers.get("Idempotency-Key") or "").strip()
    if not raw:
        return ""
    if len(raw) > MAX_IDEMPOTENCY_KEY:
        raise ApiError(f"Idempotency-Key 过长（上限 {MAX_IDEMPOTENCY_KEY} 字符）", 400, "invalid_param")
    return raw


def idem_lookup(conn, handler, scope: str):
    """命中幂等键时返回 (kind, entity_id)，否则 None。"""
    key = idem_header(handler)
    if not key:
        return None
    row = conn.execute(
        "SELECT entity_kind, entity_id FROM forum_idempotency WHERE idempotency_key = ? AND scope = ?",
        (key, scope),
    ).fetchone()
    if not row:
        return None
    kind, entity_id = row["entity_kind"], row["entity_id"]
    # 命中的实体若已被删除 / 隐藏，就不能再回放「成功但指向不存在的帖子」：
    # 清掉这条陈旧记录，按新请求重新创建（否则 3 天内用同一 key 重发永远拿不到新数据）。
    if kind == "post":
        alive = conn.execute(
            "SELECT 1 FROM forum_post WHERE id = ? AND status = 'published'", (entity_id,)
        ).fetchone()
    elif kind == "comment":
        alive = conn.execute(
            "SELECT 1 FROM forum_comment WHERE id = ?", (entity_id,)
        ).fetchone()
    else:
        alive = True
    if not alive:
        conn.execute(
            "DELETE FROM forum_idempotency WHERE idempotency_key = ? AND scope = ?", (key, scope)
        )
        conn.commit()
        return None
    return (kind, entity_id)


def idem_remember(conn, handler, scope: str, kind: str, entity_id: int) -> None:
    key = idem_header(handler)
    if not key:
        return
    conn.execute(
        "INSERT OR IGNORE INTO forum_idempotency (idempotency_key, scope, entity_kind, entity_id, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (key, scope, kind, entity_id, now_str()),
    )
    # 只保留 3 天，够覆盖「同一任务被重复触发」，不让表无限长。
    cutoff = (datetime.now() - timedelta(days=3)).strftime(TZ_STAMP)
    conn.execute("DELETE FROM forum_idempotency WHERE created_at < ?", (cutoff,))


def normalize_event_key(raw) -> str:
    """事件键归一化：小写、空白转 -、只留字母数字与中文，长度上限 80。"""
    text = str(raw or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"[^0-9a-z\-_.:/\u4e00-\u9fff]", "", text)
    if len(text) > 80:
        raise ApiError("event_key 过长（上限 80 字符）", 400, "invalid_param")
    return text


def ai_budget_left(conn, handler, kind: str) -> dict | None:
    """返回当前 AI 账号的当日预算情况；非 Key 绑定账号（本机/人类）返回 None。"""
    key_id = getattr(handler, "_forum_key_id", None)
    if not key_id or kind not in ("post", "comment"):
        return None
    row = conn.execute(
        "SELECT id, name, today_date, today_posts, today_comments"
        "  FROM forum_ai_account WHERE api_key_id = ? AND is_active = 1",
        (key_id,),
    ).fetchone()
    if not row:
        return None
    today = ai_today()
    fresh = (row["today_date"] or "") == today
    used = (row["today_posts"] if kind == "post" else row["today_comments"]) if fresh else 0
    limit = AI_DAILY_POST_LIMIT if kind == "post" else AI_DAILY_COMMENT_LIMIT
    return {"account": row["name"], "used": used, "limit": limit, "left": max(limit - used, 0)}


def enforce_ai_budget(conn, handler, kind: str) -> None:
    """#62：给 author_type=ai 的写操作加每日预算，超出返回 429 而不是静默截断。"""
    info = ai_budget_left(conn, handler, kind)
    if not info or info["left"] > 0:
        return
    label = "发帖" if kind == "post" else "评论"
    raise ApiError(
        f"AI 账号「{info['account']}」今日{label}已达上限 {info['limit']} 条，"
        f"请在次日 00:00 后重试，或改用其他账号",
        429,
        "ai_budget_exceeded",
        extra={
            "kind": kind,
            "account": info["account"],
            "limit": info["limit"],
            "used": info["used"],
            "reset_at": (date.today() + timedelta(days=1)).isoformat() + "T00:00:00",
        },
    )


META_KEYS = (
    "total", "count", "total_all", "top_level", "page", "page_size", "page_size_clamped",
    "pages", "page_clamped", "limit", "limit_clamped", "has_more", "sort", "filter",
    "cursor", "next_cursor", "pinned_total", "truncated", "window", "since", "days",
    "days_clamped", "q_scope", "q_mode", "q_terms",
)


def envelope(payload: dict, items_key: str = "items") -> dict:
    """#187：给所有列表接口补统一的 data + meta。

    保留原有顶层键（items/total/page/...）不破坏老客户端，同时新增：
      data —— 载荷本体，列表接口一律放这里，客户端可写一个 unwrap()
      meta —— 分页与统计口径（total/count/page/pages/limit/...）
    """
    body = dict(payload)
    meta = {k: body[k] for k in META_KEYS if k in body}
    if items_key in body:
        meta.setdefault("count", len(body.get(items_key) or []))
    body["data"] = body.get(items_key)
    body["meta"] = meta
    return body


def list_boards(conn) -> list[dict]:
    rows = conn.execute(
        """SELECT b.id, b.slug, b.name, b.subtitle, b.description, b.icon, b.accent,
                  b.sort_order, b.is_locked, b.created_at,
                  (SELECT COUNT(*) FROM forum_post p
                    WHERE p.board_id = b.id AND p.status = 'published') AS post_count,
                  (SELECT COUNT(*) FROM forum_comment c JOIN forum_post p2 ON p2.id = c.post_id
                    WHERE p2.board_id = b.id AND c.status = 'published') AS comment_count,
                  (SELECT MAX(p3.created_at) FROM forum_post p3
                    WHERE p3.board_id = b.id AND p3.status = 'published') AS last_post_at
             FROM forum_board b
            ORDER BY b.sort_order, b.id"""
    ).fetchall()
    return [row_to_dict(r) for r in rows]


def get_stats(conn) -> dict:
    today = date.today().isoformat()
    data = {
        "boards": conn.execute("SELECT COUNT(*) FROM forum_board").fetchone()[0],
        "posts": conn.execute("SELECT COUNT(*) FROM forum_post WHERE status='published'").fetchone()[0],
        "comments": conn.execute("SELECT COUNT(*) FROM forum_comment WHERE status='published'").fetchone()[0],
        "authors": conn.execute(
            "SELECT COUNT(DISTINCT author_name) FROM forum_post WHERE status='published'"
        ).fetchone()[0],
        "tags": conn.execute("SELECT COUNT(*) FROM forum_tag").fetchone()[0],
        "today_posts": conn.execute(
            "SELECT COUNT(*) FROM forum_post WHERE status='published' AND substr(created_at,1,10)=?", (today,)
        ).fetchone()[0],
        "today_comments": conn.execute(
            "SELECT COUNT(*) FROM forum_comment WHERE status='published' AND substr(created_at,1,10)=?", (today,)
        ).fetchone()[0],
        "active_keys": conn.execute(
            "SELECT COUNT(*) FROM forum_api_key WHERE status='active'"
        ).fetchone()[0],
        "ai_posts": conn.execute(
            "SELECT COUNT(*) FROM forum_post WHERE status='published' AND author_type='ai'"
        ).fetchone()[0],
        "ai_accounts": conn.execute(
            "SELECT COUNT(*) FROM forum_ai_account WHERE is_active=1"
        ).fetchone()[0],
        "last_post_at": conn.execute(
            "SELECT MAX(created_at) FROM forum_post WHERE status='published'"
        ).fetchone()[0] or "",
        "db": FORUM_DB.name,
        "now": now_str(),
    }
    return data


# --------------------------------------------------------------------------- #
# 查询：帖子
# --------------------------------------------------------------------------- #

POST_SELECT = """
SELECT p.id, p.board_id, p.title, p.content, p.author_name, p.author_type, p.cover_url,
       p.images,
       p.status, p.is_pinned, p.is_featured, p.is_locked,
       p.resolution, p.resolved_at, p.resolution_note,
       p.view_count, p.like_count, p.comment_count, p.last_comment_at,
       p.created_at, p.updated_at,
       b.slug AS board_slug, b.name AS board_name, b.icon AS board_icon, b.accent AS board_accent,
       (SELECT GROUP_CONCAT(t.name, '||') FROM forum_post_tag pt
          JOIN forum_tag t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_csv
  FROM forum_post p
  JOIN forum_board b ON b.id = p.board_id
"""


def ensure_board_exists(conn, slug: str) -> None:
    """读取型接口的 board 过滤口径：slug 不存在时报 400，与写接口保持一致，不静默当成无匹配。"""
    row = conn.execute("SELECT 1 FROM forum_board WHERE slug = ?", (slug,)).fetchone()
    if not row:
        raise ApiError(f"板块不存在：{slug}（board 需为已存在的板块 slug）", 400, "invalid_param")


# 参数白名单：不在这份清单里的 query 参数一律 400，不再静默忽略。
POST_FILTER_PARAMS = (
    "board", "q", "tag", "tag_mode", "author",
    "sort", "page", "page_size", "since", "until",
    "resolution", "featured", "pinned", "status",
    # 游标翻页（仅 sort=new/old 且 pin_mode=inline 时可用）：避免新帖插入导致 offset 平移重复
    "cursor", "pin_mode",
)
# titles 与 posts 的 q 语义必须显式对齐：posts 搜标题+正文+作者+板块+标签，titles 只搜标题。
# 两者都在响应里回显 q_scope，且 titles 支持 q_scope=all 与 posts 等价（避免查重时结论不一致）。
TITLES_PARAMS = (
    "days", "board", "tag", "tag_mode", "q", "q_mode", "q_scope",
    "resolution", "limit", "page", "page_size",
)
COMMENT_PARAMS = ("sort", "page", "page_size", "flat")
TAG_MODES = ("any", "all")
Q_MODES = ("any", "all")
Q_SCOPES = ("title", "all")
PIN_MODES = ("front", "inline")
MAX_FILTER_TAGS = 20
# AI 账号单日发文/评论预算：超预算返回 429，不再无限刷版。
AI_DAILY_POST_LIMIT = 8
AI_DAILY_COMMENT_LIMIT = 40
MAX_IDEMPOTENCY_KEY = 80


def parse_tag_param(params: dict) -> tuple[list[str], str]:
    """解析 tag / tag_mode：tag 可逗号多值（去 # 与空项、保序去重），tag_mode=any|all。"""
    raw = scalar_param(params, "tag")
    tags: list[str] = []
    for part in raw.split(","):
        name = part.strip().lstrip("#").strip()
        if name and name not in tags:
            tags.append(name)
    if len(tags) > MAX_FILTER_TAGS:
        raise ApiError(f"tag 一次最多 {MAX_FILTER_TAGS} 个（当前 {len(tags)} 个）", 400, "invalid_param")

    mode = scalar_param(params, "tag_mode").lower() or "any"
    if mode not in TAG_MODES:
        raise ApiError(f"tag_mode 只支持 {', '.join(TAG_MODES)}（当前值：{mode}）", 400, "invalid_param")
    return tags, mode


def append_tag_filters(where: list, args: list, params: dict) -> None:
    """标签过滤：any=命中任一即可，all=必须同时具备所有标签。"""
    tags, mode = parse_tag_param(params)
    if not tags:
        return
    sub = (
        "SELECT pt.post_id FROM forum_post_tag pt JOIN forum_tag t ON t.id = pt.tag_id "
        f"WHERE t.name IN ({','.join('?' * len(tags))}) GROUP BY pt.post_id"
    )
    if mode == "all":
        sub += f" HAVING COUNT(DISTINCT t.name) = {len(tags)}"
    where.append(f"p.id IN ({sub})")
    args.extend(tags)


def parse_q_terms(params: dict) -> tuple[list[str], str]:
    """把 q 拆成词项，供 q_mode=any|all 用。

    q="打卡 签到" + q_mode=all → 标题须同时含两个词，能抓住「同一事件不同动作措辞」的重复帖；
    q_mode=any（默认）等价于原来的整串字面匹配，保持旧行为不突变。
    """
    raw = scalar_param(params, "q")
    mode = scalar_param(params, "q_mode").lower() or "any"
    if mode not in Q_MODES:
        raise ApiError(f"q_mode 只支持 {', '.join(Q_MODES)}（当前值：{mode}）", 400, "invalid_param")
    terms = [t for t in re.split(r"\s+", raw.strip()) if t]
    return terms, mode


def append_q_filters(where: list, args: list, params: dict, scope: str = "title") -> None:
    """q 过滤：scope=title 只搜标题，scope=all 与 /posts 的 q 口径一致。"""
    terms, mode = parse_q_terms(params)
    if not terms:
        return
    joiner = " AND " if mode == "all" else " OR "
    parts = []
    for term in terms:
        like = f"%{like_escape(term)}%"
        if scope == "all":
            parts.append(
                "(p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\' "
                "OR p.author_name LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\' "
                "OR p.id IN (SELECT pt.post_id FROM forum_post_tag pt JOIN forum_tag t ON t.id = pt.tag_id"
                " WHERE t.name LIKE ? ESCAPE '\\'))"
            )
            args.extend([like, like, like, like, like])
        else:
            parts.append("p.title LIKE ? ESCAPE '\\'")
            args.append(like)
    where.append("(" + joiner.join(parts) + ")")


def append_resolution_filter(where: list, args: list, params: dict) -> None:
    """resolution 过滤：posts 与 titles 共用同一口径（含 unresolved / resolved / 逗号多值）。"""
    resolution = scalar_param(params, "resolution").strip().lower()
    if not resolution or resolution in ("all", "*"):
        return
    if resolution == "unresolved":
        wanted = ["open"]
    elif resolution == "resolved":
        wanted = ["fixed", "wontfix", "duplicate"]
    else:
        wanted = [x.strip() for x in resolution.split(",") if x.strip()]
    bad = [x for x in wanted if x not in RESOLUTIONS]
    if bad or not wanted:
        raise ApiError(
            "resolution 只支持 " + ", ".join(RESOLUTIONS) + "，或 unresolved / resolved（可逗号多值）",
            400,
            "invalid_param",
        )
    where.append("p.resolution IN (%s)" % ",".join("?" * len(wanted)))
    args.extend(wanted)



def filter_echo(params: dict) -> dict:
    """回显实际生效的过滤条件，/posts、/posts/count、/posts/titles 共用同一口径。

    以前 featured/pinned/status 虽生效但不回显，调用方无法确认过滤是否被采纳（#226）。
    """
    featured = parse_bool_param(params, "featured")
    pinned = parse_bool_param(params, "pinned")
    status = scalar_param(params, "status").lower() or "published"
    return {
        "board": scalar_param(params, "board"),
        "q": scalar_param(params, "q"),
        "q_mode": scalar_param(params, "q_mode").lower() or "any",
        "q_scope": "title" if "q_scope" in params and scalar_param(params, "q_scope").lower() == "title" else "all",
        "tag": scalar_param(params, "tag"),
        "tag_mode": scalar_param(params, "tag_mode").lower() or "any",
        "author": scalar_param(params, "author"),
        "since": scalar_param(params, "since"),
        "until": scalar_param(params, "until"),
        "resolution": scalar_param(params, "resolution"),
        # 回显用真布尔而不是 "1"/"0" 字符串，否则调用方拿到 "1" 还要再判一次真假（#226）。
        "featured": "all" if featured is None else featured,
        "pinned": "all" if pinned is None else pinned,
        "pin_mode": scalar_param(params, "pin_mode").lower() or "front",
        "status": status,
    }



def build_post_filters(conn, params: dict) -> tuple[str, list]:
    reject_unknown_params(params, POST_FILTER_PARAMS, "GET /posts 与 /posts/count")
    where = ["p.status = ?"]
    args: list = ["published"]

    board = scalar_param(params, "board")
    if board:
        ensure_board_exists(conn, board)
        where.append("b.slug = ?")
        args.append(board)

    # q 按字面匹配：转义 LIKE 的通配符（\ % _），再配 ESCAPE '\'，
    # 否则搜「100%」「a_b」会被放大成全表，且 q 成了绕过 board/tag/since 的枚举入口。
    # 口径固定为 title+content+author+board+tag（回显 q_scope=all），与 /posts/titles 的差别见文档。
    append_q_filters(where, args, params, "all")

    # tag 支持逗号多值 + tag_mode=any|all
    append_tag_filters(where, args, params)

    author = scalar_param(params, "author")
    if author:
        where.append("p.author_name = ?")
        args.append(author)

    since, since_precise = parse_date_param(params, "since")
    if since:
        # 日期形式沿用字符串比较（当天零点起）；带时刻则精确到秒，左闭。
        where.append("p.created_at >= ?")
        args.append(since if since_precise else f"{since} 00:00:00")
    until, until_precise = parse_date_param(params, "until")
    if until:
        if until_precise:
            # 带时刻：右闭区间，包含该秒。
            where.append("p.created_at <= ?")
            args.append(until)
        else:
            # until 语义为「含当日」：转成次日零点做左闭右开比较。
            # 直接 `created_at <= 'YYYY-MM-DD'` 是字符串比较，会漏掉当天全部帖子
            until_exclusive = (
                date(int(until[0:4]), int(until[5:7]), int(until[8:10])) + timedelta(days=1)
            ).isoformat()
            where.append("p.created_at < ?")
            args.append(until_exclusive)

    featured = parse_bool_param(params, "featured")
    if featured is not None:
        where.append("p.is_featured = ?")
        args.append(1 if featured else 0)
    pinned = parse_bool_param(params, "pinned")
    if pinned is not None:
        where.append("p.is_pinned = ?")
        args.append(1 if pinned else 0)

    append_resolution_filter(where, args, params)

    status = scalar_param(params, "status").lower() or "published"
    if status not in ("published", "all"):
        raise ApiError(
            f"status 只支持 published / all（当前值：{status}）", 400, "invalid_param"
        )
    if status == "all":
        where[0] = "p.status <> 'deleted'"
        args[0] = "deleted"

    return " AND ".join(f"({w})" for w in where), args


def order_clause(sort: str, pin_front: bool = True) -> str:
    """排序子句。pin_front=False 时置顶帖回到时间线原位（配合 cursor 做稳定翻页）。"""
    pin = "p.is_pinned DESC, " if pin_front else ""
    if sort == "old":
        return pin + "p.created_at ASC, p.id ASC"
    if sort == "hot":
        return pin + f"{hot_expr('p')} DESC, p.id DESC"
    if sort == "active":
        return pin + "COALESCE(p.last_comment_at, p.created_at) DESC, p.id DESC"
    if sort == "views":
        return pin + "p.view_count DESC, p.id DESC"
    if sort == "replies":
        return pin + "p.comment_count DESC, p.id DESC"
    return pin + "p.created_at DESC, p.id DESC"


def post_out(row, with_content: bool = False) -> dict:
    keys = row.keys()
    resolution = (row["resolution"] or "open") if "resolution" in keys else "open"
    item = {
        "id": row["id"],
        "board": {
            "slug": row["board_slug"],
            "name": row["board_name"],
            "icon": row["board_icon"],
            "accent": row["board_accent"],
        },
        "title": row["title"],
        "excerpt": excerpt(row["content"]),
        "author": row["author_name"],
        "author_type": row["author_type"],
        "cover_url": row["cover_url"] or "",
        "images": parse_images(row["images"]) if "images" in keys else [],
        "tags": [t for t in (row["tag_csv"] or "").split("||") if t],
        "is_pinned": row["is_pinned"] == 1,
        "is_featured": row["is_featured"] == 1,
        "is_locked": row["is_locked"] == 1,
        "resolution": resolution,
        "resolution_label": RESOLUTION_LABELS.get(resolution, resolution),
        "resolved_at": (row["resolved_at"] or "") if "resolved_at" in keys else "",
        "resolution_note": (row["resolution_note"] or "") if "resolution_note" in keys else "",
        "view_count": row["view_count"],
        "like_count": row["like_count"],
        "comment_count": row["comment_count"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_comment_at": row["last_comment_at"] or row["created_at"],
        "event_key": (row["event_key"] or "") if "event_key" in keys else "",
    }
    if with_content:
        item["content"] = row["content"]
    return item


def encode_cursor(created_at: str, post_id: int) -> str:
    """(created_at, id) 二元组编码成不透明游标，供 sort=new/old 的 keyset 翻页使用。"""
    raw = f"{created_at}|{post_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(raw: str) -> tuple[str, int]:
    try:
        padded = raw + "=" * (-len(raw) % 4)
        text = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        created_at, _, pid = text.rpartition("|")
        if not created_at or not pid.lstrip("-").isdigit():
            raise ValueError
        return created_at, int(pid)
    except Exception:
        raise ApiError("cursor 不合法，请使用响应里的 next_cursor 原样回传", 400, "invalid_param")


def list_posts(conn, params: dict) -> dict:
    where_sql, args = build_post_filters(conn, params)
    sort = (params.get("sort") or "new").strip().lower()
    if sort not in SORTS:
        raise ApiError(f"sort 只支持 {', '.join(SORTS)}", 400, "invalid_param")

    page, _ = parse_int_param(params, "page", 1)
    page_size, page_size_clamped = parse_int_param(params, "page_size", 12, maximum=50)

    # #263：置顶帖默认仍排在最前（站内约定），但提供 pin_mode=inline 让它回到时间线原位，
    # 并配套 cursor 做 keyset 翻页——offset 翻页在新帖插入时会整体平移，导致同一条被读到两次。
    pin_mode = (scalar_param(params, "pin_mode").lower() or "front")
    if pin_mode not in PIN_MODES:
        raise ApiError(f"pin_mode 只支持 {', '.join(PIN_MODES)}（当前值：{pin_mode}）", 400, "invalid_param")

    cursor_raw = scalar_param(params, "cursor")
    cursor = None
    if cursor_raw:
        if sort not in ("new", "old"):
            raise ApiError("cursor 仅支持 sort=new / old（热门/活跃榜是动态排序，无稳定游标）", 400, "invalid_param")
        cursor = decode_cursor(cursor_raw)
        pin_mode = "inline"
        page = 1

    base_where = where_sql
    base_args = list(args)
    if cursor:
        created_at, last_id = cursor
        op = "<" if sort == "new" else ">"
        where_sql = (
            f"{base_where} AND (p.created_at {op} ? OR (p.created_at = ? AND p.id {op} ?))"
        )
        args = base_args + [created_at, created_at, last_id]

    total = conn.execute(
        f"SELECT COUNT(*) FROM forum_post p JOIN forum_board b ON b.id = p.board_id WHERE {base_where}",
        base_args,
    ).fetchone()[0]
    pages = max(1, (total + page_size - 1) // page_size)
    page_clamped = False
    if not cursor and page > pages:
        page, page_clamped = pages, True

    offset = 0 if cursor else (page - 1) * page_size
    rows = conn.execute(
        f"{POST_SELECT} WHERE {where_sql} ORDER BY {order_clause(sort, pin_front=(pin_mode == 'front'))} "
        f"LIMIT ? OFFSET ?",
        args + [page_size, offset],
    ).fetchall()

    next_cursor = None
    if sort in ("new", "old") and pin_mode == "inline" and rows:
        fetched = offset + len(rows)
        if fetched < total:
            next_cursor = encode_cursor(rows[-1]["created_at"], rows[-1]["id"])

    pinned_total = 0
    if pin_mode == "front":
        pinned_total = conn.execute(
            f"SELECT COUNT(*) FROM forum_post p JOIN forum_board b ON b.id = p.board_id "
            f"WHERE {base_where} AND p.is_pinned = 1",
            base_args,
        ).fetchone()[0]

    # 结帖台账：按板块统计四档口径，供列表页一眼看出「还剩几篇没修」。
    # 不受 q/tag/since 等过滤影响，避免筛掉之后把总数看成 0。
    resolution_stats = {k: 0 for k in RESOLUTIONS}
    stat_sql = (
        "SELECT p.resolution AS resolution, COUNT(*) AS n FROM forum_post p "
        "JOIN forum_board b ON b.id = p.board_id WHERE p.status = 'published'"
    )
    stat_args: list = []
    board_slug = scalar_param(params, "board")
    if board_slug:
        stat_sql += " AND b.slug = ?"
        stat_args.append(board_slug)
    stat_sql += " GROUP BY p.resolution"
    for row in conn.execute(stat_sql, stat_args):
        key = row["resolution"] or "open"
        if key in resolution_stats:
            resolution_stats[key] = row["n"]

    return {
        "items": [post_out(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "page_size_clamped": page_size_clamped,
        "page_clamped": page_clamped,
        "pages": pages,
        "sort": sort,
        "pin_mode": pin_mode,
        "pinned_total": pinned_total,
        "next_cursor": next_cursor,
        "cursor": cursor_raw,
        "resolution_stats": resolution_stats,
        "filter": filter_echo(params),
    }


def list_post_titles(conn, params: dict) -> dict:
    """标题级去重专用轻量接口。

    只返回 id / board_slug / title / created_at / resolution，默认取最近 7 个自然日
    （days 上限 90，与 /posts 的 since/until 同口径：#144 之前这里是 168 小时滚动窗口，
    与 posts 的自然日窗口对不上，导致「posts 能搜到、titles 搜不到」）。
    支持 board=slug、tag=（逗号多值 + tag_mode=any|all）、q=（配 q_mode=any|all、q_scope=title|all）、
    resolution=（与 /posts 同口径，含 unresolved/resolved 别名），以及 page/page_size 分页；
    limit 保留为兼容参数，被截断时 truncated=true 而不是静默少给（#182）。
    未知参数直接 400，不再静默忽略。
    """
    reject_unknown_params(params, TITLES_PARAMS, "GET /posts/titles")
    days, days_clamped = parse_int_param(params, "days", 7, maximum=90)
    # 自然日窗口：含今天在内往前数 days 天，从当天 00:00 起。
    since = (date.today() - timedelta(days=days - 1)).isoformat() + " 00:00:00"

    where = ["p.status = 'published'", "p.created_at >= ?"]
    args: list = [since]

    board = scalar_param(params, "board")
    if board:
        ensure_board_exists(conn, board)
        where.append("b.slug = ?")
        args.append(board)

    append_tag_filters(where, args, params)

    q_scope = scalar_param(params, "q_scope").lower() or "title"
    if q_scope not in Q_SCOPES:
        raise ApiError(
            f"q_scope 只支持 {', '.join(Q_SCOPES)}（当前值：{q_scope}）", 400, "invalid_param"
        )
    append_q_filters(where, args, params, q_scope)
    append_resolution_filter(where, args, params)

    page, _ = parse_int_param(params, "page", 1)
    if scalar_param(params, "page_size"):
        page_size, page_size_clamped = parse_int_param(params, "page_size", 200, maximum=500)
        limit, limit_clamped = page_size, page_size_clamped
    else:
        page_size, page_size_clamped = parse_int_param(params, "limit", 500, maximum=1000)
        limit, limit_clamped = page_size, page_size_clamped

    where_sql = " AND ".join(f"({w})" for w in where)
    total = conn.execute(
        f"SELECT COUNT(*) FROM forum_post p JOIN forum_board b ON b.id = p.board_id WHERE {where_sql}",
        args,
    ).fetchone()[0]

    pages = max(1, (total + page_size - 1) // page_size)
    page_clamped = False
    if page > pages:
        page, page_clamped = pages, True

    rows = conn.execute(
        f"""SELECT p.id, b.slug AS board_slug, p.title, p.created_at, p.resolution
              FROM forum_post p
              JOIN forum_board b ON b.id = p.board_id
             WHERE {where_sql}
             ORDER BY p.created_at DESC, p.id DESC
             LIMIT ? OFFSET ?""",
        args + [page_size, (page - 1) * page_size],
    ).fetchall()

    tags, tag_mode = parse_tag_param(params)
    terms, q_mode = parse_q_terms(params)
    return {
        "days": days,
        "days_clamped": days_clamped,
        "window": "natural_day",
        "since": since,
        "total": total,
        "count": len(rows),
        "truncated": total > len(rows),
        "page": page,
        "page_size": page_size,
        "page_size_clamped": page_size_clamped,
        "page_clamped": page_clamped,
        "pages": pages,
        "limit": limit,
        "limit_clamped": limit_clamped,
        "q_scope": q_scope,
        "q_mode": q_mode,
        "q_terms": terms,
        "filter": {
            "board": board,
            "tag": scalar_param(params, "tag"),
            "tags": tags,
            "tag_mode": tag_mode,
            "q": scalar_param(params, "q"),
            "q_mode": q_mode,
            "q_scope": q_scope,
            "resolution": scalar_param(params, "resolution"),
        },
        "items": [
            {
                "id": r["id"],
                "board": r["board_slug"],
                "title": r["title"],
                "created_at": r["created_at"],
                "resolution": r["resolution"] or "open",
                "resolution_label": RESOLUTION_LABELS.get(r["resolution"] or "open", "open"),
            }
            for r in rows
        ],
    }


def count_posts(conn, params: dict) -> int:
    where_sql, args = build_post_filters(conn, params)
    return conn.execute(
        f"SELECT COUNT(*) FROM forum_post p JOIN forum_board b ON b.id = p.board_id WHERE {where_sql}", args
    ).fetchone()[0]


def get_post(conn, post_id: int, count_view: bool, actor: str, only_published: bool = False,
             nav_scope: str = "board") -> dict:
    row = conn.execute(f"{POST_SELECT} WHERE p.id = ?", (post_id,)).fetchone()
    if not row:
        raise ApiError("帖子不存在", 404, "not_found")
    if only_published and row["status"] != "published":
        # 已软删除 / 隐藏的帖子对外一律视为不存在，避免泄露正文
        raise ApiError("帖子不存在", 404, "not_found")
    if count_view:
        day = date.today().isoformat()
        cur = conn.execute(
            "INSERT OR IGNORE INTO forum_post_view (post_id, actor_key, view_date, created_at) VALUES (?, ?, ?, ?)",
            (post_id, actor, day, now_str()),
        )
        if cur.rowcount:
            conn.execute("UPDATE forum_post SET view_count = view_count + 1 WHERE id = ?", (post_id,))
            conn.commit()
            row = conn.execute(f"{POST_SELECT} WHERE p.id = ?", (post_id,)).fetchone()
    item = post_out(row, with_content=True)
    item["hot_score"] = round(
        (item["like_count"] * 5 + item["comment_count"] * 8 + item["view_count"] * 0.5 + 1)
        / max(((datetime.now() - datetime.strptime(item["created_at"], TZ_STAMP)).total_seconds() / 3600) + 2, 1) ** 0.8,
        2,
    )
    # #246：prev/next 以前只看全局 id 相邻，从 site-feedback 翻下一篇会跳到 news 板块，
    # 形成跨板块断链。默认改为同板块相邻（nav=board），nav=all 可保留旧的全局行为。
    if nav_scope not in ("board", "all"):
        raise ApiError("nav 只支持 board / all", 400, "invalid_param")
    keys = row.keys()
    board_id = row["board_id"] if "board_id" in keys else None
    scoped = nav_scope == "board" and board_id is not None
    scope_sql = " AND board_id = ?" if scoped else ""
    scope_args = [board_id] if scoped else []
    item["prev_id"] = conn.execute(
        f"SELECT id FROM forum_post WHERE status='published' AND id < ?{scope_sql} ORDER BY id DESC LIMIT 1",
        [post_id] + scope_args,
    ).fetchone()
    item["next_id"] = conn.execute(
        f"SELECT id FROM forum_post WHERE status='published' AND id > ?{scope_sql} ORDER BY id ASC LIMIT 1",
        [post_id] + scope_args,
    ).fetchone()
    item["prev_id"] = item["prev_id"][0] if item["prev_id"] else None
    item["next_id"] = item["next_id"][0] if item["next_id"] else None
    item["nav_scope"] = "board" if scoped else "all"
    return item


def ensure_post_visible(conn, post_id: int, only_published: bool = False) -> None:
    """校验帖子可见性，口径与 get_post 的 only_published 一致。

    帖子不存在与 status != 'published' 均返回同一个 404 not_found，不区分，避免探测。
    """
    row = conn.execute("SELECT status FROM forum_post WHERE id = ?", (post_id,)).fetchone()
    if not row or (only_published and row["status"] != "published"):
        raise ApiError("帖子不存在", 404, "not_found")


# --------------------------------------------------------------------------- #
# 查询：评论
# --------------------------------------------------------------------------- #

COMMENT_SELECT = """
SELECT c.id, c.post_id, c.parent_id, c.root_id, c.floor_no, c.author_name, c.author_type,
       c.content, c.like_count, c.status, c.created_at, c.updated_at,
       pc.author_name AS parent_author
  FROM forum_comment c
  LEFT JOIN forum_comment pc ON pc.id = c.parent_id
"""


def comment_out(row) -> dict:
    return {
        "id": row["id"],
        "post_id": row["post_id"],
        "parent_id": row["parent_id"],
        "root_id": row["root_id"],
        "floor": row["floor_no"],
        "author": row["author_name"],
        "author_type": row["author_type"],
        "content": row["content"],
        "like_count": row["like_count"],
        "created_at": row["created_at"],
        "reply_to": row["parent_author"] or "",
        "replies": [],
    }


def comment_order(sort: str) -> str:
    if sort == "old":
        return "c.floor_no ASC, c.id ASC"
    if sort == "hot":
        return "c.like_count DESC, c.created_at ASC, c.id ASC"
    return "c.floor_no DESC, c.id DESC"


def list_comments(conn, post_id: int, params: dict, only_published: bool = False) -> dict:
    # 与 GET /posts/{id} 一致：非 published 帖（已软删除/隐藏）对外视为不存在，返回 404
    ensure_post_visible(conn, post_id, only_published=only_published)
    # #112：评论接口以前对未知参数静默忽略（page_szie 拼错毫无提示就按默认页返回），
    # 与 /posts 的口径不一致，这里统一 400 并列出可用参数。
    reject_unknown_params(params, COMMENT_PARAMS, "GET /posts/{id}/comments")

    sort = (params.get("sort") or "new").strip().lower()
    if sort not in COMMENT_SORTS:
        raise ApiError(f"sort 只支持 {', '.join(COMMENT_SORTS)}", 400, "invalid_param")
    flat = bool(parse_bool_param(params, "flat", False))
    page, _ = parse_int_param(params, "page", 1)
    page_size, page_size_clamped = parse_int_param(params, "page_size", 20, maximum=100)

    total_all = conn.execute(
        "SELECT COUNT(*) FROM forum_comment WHERE post_id = ? AND status = 'published'", (post_id,)
    ).fetchone()[0]
    top_total = conn.execute(
        "SELECT COUNT(*) FROM forum_comment WHERE post_id = ? AND status = 'published' AND parent_id IS NULL",
        (post_id,),
    ).fetchone()[0]

    if flat:
        total, pages = total_all, max(1, (total_all + page_size - 1) // page_size)
        page_clamped = page > pages
        page = min(page, pages)
        rows = conn.execute(
            f"{COMMENT_SELECT} WHERE c.post_id = ? AND c.status = 'published' "
            f"ORDER BY {comment_order(sort)} LIMIT ? OFFSET ?",
            (post_id, page_size, (page - 1) * page_size),
        ).fetchall()
        return {
            "items": [comment_out(r) for r in rows],
            "total": total,
            "total_all": total_all,
            "top_level": top_total,
            "page": page,
            "page_size": page_size,
            "page_size_clamped": page_size_clamped,
            "page_clamped": page_clamped,
            "pages": pages,
            "sort": sort,
            "flat": True,
        }

    pages = max(1, (top_total + page_size - 1) // page_size)
    page_clamped = page > pages
    page = min(page, pages)
    rows = conn.execute(
        f"{COMMENT_SELECT} WHERE c.post_id = ? AND c.status = 'published' AND c.parent_id IS NULL "
        f"ORDER BY {comment_order(sort)} LIMIT ? OFFSET ?",
        (post_id, page_size, (page - 1) * page_size),
    ).fetchall()

    items = [comment_out(r) for r in rows]
    if items:
        ids = [c["id"] for c in items]
        marks = ",".join("?" * len(ids))
        replies = conn.execute(
            f"{COMMENT_SELECT} WHERE c.post_id = ? AND c.status = 'published' "
            f"AND c.root_id IN ({marks}) ORDER BY c.created_at ASC, c.id ASC",
            [post_id] + ids,
        ).fetchall()
        bucket = {c["id"]: c for c in items}
        for r in replies:
            node = bucket.get(r["root_id"])
            if node is not None:
                node["replies"].append(comment_out(r))

    return {
        "items": items,
        "total": top_total,
        "total_all": total_all,
        "top_level": top_total,
        "page": page,
        "page_size": page_size,
        "page_size_clamped": page_size_clamped,
        "page_clamped": page_clamped,
        "pages": pages,
        "sort": sort,
        "flat": False,
    }


def comment_count(conn, post_id: int, only_published: bool = False) -> dict:
    # 与 GET /posts/{id}、/posts/{id}/comments 一致：非 published 帖对外视为不存在
    ensure_post_visible(conn, post_id, only_published=only_published)
    total = conn.execute(
        "SELECT COUNT(*) FROM forum_comment WHERE post_id = ? AND status = 'published'", (post_id,)
    ).fetchone()[0]
    top = conn.execute(
        "SELECT COUNT(*) FROM forum_comment WHERE post_id = ? AND status = 'published' AND parent_id IS NULL",
        (post_id,),
    ).fetchone()[0]
    return {"post_id": post_id, "total": total, "top_level": top}


# --------------------------------------------------------------------------- #
# 写入：发帖 / 评论 / 点赞 / 浏览
# --------------------------------------------------------------------------- #

def resolve_board(conn, key: str) -> sqlite3.Row:
    key = (key or "").strip()
    if not key:
        raise ApiError("board 不能为空（板块 slug）", 400, "invalid_param")
    row = conn.execute("SELECT * FROM forum_board WHERE slug = ?", (key,)).fetchone()
    if not row and key.isdigit():
        row = conn.execute("SELECT * FROM forum_board WHERE id = ?", (int(key),)).fetchone()
    if not row:
        raise ApiError(f"板块不存在：{key}（board 需为已存在的板块 slug）", 400, "invalid_param")
    if row["is_locked"]:
        raise ApiError(f"板块「{row['name']}」已锁定，暂时不能发帖", 403, "board_locked")
    return row


def sync_tags(conn, post_id: int, tags: list[str]) -> None:
    conn.execute("DELETE FROM forum_post_tag WHERE post_id = ?", (post_id,))
    for tag in tags:
        conn.execute("INSERT OR IGNORE INTO forum_tag (name) VALUES (?)", (tag,))
        row = conn.execute("SELECT id FROM forum_tag WHERE name = ?", (tag,)).fetchone()
        conn.execute(
            "INSERT OR IGNORE INTO forum_post_tag (post_id, tag_id) VALUES (?, ?)", (post_id, row["id"])
        )
    conn.execute(
        "UPDATE forum_tag SET use_count = (SELECT COUNT(*) FROM forum_post_tag pt WHERE pt.tag_id = forum_tag.id)"
    )


def create_post(conn, payload: dict, actor: str, handler) -> dict:
    # #62 幂等键：同一 Idempotency-Key 在 3 天内重复提交，直接回首次结果，不再落新帖。
    hit = idem_lookup(conn, handler, "post")
    if hit:
        kind, entity_id = hit
        replay = get_post(conn, entity_id, False, "system")
        replay["idempotent_replay"] = True
        return replay

    board = resolve_board(conn, payload.get("board") or payload.get("board_slug") or "")
    title = clean_text(payload.get("title"), "title", MAX_TITLE)
    content = clean_text(payload.get("content"), "content", MAX_CONTENT)
    author, author_type = derive_author(handler, conn, payload)   # 署名由服务端按令牌推导
    ai_account_id = author_account_id(handler, conn)             # AI 密钥发帖 → 归属该账号
    tags = normalize_tags(payload.get("tags"))
    cover = clean_text(payload.get("cover_url"), "cover_url", 500, required=False)
    images = clean_images(payload.get("images"))
    event_key = normalize_event_key(payload.get("event_key"))

    # #133：同一事件已有帖时，标题字面几乎必然不同（「减审核版」vs「权重落地」），
    # 靠标题相似度挡不住。event_key 命中直接 409 并把原帖 id 带回去，让调用方去追加进展。
    if event_key:
        dup = conn.execute(
            "SELECT id, title FROM forum_post WHERE event_key = ? AND status = 'published'"
            " ORDER BY id DESC LIMIT 1",
            (event_key,),
        ).fetchone()
        if dup:
            raise ApiError(
                f"event_key「{event_key}」已对应 #{dup['id']}《{dup['title']}》，"
                "同一事件请到原帖追加评论或更新进展，不要另开新帖",
                409,
                "duplicate_event",
                extra={"event_key": event_key, "existing_post_id": dup["id"]},
            )

    enforce_ai_budget(conn, handler, "post")

    stamp = now_str()
    cur = conn.execute(
        """INSERT INTO forum_post
           (board_id, title, content, author_name, author_type, ai_account_id, cover_url, images, status,
            is_pinned, is_featured, is_locked, view_count, like_count, comment_count,
            last_comment_at, created_at, updated_at, event_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', 0, 0, 0, 0, 0, 0, NULL, ?, ?, ?)""",
        (board["id"], title, content, author, author_type, ai_account_id, cover,
         json.dumps(images, ensure_ascii=False), stamp, stamp, event_key),
    )
    post_id = cur.lastrowid
    sync_tags(conn, post_id, tags)
    bump_ai_account(conn, getattr(handler, "_forum_key_id", None), "post")
    idem_remember(conn, handler, "post", "post", post_id)
    log_audit(conn, actor, "create_post", "post", post_id,
              f"{board['slug']} / {title} / author={author} / type={author_type}"
              + (f" / event={event_key}" if event_key else "")
              + (f" / images={len(images)}" if images else ""), handler)
    conn.commit()
    return mark_author_source(payload, get_post(conn, post_id, False, "system"))


def create_comment(conn, post_id: int, payload: dict, actor: str, handler) -> dict:
    # #62 幂等键：评论同样支持，避免任务重跑在同一帖里刷出重复楼层。
    hit = idem_lookup(conn, handler, f"comment:{post_id}")
    if hit:
        kind, entity_id = hit
        row = conn.execute(f"{COMMENT_SELECT} WHERE c.id = ?", (entity_id,)).fetchone()
        if row:
            replay = comment_out(row)
            replay["idempotent_replay"] = True
            return replay

    post = conn.execute(
        "SELECT id, is_locked, status, resolution FROM forum_post WHERE id = ?", (post_id,)
    ).fetchone()
    if not post or post["status"] != "published":
        raise ApiError("帖子不存在", 404, "not_found")
    if post["is_locked"]:
        # 结帖与人工锁定共用 is_locked，但错误码分开，调用方能区分「别再来追加了」和「被管理员锁了」。
        resolution = post["resolution"] or "open"
        if resolution != "open":
            raise ApiError(
                f"该帖已结帖（{RESOLUTION_LABELS.get(resolution, resolution)}），不再接受新评论；"
                "如有新问题请另开一帖",
                403,
                "post_resolved",
            )
        raise ApiError("该帖已锁定，不能继续评论", 403, "post_locked")

    content = clean_text(payload.get("content"), "content", MAX_COMMENT)
    author, author_type = derive_author(handler, conn, payload)   # 署名由服务端按令牌推导
    ai_account_id = author_account_id(handler, conn)             # AI 密钥评论 → 归属该账号

    parent_id, root_id, floor_no = None, None, 0
    raw_parent = payload.get("parent_id") or payload.get("reply_to")
    if raw_parent not in (None, "", 0, "0"):
        try:
            pid = int(raw_parent)
        except (TypeError, ValueError):
            raise ApiError("parent_id 必须是整数", 400, "invalid_param")
        parent = conn.execute(
            "SELECT id, post_id, parent_id, root_id FROM forum_comment WHERE id = ?", (pid,)
        ).fetchone()
        if not parent or parent["post_id"] != post_id:
            raise ApiError("被回复的评论不存在于该帖", 400, "invalid_parent")
        parent_id = parent["id"]
        root_id = parent["root_id"] or parent["id"]
    else:
        floor_no = (conn.execute(
            "SELECT COALESCE(MAX(floor_no), 0) + 1 FROM forum_comment WHERE post_id = ?", (post_id,)
        ).fetchone()[0]) or 1

    enforce_ai_budget(conn, handler, "comment")

    stamp = now_str()
    cur = conn.execute(
        """INSERT INTO forum_comment
           (post_id, parent_id, root_id, floor_no, author_name, author_type, ai_account_id,
            content, like_count, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'published', ?, ?)""",
        (post_id, parent_id, root_id, floor_no, author, author_type, ai_account_id, content, stamp, stamp),
    )
    comment_id = cur.lastrowid
    bump_ai_account(conn, getattr(handler, "_forum_key_id", None), "comment")
    idem_remember(conn, handler, f"comment:{post_id}", "comment", comment_id)
    log_audit(conn, actor, "create_comment", "comment", comment_id,
              f"post={post_id} / author={author} / type={author_type}", handler)
    conn.commit()

    row = conn.execute(f"{COMMENT_SELECT} WHERE c.id = ?", (comment_id,)).fetchone()
    return mark_author_source(payload, comment_out(row))


def like_post(conn, post_id: int, actor_key: str, handler) -> dict:
    if not conn.execute("SELECT 1 FROM forum_post WHERE id = ? AND status='published'", (post_id,)).fetchone():
        raise ApiError("帖子不存在", 404, "not_found")
    cur = conn.execute(
        "INSERT OR IGNORE INTO forum_post_like (post_id, actor_key, created_at) VALUES (?, ?, ?)",
        (post_id, actor_key, now_str()),
    )
    conn.commit()
    likes = conn.execute("SELECT like_count FROM forum_post WHERE id = ?", (post_id,)).fetchone()[0]
    return {"post_id": post_id, "liked": cur.rowcount > 0, "like_count": likes}


def unlike_post(conn, post_id: int, actor_key: str) -> dict:
    cur = conn.execute(
        "DELETE FROM forum_post_like WHERE post_id = ? AND actor_key = ?", (post_id, actor_key)
    )
    conn.commit()
    likes = conn.execute("SELECT like_count FROM forum_post WHERE id = ?", (post_id,)).fetchone()[0]
    return {"post_id": post_id, "unliked": cur.rowcount > 0, "like_count": likes}


def like_comment(conn, comment_id: int, actor_key: str) -> dict:
    if not conn.execute("SELECT 1 FROM forum_comment WHERE id = ? AND status='published'", (comment_id,)).fetchone():
        raise ApiError("评论不存在", 404, "not_found")
    cur = conn.execute(
        "INSERT OR IGNORE INTO forum_comment_like (comment_id, actor_key, created_at) VALUES (?, ?, ?)",
        (comment_id, actor_key, now_str()),
    )
    conn.commit()
    likes = conn.execute("SELECT like_count FROM forum_comment WHERE id = ?", (comment_id,)).fetchone()[0]
    return {"comment_id": comment_id, "liked": cur.rowcount > 0, "like_count": likes}


def record_view(conn, post_id: int, actor_key: str) -> dict:
    if not conn.execute("SELECT 1 FROM forum_post WHERE id = ?", (post_id,)).fetchone():
        raise ApiError("帖子不存在", 404, "not_found")
    cur = conn.execute(
        "INSERT OR IGNORE INTO forum_post_view (post_id, actor_key, view_date, created_at) VALUES (?, ?, ?, ?)",
        (post_id, actor_key, date.today().isoformat(), now_str()),
    )
    if cur.rowcount:
        conn.execute("UPDATE forum_post SET view_count = view_count + 1 WHERE id = ?", (post_id,))
        conn.commit()
    views = conn.execute("SELECT view_count FROM forum_post WHERE id = ?", (post_id,)).fetchone()[0]
    return {"post_id": post_id, "counted": cur.rowcount > 0, "view_count": views}


# --------------------------------------------------------------------------- #
# API Key 管理
# --------------------------------------------------------------------------- #

def list_keys(conn) -> list[dict]:
    rows = conn.execute(
        """SELECT id, name, key_prefix, scopes, note, status, usage_count, last_used_at, created_at
             FROM forum_api_key ORDER BY id DESC"""
    ).fetchall()
    out = []
    for r in rows:
        item = row_to_dict(r)
        item["masked"] = item["key_prefix"] + "••••••••••••"
        out.append(item)
    return out


def create_key(conn, payload: dict, handler) -> dict:
    name = clean_text(payload.get("name") or "未命名 Key", "name", 60)
    scopes_raw = payload.get("scopes") or "post,comment"
    if isinstance(scopes_raw, (list, tuple)):
        scopes = [str(s).strip() for s in scopes_raw if str(s).strip()]
    else:
        scopes = [s.strip() for s in str(scopes_raw).split(",") if s.strip()]
    allowed = {"post", "comment", "read", "admin", "*"}
    bad = [s for s in scopes if s not in allowed]
    if bad:
        raise ApiError(f"不支持的 scope：{', '.join(bad)}（可选 post/comment/read/admin/*）", 400, "invalid_param")
    note = clean_text(payload.get("note"), "note", 200, required=False)

    raw = API_KEY_PREFIX + secrets.token_hex(20)
    conn.execute(
        """INSERT INTO forum_api_key (name, key_prefix, key_hash, scopes, note, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)""",
        (name, raw[:KEY_PREFIX_SHOW], api_key_hash(raw), ",".join(scopes) or "post,comment", note, now_str()),
    )
    log_audit(conn, "admin", "create_key", "api_key", None, name, handler)
    conn.commit()
    row = conn.execute(
        "SELECT id, name, scopes, created_at FROM forum_api_key WHERE key_hash = ?", (api_key_hash(raw),)
    ).fetchone()
    return {
        "id": row["id"],
        "name": row["name"],
        "scopes": row["scopes"],
        "created_at": row["created_at"],
        "key": raw,
        "hint": "密钥只在本次生成时返回，请立即保存；后续只能看到前缀。",
    }


def revoke_key(conn, key_id: int) -> dict:
    cur = conn.execute(
        "UPDATE forum_api_key SET status = 'revoked' WHERE id = ? AND status = 'active'", (key_id,)
    )
    conn.commit()
    if not cur.rowcount:
        raise ApiError("Key 不存在或已吊销", 404, "not_found")
    return {"id": key_id, "status": "revoked"}


# --------------------------------------------------------------------------- #
# AI 账号体系
# --------------------------------------------------------------------------- #

AI_LEVELS = ("新手", "熟练", "资深", "权威")
# AI 账号类型（account_type 列，枚举值）：
#   1 = 论坛 AI       —— 原有人设池，用于在论坛板块发帖/评论
#   2 = 小说 AI 作者  —— 归属某个站长的写作用画像，用于小说板块创作
AI_ACCOUNT_TYPE_FORUM = 1
AI_ACCOUNT_TYPE_NOVEL = 2
AI_ACCOUNT_TYPES = (AI_ACCOUNT_TYPE_FORUM, AI_ACCOUNT_TYPE_NOVEL)
AI_ACCOUNT_TYPE_LABELS = {
    AI_ACCOUNT_TYPE_FORUM: "论坛AI",
    AI_ACCOUNT_TYPE_NOVEL: "小说AI作者",
}
AI_ACCOUNT_TYPE_DEFAULT = AI_ACCOUNT_TYPE_FORUM
# 定时任务用这枚 Key 既要发帖评论，也要能署 author_type=ai / 走管理接口，
# 所以 scopes 固定带 admin（author_trusted 判据之一是 scopes 含 admin）。
AI_KEY_SCOPES = "post,comment,admin"
# 用户自建 AI 画像的 Key 只给发帖/评论，不给 admin：admin 是「可信署名/管理接口」的判据，
# 不能让普通用户通过自建账号间接拿到。署名改为「Key 绑定 AI 账号自动署名」实现。
USER_AI_KEY_SCOPES = "post,comment"
# 每个用户最多自建多少个 AI 画像（超出需先停用旧的）
# 40：小说板块按题材铺开多个 AI 作者后，20 个上限不够用（论坛 AI + 小说作者共用同一配额）
MAX_USER_AI_ACCOUNTS = 40
# 统一令牌协议：用户令牌与 AI Key 都只经 Authorization 传输，旧的 X-User-Token /
# X-API-Key / X-Admin-Token 三个指向性 header 已废弃，服务端不再读取。
AI_ACCOUNT_COLUMNS = (
    "id, slug, name, avatar, level, account_type, persona, experience, speaking_style, prompt, "
    "expertise, interest, "
    "owner_user_id, "
    "api_key_id, api_key, today_date, today_posts, today_comments, total_posts, total_comments, "
    "last_post_at, last_comment_at, is_active, created_at, updated_at"
)

# 取号冷却：同一个 AI 账号在被随机取号返回之后，窗口期内不再参与抽签。
# 目的是让并行跑的两个定时任务（37 分钟 / 77 分钟）不会撞到同一个作者，
# 从而不会往同一本书里并发写重复章节。纯进程内内存态，重启即清空，不落盘。
PICK_COOLDOWN_SECONDS = 30 * 60
_pick_cooldown: dict[int, float] = {}
_pick_lock = threading.Lock()


def _pick_prune(now: float) -> None:
    """清掉已经过期的冷却记录（只在持锁时调用）。"""
    for aid, ts in list(_pick_cooldown.items()):
        if now - ts >= PICK_COOLDOWN_SECONDS:
            del _pick_cooldown[aid]


def pick_cooldown_state() -> dict:
    """给接口回显用：窗口长度 + 当前正在冷却的账号数。"""
    with _pick_lock:
        now = time.time()
        _pick_prune(now)
        return {"seconds": PICK_COOLDOWN_SECONDS, "held": len(_pick_cooldown)}


def _pick_account_row(conn, where: list, args: list, cooldown: bool = True):
    """在候选集合里抽一个账号，并保证同一账号窗口期内不重复被返回。

    返回 (row, relaxed)：relaxed=True 表示候选池整体都在冷却里，只能退让取
    「最久没用过」的那个（宁可直接用，也不让调用方空手而归）。
    """
    sql = f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE {' AND '.join(where)}"
    now = time.time()
    with _pick_lock:
        rows = conn.execute(sql, tuple(args)).fetchall()
        if not rows:
            return None, False
        if not cooldown:
            return rows[secrets.randbelow(len(rows))], False
        _pick_prune(now)
        fresh = [r for r in rows if r["id"] not in _pick_cooldown]
        if fresh:
            row = fresh[secrets.randbelow(len(fresh))]
            _pick_cooldown[row["id"]] = now
            return row, False
        row = min(rows, key=lambda r: _pick_cooldown.get(r["id"], 0.0))
        _pick_cooldown[row["id"]] = now
        return row, True


def ai_today() -> str:
    """当日计数口径：本地自然日（YYYY-MM-DD），与 created_at 的本地时间同一时区。"""
    return date.today().isoformat()


def ai_expertise_list(conn, raw: str) -> list[dict]:
    """把 "tech-wish,ai-corner" 还原成 [{slug, name}]，板块删了也保留原 slug 不报错。"""
    slugs = [s.strip() for s in (raw or "").split(",") if s.strip()]
    if not slugs:
        return []
    names = {r["slug"]: r["name"] for r in conn.execute("SELECT slug, name FROM forum_board").fetchall()}
    return [{"slug": s, "name": names.get(s, s)} for s in slugs]


def ai_interest_list(raw) -> list[str]:
    """interest 列存 JSON 数组字符串，读出来还原成字符串列表。

    容错三种历史形态：NULL/空串 → []；JSON 数组 → 原样(去重去空)；漏引号的逗号串 → 按逗号切。
    """
    if isinstance(raw, (list, tuple)):
        return [str(x).strip() for x in raw if str(x).strip()]
    text = (raw or "").strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, list):
            out = []
            for x in data:
                s = str(x).strip()
                if s and s not in out:
                    out.append(s)
            return out
    return [s.strip() for s in text.split(",") if s.strip()]


def ai_account_type(value, default: int = AI_ACCOUNT_TYPE_DEFAULT, strict: bool = False) -> int:
    """把入参归一成 account_type 枚举值（1=论坛AI，2=小说AI作者）。

    strict=True 时非法值直接报错（用户显式传了但不认识），否则回落到 default，
    便于老调用方不传该字段时保持「论坛AI」的历史语义。
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        num = int(str(value).strip())
    except (TypeError, ValueError):
        if strict:
            raise ApiError("账号类型只能是 1（论坛AI）或 2（小说AI作者）", 400, "invalid_account_type")
        return default
    if num not in AI_ACCOUNT_TYPES:
        if strict:
            raise ApiError("账号类型只能是 1（论坛AI）或 2（小说AI作者）", 400, "invalid_account_type")
        return default
    return num


def ai_account_type_label(value) -> str:
    """枚举值转中文标签，未知值原样兜底为「论坛AI」。"""
    return AI_ACCOUNT_TYPE_LABELS.get(ai_account_type(value), AI_ACCOUNT_TYPE_LABELS[AI_ACCOUNT_TYPE_DEFAULT])


def issue_ai_key(conn, slug: str, name: str, scopes: str = AI_KEY_SCOPES) -> tuple:
    """给 AI 账号签发一枚令牌：forum_api_key 只存 sha256，明文返回给调用方落库。

    统一令牌协议下 AI 账号令牌固定 ak-ai- 前缀，服务端据此直接分流到 AI 账号校验，
    不再需要「先当 API Key 查一遍、查不到再 401」的兜底逻辑。
    """
    raw = AI_KEY_PREFIX + secrets.token_hex(20)
    cur = conn.execute(
        """INSERT INTO forum_api_key (name, key_prefix, key_hash, scopes, note, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)""",
        (f"ai:{slug}", raw[:KEY_PREFIX_SHOW], api_key_hash(raw), scopes, f"AI 账号 {name} 自动签发", now_str()),
    )
    key_id = cur.lastrowid
    try:
        conn.execute(
            """INSERT INTO forum_audit_log (actor, action, target_type, target_id, detail, ip, created_at)
               VALUES ('system', 'create_key', 'api_key', ?, ?, '', ?)""",
            (key_id, f"ai:{slug} / auto-issued", now_str()),
        )
    except sqlite3.Error:
        pass
    return key_id, raw


def ai_seed_interests(item: dict) -> str:
    """把种子里的 interests 归一化成 JSON 数组字符串（去空、去重、保序）。"""
    tags = item.get("interests")
    if tags is None:
        tags = item.get("interest")
    if isinstance(tags, str):
        tags = [s.strip() for s in tags.split(",")]
    out = []
    for x in (tags or []):
        s = str(x).strip()
        if s and s not in out:
            out.append(s)
    return json.dumps(out, ensure_ascii=False)


def seed_ai_accounts(conn) -> tuple:
    """导入人设池并补齐缺失 Key，返回 (新增账号数, 新签发 Key 数, 回填兴趣数)。

    幂等：表里已有账号时不覆盖人设（线上手改过的人设优先），只为 api_key 为空的补签；
    老库补出 interest 列后已有账号是空数组，按 slug 对种子回填兴趣标签（只补空，不覆盖手改）。
    """
    seed_items = []
    if AI_ACCOUNT_SEED_FILE.exists():
        try:
            data = json.loads(AI_ACCOUNT_SEED_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        seed_items = [it for it in (data.get("accounts") or [])
                      if str(it.get("slug") or "").strip() and str(it.get("name") or "").strip()]

    seeded = 0
    if (conn.execute("SELECT COUNT(*) FROM forum_ai_account").fetchone()[0] == 0 and seed_items):
        stamp = now_str()
        for item in seed_items:
            slug = str(item.get("slug") or "").strip()
            name = str(item.get("name") or "").strip()
            expertise = item.get("expertise") or []
            if isinstance(expertise, (list, tuple)):
                expertise = ",".join(str(x).strip() for x in expertise if str(x).strip())
            # 种子文件可带 account_type（缺省 1=论坛AI）；非法值按默认处理，不阻断导入
            acc_type = ai_account_type(item.get("account_type"))
            cur = conn.execute(
                """INSERT OR IGNORE INTO forum_ai_account
                   (slug, name, avatar, level, account_type, persona, experience, speaking_style,
                    prompt, expertise, interest, owner_user_id, today_date, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
                (slug, name, str(item.get("avatar") or ""), str(item.get("level") or "熟练"),
                 acc_type,
                 str(item.get("persona") or ""), str(item.get("experience") or ""),
                 str(item.get("speaking_style") or ""), str(item.get("prompt") or ""),
                 str(expertise), ai_seed_interests(item), ai_today(), stamp, stamp),
            )
            seeded += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0

    # 兴趣回填：只补 interest 为空的账号，已有标签不动（尊重线上改过的兴趣）
    backfilled = 0
    if seed_items:
        wanted = {str(it["slug"]).strip(): ai_seed_interests(it) for it in seed_items}
        rows = conn.execute("SELECT id, slug, interest FROM forum_ai_account").fetchall()
        for r in rows:
            if ai_interest_list(r["interest"]):
                continue
            tags = wanted.get(r["slug"])
            if not tags or tags == "[]":
                continue
            conn.execute(
                "UPDATE forum_ai_account SET interest = ?, updated_at = ? WHERE id = ?",
                (tags, now_str(), r["id"]),
            )
            backfilled += 1

    issued = 0
    rows = conn.execute(
        "SELECT id, slug, name FROM forum_ai_account WHERE api_key IS NULL OR api_key = ''"
    ).fetchall()
    for r in rows:
        key_id, raw = issue_ai_key(conn, r["slug"], r["name"])
        conn.execute(
            "UPDATE forum_ai_account SET api_key_id = ?, api_key = ?, updated_at = ? WHERE id = ?",
            (key_id, raw, now_str(), r["id"]),
        )
        issued += 1
    return seeded, issued, backfilled


def ensure_ai_account_key(conn, row, scopes: str = AI_KEY_SCOPES) -> None:
    """绑定 Key 缺失或已吊销时补签一枚，保证接口给出的永远是可用的 Key。

    scopes 必须按账号归属传：公共池账号用 AI_KEY_SCOPES（含 admin，供定时任务署 ai 名），
    用户自建账号用 USER_AI_KEY_SCOPES（只给 post/comment），避免普通用户间接拿到 admin。
    """
    status = ""
    if row["api_key_id"]:
        found = conn.execute("SELECT status FROM forum_api_key WHERE id = ?", (row["api_key_id"],)).fetchone()
        status = found["status"] if found else ""
    if status == "active" and row["api_key"]:
        return
    key_id, raw = issue_ai_key(conn, row["slug"], row["name"], scopes=scopes)
    conn.execute(
        "UPDATE forum_ai_account SET api_key_id = ?, api_key = ?, updated_at = ? WHERE id = ?",
        (key_id, raw, now_str(), row["id"]),
    )
    conn.commit()


def roll_ai_account_day(conn, account_id: int) -> bool:
    """跨天滚动：today_date 不是今天就把当日计数清零并写回，读侧写侧共用同一口径。"""
    today = ai_today()
    cur = conn.execute(
        """UPDATE forum_ai_account
              SET today_date = ?, today_posts = 0, today_comments = 0
            WHERE id = ? AND (today_date IS NULL OR today_date <> ?)""",
        (today, account_id, today),
    )
    if cur.rowcount:
        conn.commit()
        return True
    return False


def bump_ai_account(conn, key_id, kind: str) -> bool:
    """发帖/评论后按 Key 反查 AI 账号累加计数。跨天先清零当日计数，只记本机自然日。

    挂在 forum_ai_account.api_key_id 上而不是署名上：名字可改、也可能撞名，Key 才是稳定身份。
    """
    if not key_id or kind not in ("post", "comment"):
        return False
    row = conn.execute(
        "SELECT id, today_date FROM forum_ai_account WHERE api_key_id = ? AND is_active = 1", (key_id,)
    ).fetchone()
    if not row:
        return False
    today, stamp = ai_today(), now_str()
    if (row["today_date"] or "") != today:
        conn.execute(
            "UPDATE forum_ai_account SET today_date = ?, today_posts = 0, today_comments = 0 WHERE id = ?",
            (today, row["id"]),
        )
    if kind == "post":
        conn.execute(
            """UPDATE forum_ai_account
                  SET today_date = ?, today_posts = today_posts + 1, total_posts = total_posts + 1,
                      last_post_at = ?, updated_at = ?
                WHERE id = ?""",
            (today, stamp, stamp, row["id"]),
        )
    else:
        conn.execute(
            """UPDATE forum_ai_account
                  SET today_date = ?, today_comments = today_comments + 1, total_comments = total_comments + 1,
                      last_comment_at = ?, updated_at = ?
                WHERE id = ?""",
            (today, stamp, stamp, row["id"]),
        )
    return True


def ai_account_out(conn, row, reveal: bool = True) -> dict:
    """账号完整画像：人设 + 提示词 + 当日/历史统计 + 可用 Key + 调用方式。

    is_shared_pool 语义（统一令牌改造后重写）：True 仅表示「系统公共池账号」即
    owner_user_id = 0、不属于任何管理员的账号；管理员名下账号为 False，普通用户自建
    账号同样为 False（普通用户的账号永远不进取号池，见 random_ai_account）。
    该字段只用于前端/文档的归属展示，服务端没有任何分支依赖它。
    """
    key = None
    if row["api_key_id"]:
        key = conn.execute(
            """SELECT id, name, key_prefix, scopes, status, usage_count, last_used_at
                 FROM forum_api_key WHERE id = ?""",
            (row["api_key_id"],),
        ).fetchone()
    raw = row["api_key"] or ""
    shown = raw if reveal else ((raw[:KEY_PREFIX_SHOW] + "••••••••••••") if raw else "")
    today = ai_today()
    fresh = (row["today_date"] or "") == today
    stats = {
        "today": today,
        "today_posts": row["today_posts"] if fresh else 0,
        "today_comments": row["today_comments"] if fresh else 0,
        "total_posts": row["total_posts"],
        "total_comments": row["total_comments"],
        "last_post_at": row["last_post_at"],
        "last_comment_at": row["last_comment_at"],
    }
    return {
        "id": row["id"],
        "slug": row["slug"],
        "name": row["name"],
        "avatar": row["avatar"],
        "level": row["level"],
        "account_type": ai_account_type(row["account_type"]),
        "account_type_label": ai_account_type_label(row["account_type"]),
        "is_novel_author": ai_account_type(row["account_type"]) == AI_ACCOUNT_TYPE_NOVEL,
        "owner_user_id": row["owner_user_id"],
        "is_shared_pool": not row["owner_user_id"],
        "persona": row["persona"],
        "experience": row["experience"],
        "speaking_style": row["speaking_style"],
        "prompt": row["prompt"],
        "expertise": ai_expertise_list(conn, row["expertise"]),
        "interests": ai_interest_list(row["interest"]),
        "statistics": stats,
        "api_key": shown,
        "key": {
            "id": key["id"] if key else None,
            "prefix": key["key_prefix"] if key else "",
            "scopes": key["scopes"] if key else "",
            "status": key["status"] if key else "missing",
            "usage_count": key["usage_count"] if key else 0,
            "last_used_at": key["last_used_at"] if key else "",
        },
        "usage": {
            "post": "POST /api/forum/posts",
            "comment": "POST /api/forum/posts/{post_id}/comments",
            "headers": {"Authorization": f"Bearer {shown}", "Content-Type": "application/json"},
            "author": row["name"],
            "author_type": "ai",
            "note": "署名与 author_type 由服务端按该 Key 绑定的 AI 账号自动推导，"
                    "请求体里再传 author / author_type 会被忽略；当日计数按本机自然日滚动。",
        },
    }


def random_ai_account(conn, slug: str = "", exclude: str = "", reveal: bool = True,
                      pool_owner_id: int = 0, account_type=None) -> dict:
    """随机取一个启用中的 AI 账号。

    池 = 系统公共池（owner_user_id = 0）+ 指定管理员名下账号（pool_owner_id > 0）。
    pool_owner_id = 0 时退化为「只取公共池」，与改造前行为完全一致；
    普通用户自建的 AI 账号（owner_user_id 为其它用户 id）永远不进池。
    """
    try:
        owner_id = int(pool_owner_id or 0)
    except (TypeError, ValueError):
        owner_id = 0
    if owner_id < 0:
        owner_id = 0

    total = conn.execute(
        "SELECT COUNT(*) FROM forum_ai_account WHERE is_active = 1 AND owner_user_id IN (0, ?)",
        (owner_id,),
    ).fetchone()[0]
    if account_type is not None:
        total = int(conn.execute(
            "SELECT COUNT(*) FROM forum_ai_account"
            " WHERE is_active = 1 AND owner_user_id IN (0, ?) AND account_type = ?",
            (owner_id, int(account_type)),
        ).fetchone()[0])
    if not total:
        raise ApiError("AI 账号池为空，请先执行 init_db 导入人设", 404, "no_ai_account")

    where, args = ["is_active = 1", "owner_user_id IN (0, ?)"], [owner_id]
    if account_type is not None:
        where.append("account_type = ?")
        args.append(int(account_type))
    picked = ""
    if slug:
        where.append("slug = ?")
        args.append(slug)
    else:
        picked = slug
        ex = [s.strip() for s in (exclude or "").split(",") if s.strip()]
        if ex:
            where.append(f"slug NOT IN ({','.join('?' * len(ex))})")
            args.extend(ex)
    row = None
    relaxed = False
    if slug:
        # 点名叫号（详情/自检用）不参与冷却，也不占用冷却名额
        row = conn.execute(
            f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE {' AND '.join(where)}",
            tuple(args),
        ).fetchone()
    else:
        row, relaxed = _pick_account_row(conn, where, args)
    if not row and not slug:
        # exclude 把同类型池子排空了：退回同类型全池随机，不让调用方空手而归
        recover_where, recover_args = ["is_active = 1", "owner_user_id IN (0, ?)"], [owner_id]
        if account_type is not None:
            recover_where.append("account_type = ?")
            recover_args.append(int(account_type))
        row, relaxed = _pick_account_row(conn, recover_where, recover_args)
    if not row:
        raise ApiError(f"AI 账号不存在：{slug}", 404, "not_found")

    roll_ai_account_day(conn, row["id"])
    ensure_ai_account_key(conn, row)
    row = conn.execute(
        f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE id = ?", (row["id"],)
    ).fetchone()
    return {
        "account": ai_account_out(conn, row, reveal=reveal),
        "pool": {
            "total": total,
            "active": total,
            "pool_owner": owner_id,
            "today": ai_today(),
            "requested_slug": picked or slug,
            "excluded": [s.strip() for s in (exclude or "").split(",") if s.strip()],
            "cooldown": {**pick_cooldown_state(), "relaxed": relaxed},
        },
    }


def mask_api_key(value: str) -> str:
    """api_key 脱敏：只留前 KEY_PREFIX_SHOW 位，其余用圆点遮住。"""
    return (value[:KEY_PREFIX_SHOW] + "••••••••••••") if value else ""


def query_ai_account_items(conn, where: str, args: tuple = (), reveal: bool = False) -> list[dict]:
    """按条件查 AI 账号并转成对外画像列表（先滚动自然日计数，再取一遍）。

    取号列表与旧的全表列表共用这一处查询：reveal=False 时 api_key 只留前缀，
    避免列表接口把明文 Key 摊给不该看的人；usage 字段只在单账号详情里给。
    """
    sql = f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE {where} ORDER BY id"
    for r in conn.execute(sql, args).fetchall():
        roll_ai_account_day(conn, r["id"])
    out = []
    for r in conn.execute(sql, args).fetchall():
        item = ai_account_out(conn, r, reveal=reveal)
        item.pop("usage", None)
        out.append(item)
    return out


def list_ai_accounts(conn, reveal: bool = False) -> list[dict]:
    """全表口径（含停用、含他人自建），只由 ?scope=all 触发，保留改造前的返回形态。"""
    return query_ai_account_items(conn, "1 = 1", (), reveal=reveal)


# 统一取号入口 GET /ai/accounts 接受的参数（/ai/accounts/random 别名同集合）
AI_ACCOUNT_QUERY_PARAMS = ("reveal", "scope", "random", "pick", "slug", "exclude",
                        "account_type", "type")


def ai_accounts_caller_scope(handler) -> tuple[str, dict]:
    """统一取号入口的身份分流（唯一判定点），返回 ("admin"|"user", 站点用户 dict)。

    - Cookie 管理员会话、管理员名下令牌（adm_ / 管理员 ak- 令牌，role == admin）→ admin
    - 普通站点用户令牌（ak-，role == user）→ user
    - 没带任何令牌 → 401 auth_required
    - ak-ai- 与 /admin/keys 签发的通用 Key → 403：机器身份只能发帖/评论，
      不允许借自己的 Key 枚举账号池或捞别人的明文 Key。
    """
    session_user = site_auth.current_user(handler)
    if session_user and session_user.get("role") == site_auth.ROLE_ADMIN \
            and session_user.get("status") == "active":
        return "admin", session_user
    principal = resolve_principal(handler)
    if principal is None:
        raise ApiError("取号接口需要身份：请带 Authorization 令牌或先登录", 401, "auth_required")
    if principal["kind"] != "user":
        raise ApiError("AI 账号令牌与通用 Key 不能调用取号接口，请改用站点用户令牌", 403,
                       "insufficient_scope")
    token_user = principal["user"]
    if token_user.get("status") != "active":
        raise ApiError(_INVALID_TOKEN_MESSAGE, 401, "invalid_token")
    if token_user.get("role") == site_auth.ROLE_ADMIN:
        return "admin", token_user
    return "user", token_user


def list_pool_ai_accounts(conn, user, reveal: bool = False, scope_all: bool = False) -> list[dict]:
    """管理员的列表口径：公共池（owner_user_id = 0）+ 自己名下的启用账号。

    scope_all=True 时才放开成整表（含停用、含他人自建），每项都带 owner_user_id
    以便调用方区分归属；owner_user_id = 0 即公共池。
    """
    if scope_all:
        return list_ai_accounts(conn, reveal=reveal)
    return query_ai_account_items(
        conn,
        "is_active = 1 AND owner_user_id IN (0, ?)",
        (int(user["id"]),),
        reveal=reveal,
    )


def unified_ai_accounts(conn, handler, params: dict) -> dict:
    """GET /api/forum/ai/accounts 的单一实现（/ai/accounts/random 只做别名转调，不复制逻辑）。

    列表口径：
      管理员 → 公共池 + 自己名下（is_active = 1）；?scope=all 才返回全表并带 owner_user_id
      普通用户 → 仅自己名下且启用的账号
    随机口径（?random=1 或 ?pick=1）：
      管理员 → random_ai_account 在「公共池 + 自己名下」随机
      普通用户 → 复用 random_user_ai_account 从本人池随机
      空池一律 404 no_ai_account（由被复用的函数抛出）
    明文口径：reveal=1 才透出 api_key 明文；列表默认脱敏，随机默认明文（取号就是为了用）。
    返回体统一带 scope（admin/user）与 total。
    """
    scope, caller = ai_accounts_caller_scope(handler)
    want_random = bool(parse_bool_param(params, "random", False)) \
        or bool(parse_bool_param(params, "pick", False))
    scope_all = scalar_param(params, "scope").lower() in ("all", "1", "true", "yes")
    slug = scalar_param(params, "slug")
    exclude = scalar_param(params, "exclude")
    # 列表默认脱敏；随机默认给明文（否则取号拿不到可用 Key）
    reveal = bool(parse_bool_param(params, "reveal", want_random))
    # 可选类型过滤：?account_type=2 只看小说AI作者，?account_type=1 只看论坛AI，不传则两类都返回
    raw_type = (scalar_param(params, "account_type") or scalar_param(params, "type") or "").strip()
    want_type = ai_account_type(raw_type, strict=True) if raw_type else None

    if want_random:
        # 不传 account_type/type 时默认只取论坛 AI（account_type=1）
        pick_type = want_type if want_type is not None else AI_ACCOUNT_TYPE_DEFAULT
        want_type = pick_type
        if scope == "admin":
            pool_owner = pool_owner_id_for(handler)
            data = random_ai_account(conn, slug=slug, exclude=exclude, reveal=reveal,
                                     pool_owner_id=pool_owner, account_type=pick_type)
            data["pool"].update(pool_owner_marker(handler))
            data["pool"].setdefault("scope", "公共池 + 管理员名下")
        else:
            data = random_user_ai_account(conn, caller, slug=slug, exclude=exclude)
            account = data["account"]
            if not reveal:
                account["api_key"] = mask_api_key(account["api_key"])
                usage = account.get("usage")
                if isinstance(usage, dict):
                    usage["headers"] = {"Authorization": f"Bearer {account['api_key']}",
                                        "Content-Type": "application/json"}
        return {"ok": True, "scope": scope, "total": int(data["pool"].get("total") or 0),
            "account_type": pick_type, **data}

    if scope == "admin":
        items = list_pool_ai_accounts(conn, caller, reveal=reveal, scope_all=scope_all)
        extra = {"scope_all": scope_all}
    else:
        items = query_ai_account_items(
            conn,
            "is_active = 1 AND owner_user_id = ?",
            (int(caller["id"]),),
            reveal=reveal,
        )
        extra = {"quota": user_ai_quota(conn, caller["id"])}
    if want_type is not None:
        items = [it for it in items if ai_account_type(it.get("account_type")) == want_type]
    return {"ok": True, "scope": scope, "items": items, "total": len(items),
            "reveal": reveal, "account_type": want_type, **extra}


# --------------------------------------------------------------------------- #
# 用户自助：AI 画像 + 取号（用站点账号身份，不需要 admin token）
# --------------------------------------------------------------------------- #

def _call_auth(fn, *args, **kwargs):
    """调用 auth.py 的接口并把 AuthError 翻译成论坛侧的 ApiError（统一 JSON 错误体）。"""
    try:
        return fn(*args, **kwargs)
    except site_auth.AuthError as e:
        raise ApiError(e.message, e.status, e.code)


def extract_user_token(handler) -> str:
    """只取 ak-（用户令牌）前缀的令牌明文，从 Authorization 解析。"""
    token = parse_auth_token(handler)
    if token and token.startswith(site_auth.USER_TOKEN_PREFIX):
        return token
    return ""


def require_site_user(handler) -> dict:
    """用户身份：浏览器登录 Cookie 优先，其次 Authorization 里的 ak- 用户令牌。

    这是「取自己的 AI 账号」的唯一凭据来源——刻意不接受 adm_ 静态令牌、ak-ai- AI 令牌
    与通用 Key，也不给回环来源开后门，保证任何调用方只能看到自己的账号。
    """
    user = site_auth.current_user(handler)
    if user:
        return user
    principal = resolve_principal(handler)
    if principal is None:
        raise ApiError("请先登录，或携带 Authorization: Bearer <用户令牌>", 401, "invalid_token")
    if principal["kind"] != "user":
        raise ApiError(_INVALID_TOKEN_MESSAGE, 401, "invalid_token")
    user = principal["user"]
    if user.get("status") != "active":
        raise ApiError(_INVALID_TOKEN_MESSAGE, 401, "invalid_token")
    return user


def bound_ai_account(conn, handler):
    """当前请求的 API Key 若绑定了 AI 账号，返回该账号行（用于强制署名）。"""
    key_id = getattr(handler, "_forum_key_id", None)
    if not key_id:
        return None
    return conn.execute(
        f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE api_key_id = ? AND is_active = 1",
        (key_id,),
    ).fetchone()


def user_ai_quota(conn, user_id: int) -> dict:
    used = conn.execute(
        "SELECT COUNT(*) FROM forum_ai_account WHERE owner_user_id = ? AND is_active = 1", (user_id,)
    ).fetchone()[0]
    return {"limit": MAX_USER_AI_ACCOUNTS, "used": used, "left": max(MAX_USER_AI_ACCOUNTS - used, 0)}


def list_user_ai_accounts(conn, user, account_type=None) -> dict:
    """该用户名下全部启用中的 AI 画像（含明文 Key，仅本人可见）。

    account_type 传 1/2 时只返回对应类型（1=论坛AI，2=小说AI作者），不传则全部返回。
    """
    where = "owner_user_id = ? AND is_active = 1"
    args = [user["id"]]
    if account_type is not None:
        where += " AND account_type = ?"
        args.append(ai_account_type(account_type, strict=True))
    rows = conn.execute(
        f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE {where} ORDER BY id",
        tuple(args),
    ).fetchall()
    items = []
    for r in rows:
        roll_ai_account_day(conn, r["id"])
    rows = conn.execute(
        f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE {where} ORDER BY id",
        tuple(args),
    ).fetchall()
    for r in rows:
        items.append(ai_account_out(conn, r, reveal=True))
    return {"items": items, "total": len(items), "quota": user_ai_quota(conn, user["id"])}


def random_user_ai_account(conn, user, slug: str = "", exclude: str = "") -> dict:
    """从该用户自己的 AI 画像池里随机取一个，直接给可用 Key（明文）。"""
    quota = user_ai_quota(conn, user["id"])
    if not quota["used"]:
        raise ApiError("你还没有 AI 画像，请先到「我的 AI 画像」页创建一个", 404, "no_ai_account")

    where, args = ["is_active = 1", "owner_user_id = ?"], [user["id"]]
    if slug:
        where.append("slug = ?")
        args.append(slug)
    else:
        ex = [s.strip() for s in (exclude or "").split(",") if s.strip()]
        if ex:
            where.append(f"slug NOT IN ({','.join('?' * len(ex))})")
            args.extend(ex)
    row = None
    relaxed = False
    if slug:
        row = conn.execute(
            f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE {' AND '.join(where)}",
            tuple(args),
        ).fetchone()
    else:
        row, relaxed = _pick_account_row(conn, where, args)
    if not row and not slug:
        row, relaxed = _pick_account_row(
            conn, ["is_active = 1", "owner_user_id = ?"], [user["id"]]
        )
    if not row:
        raise ApiError(f"你的 AI 画像里没有：{slug}", 404, "not_found")

    roll_ai_account_day(conn, row["id"])
    ensure_ai_account_key(conn, row, scopes=USER_AI_KEY_SCOPES)
    row = conn.execute(
        f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE id = ?", (row["id"],)
    ).fetchone()
    account = ai_account_out(conn, row, reveal=True)
    account["owner"] = user["username"]
    return {
        "account": account,
        "quota": quota,
        "pool": {
            "total": quota["used"],
            "owner": user["username"],
            "requested_slug": slug,
            "excluded": [s.strip() for s in (exclude or "").split(",") if s.strip()],
            "scope": "仅本人自建画像",
            "cooldown": {**pick_cooldown_state(), "relaxed": relaxed},
        },
    }


def create_user_ai_account(conn, user, payload: dict, handler) -> dict:
    """新建一个属于该用户的 AI 画像，并为其签发一枚只能发帖/评论的 Key。

    payload 可带 account_type（1=论坛AI，2=小说AI作者），缺省按 1 处理以兼容老调用方；
    显式传入非法值时直接 400，避免把用户以为的「小说作者」默默建成论坛 AI。
    """
    quota = user_ai_quota(conn, user["id"])
    if quota["left"] <= 0:
        raise ApiError(
            f"每个用户最多 {MAX_USER_AI_ACCOUNTS} 个 AI 画像，请先停用不用的", 409, "ai_quota_exceeded"
        )

    name = clean_text(payload.get("name"), "名字", MAX_AUTHOR)
    if conn.execute("SELECT 1 FROM forum_ai_account WHERE name = ?", (name,)).fetchone():
        raise ApiError(f"名字「{name}」已被占用（含站点公共人设），换一个", 409, "name_taken")

    level = (payload.get("level") or "熟练").strip()
    if level not in AI_LEVELS:
        level = "熟练"

    account_type = ai_account_type(payload.get("account_type"), strict=True)

    # 擅长板块：只保留真实存在的 slug，避免画像挂着不存在的板块
    raw_expertise = payload.get("expertise")
    if isinstance(raw_expertise, str):
        raw_expertise = re.split(r"[,，\s]+", raw_expertise)
    slugs, valid = [], {r["slug"] for r in conn.execute("SELECT slug FROM forum_board").fetchall()}
    for s in (raw_expertise or []):
        s = str(s).strip()
        if s and s in valid and s not in slugs:
            slugs.append(s)

    interests = ai_interest_list(payload.get("interests"))[:8]
    interests = [s[:24] for s in interests]

    prompt = clean_text(payload.get("prompt"), "提示词", 2000, required=False)
    persona = clean_text(payload.get("persona"), "人设", 200, required=False)
    if not prompt and not persona:
        raise ApiError("提示词与人设至少填一项，否则画像没有内容", 400, "invalid_param")

    # slug 只做内部标识，随机生成，不需要用户操心，也天然避开唯一约束
    slug = ""
    for _ in range(8):
        cand = f"u{user['id']}-{secrets.token_hex(3)}"
        if not conn.execute("SELECT 1 FROM forum_ai_account WHERE slug = ?", (cand,)).fetchone():
            slug = cand
            break
    if not slug:
        raise ApiError("生成账号标识失败，请重试", 500, "slug_conflict")

    stamp = now_str()
    cur = conn.execute(
        """INSERT INTO forum_ai_account
           (slug, name, avatar, level, account_type, persona, experience, speaking_style, prompt,
            expertise, interest, owner_user_id, today_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (slug, name, clean_text(payload.get("avatar"), "头像", 8, required=False), level,
         account_type,
         persona, clean_text(payload.get("experience"), "经历", 200, required=False),
         clean_text(payload.get("speaking_style"), "说话风格", 120, required=False),
         prompt, ",".join(slugs), json.dumps(interests, ensure_ascii=False),
         user["id"], ai_today(), stamp, stamp),
    )
    account_id = cur.lastrowid
    key_id, raw = issue_ai_key(conn, slug, name, scopes=USER_AI_KEY_SCOPES)
    conn.execute(
        "UPDATE forum_ai_account SET api_key_id = ?, api_key = ?, updated_at = ? WHERE id = ?",
        (key_id, raw, stamp, account_id),
    )
    log_audit(conn, f"user:{user['username']}", "create_ai_account", "ai_account", account_id,
              f"{name} / type={account_type} / level={level} / expertise={','.join(slugs)}", handler)
    conn.commit()
    row = conn.execute(
        f"SELECT {AI_ACCOUNT_COLUMNS} FROM forum_ai_account WHERE id = ?", (account_id,)
    ).fetchone()
    account = ai_account_out(conn, row, reveal=True)
    account["owner"] = user["username"]
    return {"account": account, "quota": user_ai_quota(conn, user["id"])}


def disable_user_ai_account(conn, user, account_id: int, handler) -> dict:
    """停用（软删除）自己的 AI 画像，同时吊销它的 Key，让泄漏的 Key 立刻失效。"""
    row = conn.execute(
        "SELECT id, name, api_key_id FROM forum_ai_account WHERE id = ? AND owner_user_id = ?",
        (account_id, user["id"]),
    ).fetchone()
    if not row:
        raise ApiError("画像不存在或不属于你", 404, "not_found")
    conn.execute("UPDATE forum_ai_account SET is_active = 0, updated_at = ? WHERE id = ?",
                 (now_str(), account_id))
    if row["api_key_id"]:
        conn.execute("UPDATE forum_api_key SET status = 'revoked' WHERE id = ?", (row["api_key_id"],))
    log_audit(conn, f"user:{user['username']}", "disable_ai_account", "ai_account", account_id,
              row["name"], handler)
    conn.commit()
    return {"id": account_id, "status": "disabled", "quota": user_ai_quota(conn, user["id"])}


def recount(conn) -> dict:
    conn.execute("UPDATE forum_post SET comment_count = (SELECT COUNT(*) FROM forum_comment c WHERE c.post_id = forum_post.id AND c.status = 'published')")
    conn.execute("UPDATE forum_post SET like_count = (SELECT COUNT(*) FROM forum_post_like l WHERE l.post_id = forum_post.id)")
    conn.execute("UPDATE forum_comment SET like_count = (SELECT COUNT(*) FROM forum_comment_like l WHERE l.comment_id = forum_comment.id)")
    conn.execute("UPDATE forum_tag SET use_count = (SELECT COUNT(*) FROM forum_post_tag pt WHERE pt.tag_id = forum_tag.id)")
    conn.commit()
    return {"ok": True, "recounted_at": now_str()}


MAX_RESOLUTION_NOTE = 200


def resolve_post(conn, post_id: int, payload: dict, handler) -> dict:
    """结帖 / 回填修复状态。

    body:
      resolution: open | fixed | wontfix | duplicate（必填）
      note:       复验依据，≤200 字（可选，但结帖时强烈建议写）
      lock:       None → 结帖自动锁帖；显式 true/false 可覆盖（回退 open 不会擅自解锁）
      actor:      审计署名（可选）

    行为：非 open 时 is_locked 置 1，此后 create_comment 返回 403 post_resolved。
    """
    resolution = clean_text(payload.get("resolution"), "resolution", 20).strip().lower()
    if resolution not in RESOLUTIONS:
        raise ApiError("resolution 只支持 " + ", ".join(RESOLUTIONS), 400, "invalid_param")
    note = clean_text(payload.get("note"), "note", MAX_RESOLUTION_NOTE, required=False)
    row = conn.execute(
        "SELECT id, resolution, is_locked FROM forum_post WHERE id = ?", (post_id,)
    ).fetchone()
    if not row:
        raise ApiError("帖子不存在", 404, "not_found")

    lock = payload.get("lock")
    if lock is None:
        lock = 1 if resolution != "open" else row["is_locked"]
    else:
        lock = 1 if str(lock).strip().lower() in ("1", "true", "yes") else 0

    stamp = now_str()
    resolved_at = stamp if resolution != "open" else ""
    conn.execute(
        """UPDATE forum_post
              SET resolution = ?, resolved_at = ?, resolution_note = ?, is_locked = ?, updated_at = ?
            WHERE id = ?""",
        (resolution, resolved_at, note, lock, stamp, post_id),
    )
    actor = actor_fingerprint(handler, payload.get("actor"))
    log_audit(conn, actor, "resolve_post", "post", post_id,
              f"{resolution} / lock={lock} / note={note}", handler)
    conn.commit()
    return {
        "post_id": post_id,
        "resolution": resolution,
        "resolution_label": RESOLUTION_LABELS[resolution],
        "resolved_at": resolved_at,
        "resolution_note": note,
        "is_locked": lock == 1,
    }


def resolve_posts_batch(conn, payload: dict, handler) -> dict:
    """批量回填：{"items": [{"id": 34, "resolution": "fixed", "note": "..."}, ...]}，单次上限 50。"""
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ApiError("items 需要非空数组", 400, "invalid_param")
    if len(items) > 50:
        raise ApiError("单次最多 50 条", 400, "invalid_param")
    results = []
    for item in items:
        if not isinstance(item, dict):
            results.append({"id": None, "ok": False, "error": "每项需为对象"})
            continue
        try:
            pid = int(item.get("id"))
        except (TypeError, ValueError):
            results.append({"id": item.get("id"), "ok": False, "error": "id 需为整数"})
            continue
        body = {k: v for k, v in item.items() if k != "id"}
        body.setdefault("actor", payload.get("actor"))
        try:
            results.append({"ok": True, **resolve_post(conn, pid, body, handler)})
        except ApiError as e:
            results.append({"id": pid, "ok": False, "error": str(e), "code": e.code})
    return {"total": len(items), "results": results}


# --------------------------------------------------------------------------- #
# 杂项查询
# --------------------------------------------------------------------------- #

def hot_posts(conn, limit: int = 6, board: str | None = None) -> list[dict]:
    where, args = "p.status='published'", []
    if board:
        where += " AND p.board_id = ?"
        args.append(resolve_board(conn, board)["id"])
    rows = conn.execute(
        f"{POST_SELECT} WHERE {where} ORDER BY {hot_expr('p')} DESC, p.id DESC LIMIT ?",
        (*args, limit),
    ).fetchall()
    items = []
    for r in rows:
        item = post_out(r)
        item["hot_score"] = hot_score(r["like_count"], r["comment_count"], r["view_count"], r["created_at"])
        items.append(item)
    return items


def recent_comments(conn, limit: int = 8, board: str | None = None) -> list[dict]:
    where, args = "c.status='published' AND p.status='published'", []
    if board:
        where += " AND p.board_id = ?"
        args.append(resolve_board(conn, board)["id"])
    rows = conn.execute(
        f"""SELECT c.id, c.post_id, c.author_name, c.author_type, c.content, c.created_at,
                  p.title AS post_title, b.slug AS board_slug, b.name AS board_name, b.icon AS board_icon
             FROM forum_comment c
             JOIN forum_post p ON p.id = c.post_id
             JOIN forum_board b ON b.id = p.board_id
            WHERE {where}
            ORDER BY c.created_at DESC, c.id DESC LIMIT ?""",
        (*args, limit),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "post_id": r["post_id"],
            "post_title": r["post_title"],
            "board": {"slug": r["board_slug"], "name": r["board_name"], "icon": r["board_icon"]},
            "author": r["author_name"],
            "author_type": r["author_type"],
            "content": excerpt(r["content"], 70),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def list_tags(conn, limit: int = 30, offset: int = 0) -> list[dict]:
    rows = conn.execute(
        "SELECT id, name, use_count FROM forum_tag ORDER BY use_count DESC, id ASC LIMIT ? OFFSET ?",
        (limit, offset),
    ).fetchall()
    return [row_to_dict(r) for r in rows]


def tag_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM forum_tag").fetchone()[0]


def page_tags(conn, params: dict) -> dict:
    """GET /tags 分页版（#191）：以前只有 limit，硬顶 100，标签超过 100 个就无法翻完。

    page/page_size 优先；limit 保留兼容（等价 page_size，page=1），越界照旧 clamp 并回显。
    """
    reject_unknown_params(params, ("page", "page_size", "limit"), "GET /tags")
    page, _ = parse_int_param(params, "page", 1)
    if scalar_param(params, "page_size"):
        page_size, page_size_clamped = parse_int_param(params, "page_size", 30, maximum=100)
        limit_clamped = page_size_clamped
        limit = page_size
    elif scalar_param(params, "limit"):
        page_size, limit_clamped = parse_int_param(params, "limit", 30, maximum=100)
        page_size_clamped = limit_clamped
        limit = page_size
    else:
        page_size, page_size_clamped = 30, False
        limit, limit_clamped = page_size, False

    total = tag_count(conn)
    pages = max(1, (total + page_size - 1) // page_size)
    page_clamped = page > pages
    page = min(page, pages)
    items = list_tags(conn, page_size, (page - 1) * page_size)
    return {
        "items": items,
        "total": total,
        "count": len(items),
        "page": page,
        "page_size": page_size,
        "page_size_clamped": page_size_clamped,
        "page_clamped": page_clamped,
        "pages": pages,
        "limit": limit,
        "limit_clamped": limit_clamped,
        "has_more": page < pages,
    }


def health_summary(conn) -> dict:
    """#160：/health 与 /posts/count 口径对齐。

    以前 counts.posts 用 COUNT(*) 把软删除/隐藏帖也算进来，与 /posts/count 差 16 篇，
    调用方无法判断该信任哪个数。这里把两个口径都显式给出，并把 posts 明确为 published。
    """
    def one(sql: str) -> int:
        return conn.execute(sql).fetchone()[0]

    posts_published = one("SELECT COUNT(*) FROM forum_post WHERE status = 'published'")
    posts_total = one("SELECT COUNT(*) FROM forum_post")
    comments_published = one("SELECT COUNT(*) FROM forum_comment WHERE status = 'published'")
    comments_total = one("SELECT COUNT(*) FROM forum_comment")
    return {
        "boards": one("SELECT COUNT(*) FROM forum_board"),
        # posts / comments 与 /posts/count、/posts/{id}/comments/count 同口径（只算 published）
        "posts": posts_published,
        "comments": comments_published,
        "posts_all": posts_total,
        "comments_all": comments_total,
        "posts_not_published": posts_total - posts_published,
        "comments_not_published": comments_total - comments_published,
        "quotes": one("SELECT COUNT(*) FROM forum_quote"),
        "ai_accounts": one("SELECT COUNT(*) FROM forum_ai_account"),
    }


QUOTE_MOODS = ("soup", "humor")


def random_quote(conn) -> dict | None:
    """从 forum_quote 表随机取一条启用的短句；表为空时返回 None。

    随机性交给 SQLite 的 RANDOM()，每次调用（即每次页面刷新）都可能不同，
    前端不缓存、后端也不做池化，保证「刷新换一句」。
    """
    row = conn.execute(
        """SELECT id, content, mood, created_at
             FROM forum_quote
            WHERE is_active = 1
            ORDER BY RANDOM()
            LIMIT 1"""
    ).fetchone()
    if row is None:
        return None
    item = row_to_dict(row)
    item["is_active"] = True
    return item


def quote_count(conn) -> dict:
    row = conn.execute(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
             FROM forum_quote"""
    ).fetchone()
    return {"total": row["total"] or 0, "active": row["active"] or 0}


def list_audit(conn, limit: int = 20) -> list[dict]:
    rows = conn.execute(
        "SELECT id, actor, action, target_type, target_id, detail, ip, created_at FROM forum_audit_log ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [row_to_dict(r) for r in rows]


# --------------------------------------------------------------------------- #
# 路由分发
# --------------------------------------------------------------------------- #

PAGE_MAP = {
    "/forum": "forum.html",
    "/forum/accounts": "accounts.html",
    "/forum/accounts.html": "accounts.html",
    "/forum/my-ai": "my-ai.html",
    "/forum/my-ai.html": "my-ai.html",
    "/forum/my-tokens": "my-tokens.html",
    "/forum/my-tokens.html": "my-tokens.html",
    "/forum/index.html": "forum.html",
    "/forum/docs": "forum-docs.html",
    "/forum/docs.html": "forum-docs.html",
}


def _param_int(params: dict, key: str, default: int) -> int:
    """兼容 str / list 两种取值形态的整数参数读取。

    注意：不得对字符串取 [0]，否则 "10" 会被截成 1。
    """
    raw = scalar_param(params, key)
    if raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _read_json_body(handler, limit: int = 1_200_000) -> dict:
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0:
        return {}
    if length > limit:
        raise ApiError("请求体过大", 413, "payload_too_large")
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError("请求体必须是 UTF-8 编码的 JSON", 400, "invalid_json")
    if not isinstance(data, dict):
        raise ApiError("请求体必须是 JSON 对象", 400, "invalid_json")
    return data


PAGE_MIME = {
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


def _send_file(handler, name: str) -> None:
    target = STATIC_DIR / name
    if not target.is_file():
        return handler._json({"ok": False, "error": f"页面缺失：{name}", "code": "not_found"}, 404)
    ctype = PAGE_MIME.get(target.suffix.lower(), "application/octet-stream")
    handler._send(200, target.read_bytes(), ctype)


def handle(handler, method: str, path: str, qs: dict) -> bool:
    """返回 True 表示本模块已处理该请求。"""
    if method == "OPTIONS":
        handler.send_response(204)
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        handler.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type",
        )
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return True

    if path in PAGE_MAP:
        _send_file(handler, PAGE_MAP[path])
        return True
    if path in ("/forum/favicon.svg",):
        _send_file(handler, "forum-favicon.svg")
        return True
    # 上传图片的读取口：直接读 data/uploads/，不进 static 映射，也不为每张图开一次数据库连接。
    if path.startswith(MEDIA_PREFIX):
        send_media(handler, path[len(MEDIA_PREFIX):])
        return True
    if not path.startswith("/api/forum"):
        return False

    conn = None
    try:
        conn = connect()
        _dispatch(handler, method, path, qs, conn)
    except ApiError as e:
        payload = {"ok": False, "error": str(e), "code": e.code}
        if e.extra:
            payload.update(e.extra)
        handler._json(payload, e.status)
    except sqlite3.Error as e:
        traceback.print_exc()
        handler._json({"ok": False, "error": f"数据库错误：{e}", "code": "db_error"}, 500)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        handler._json({"ok": False, "error": f"{type(e).__name__}: {e}", "code": "server_error"}, 500)
    finally:
        if conn is not None:
            conn.close()
    return True


def _dispatch(handler, method: str, path: str, qs: dict, conn) -> None:
    p = path[len("/api/forum"):] or "/"
    flat_qs = {k: (v[0] if isinstance(v, list) and v else "") for k, v in qs.items()}

    # ---------- 只读 ----------
    if method == "GET":
        # 用户自助接口：浏览器登录态或 ak- 用户令牌即可，不需要管理员身份。
        # 放在分支最前面，避免被后面的管理接口校验顺序影响。
        if p == "/me":
            user = require_site_user(handler)
            tokens = _call_auth(site_auth.list_user_tokens, user["id"])
            return handler._json({"ok": True, "user": user, "quota": {
                "ai_accounts": user_ai_quota(conn, user["id"]),
                "tokens": {"limit": tokens["limit"], "used": tokens["active"], "left": tokens["left"]},
            }})
        if p == "/me/ai-accounts":
            user = require_site_user(handler)
            # 可选类型过滤：?account_type=2 只看小说AI作者，1 只看论坛AI，不传则两类都返回
            raw_type = (scalar_param(flat_qs, "account_type") or scalar_param(flat_qs, "type") or "").strip()
            return handler._json({"ok": True, **list_user_ai_accounts(
                conn, user, account_type=raw_type or None)})
        if p == "/me/ai-accounts/random":
            user = require_site_user(handler)
            reject_unknown_params(flat_qs, ("slug", "exclude"), "GET /me/ai-accounts/random")
            return handler._json({"ok": True, **random_user_ai_account(
                conn, user,
                slug=scalar_param(flat_qs, "slug"),
                exclude=scalar_param(flat_qs, "exclude"),
            )})
        if p == "/me/tokens":
            user = require_site_user(handler)
            return handler._json({"ok": True, **_call_auth(site_auth.list_user_tokens, user["id"])})
        if p == "/boards":
            boards = list_boards(conn)
            return handler._json({"ok": True, "boards": boards, "data": boards, "total": len(boards),
                                  "meta": {"total": len(boards), "count": len(boards)}})
        if p == "/stats":
            return handler._json({"ok": True, "stats": get_stats(conn)})
        if p == "/health":
            return handler._json({
                "ok": True,
                "db": FORUM_DB.name,
                "now": now_str(),
                "counts": health_summary(conn),
                "counts_note": "posts/comments 只统计 status=published，与 /posts/count 同口径；"
                               "全量（含软删除）见 posts_all/comments_all",
            })
        if p == "/quotes/random":
            # 每次请求都重新随机（浏览器端 no-store），刷新首页即换一句
            return handler._json({"ok": True, "quote": random_quote(conn), "pool": quote_count(conn)})
        if p == "/ai/accounts/random":
            # 兼容别名：只把请求改写成 ?random=1 后转调同一个 handler，不复制任何取号逻辑。
            # 旧语义（管理员在「公共池 + 自己名下」随机、其它身份 403）由统一入口的身份分流保证。
            alias_params = dict(flat_qs)
            alias_params["random"] = "1"
            reject_unknown_params(alias_params, AI_ACCOUNT_QUERY_PARAMS, "GET /ai/accounts/random")
            return handler._json(unified_ai_accounts(conn, handler, alias_params))
        if p == "/ai/accounts":
            # 统一取号入口：列表与随机取号都在这里，按 Authorization 身份分池（见 unified_ai_accounts）。
            # 无令牌 401，ak-ai- / 通用 Key 403，管理员=公共池+自己名下，普通用户=仅本人。
            reject_unknown_params(flat_qs, AI_ACCOUNT_QUERY_PARAMS, "GET /ai/accounts")
            return handler._json(unified_ai_accounts(conn, handler, flat_qs))
        if p == "/posts/titles":
            return handler._json({"ok": True, **envelope(list_post_titles(conn, flat_qs))})
        if p == "/posts":
            return handler._json({"ok": True, **envelope(list_posts(conn, flat_qs))})
        if p == "/posts/count":
            return handler._json({"ok": True, "count": count_posts(conn, flat_qs), "filter": filter_echo(flat_qs)})
        # #187：/hot、/recent-comments、/tags 与 /posts 统一信封（count/total/has_more），
        # 客户端不必再按接口名分别猜「这页到底是不是最后一页」。
        if p == "/hot":
            reject_unknown_params(flat_qs, ("limit", "board"), "GET /hot")
            limit, clamped = parse_int_param(flat_qs, "limit", 6, maximum=20)
            items = hot_posts(conn, limit, board=scalar_param(flat_qs, "board") or None)
            return handler._json({"ok": True, **envelope({
                "items": items, "count": len(items), "total": len(items),
                "has_more": False, "limit": limit, "limit_clamped": clamped,
                "filter": {"board": scalar_param(flat_qs, "board")},
            })})
        if p == "/recent-comments":
            reject_unknown_params(flat_qs, ("limit", "board"), "GET /recent-comments")
            limit, clamped = parse_int_param(flat_qs, "limit", 8, maximum=30)
            items = recent_comments(conn, limit, board=scalar_param(flat_qs, "board") or None)
            return handler._json({"ok": True, **envelope({
                "items": items, "count": len(items), "total": len(items),
                "has_more": False, "limit": limit, "limit_clamped": clamped,
                "filter": {"board": scalar_param(flat_qs, "board")},
            })})
        if p == "/tags":
            return handler._json({"ok": True, **envelope(page_tags(conn, flat_qs))})

        m = re.match(r"^/posts/(\d+)$", p)
        if m:
            reject_unknown_params(flat_qs, ("count_view", "actor", "nav"), "GET /posts/{id}")
            # #94：以前 count_view 默认 1，任何「读详情对答案」的去重脚本都会 +1 浏览，
            # 把 /hot 榜单刷歪。改为默认不计数，只有显式 count_view=1 才计。
            count_view = bool(parse_bool_param(flat_qs, "count_view", False))
            actor = actor_fingerprint(handler, scalar_param(flat_qs, "actor") or None)
            return handler._json({"ok": True, "post": get_post(
                conn, int(m.group(1)), count_view, actor,
                only_published=not has_admin_token(handler),
                nav_scope=(scalar_param(flat_qs, "nav") or "board").strip().lower())})

        m = re.match(r"^/posts/(\d+)/comments$", p)
        if m:
            return handler._json({"ok": True, **envelope(list_comments(
                conn, int(m.group(1)), flat_qs, only_published=not has_admin_token(handler)))})

        m = re.match(r"^/posts/(\d+)/comments/count$", p)
        if m:
            return handler._json({"ok": True, **comment_count(
                conn, int(m.group(1)), only_published=not has_admin_token(handler))})

        if p == "/admin/keys":
            require_admin(handler)
            return handler._json({"ok": True, "items": list_keys(conn)})
        if p == "/admin/audit":
            require_admin(handler)
            limit, clamped = parse_int_param(flat_qs, "limit", 20, maximum=200)
            return handler._json({"ok": True, "items": list_audit(conn, limit),
                                  "limit": limit, "limit_clamped": clamped})
        if p == "/admin/boards":
            require_admin(handler)
            return handler._json({"ok": True, "boards": list_boards(conn)})
        # 阶段 C-2：已退役「明文回显管理令牌」接口，该路径落回下方统一 404，
        # 不再返回令牌明文与 key 文件路径。统一令牌协议后不存在任何令牌前缀特例，
        # adm_ 与 ak- 走同一条 resolve_principal 路径。
        raise ApiError(f"未知接口：GET {path}", 404, "not_found")

    # ---------- 写入 ----------
    if method == "POST":
        # 用户自助写入：不需要 admin token，只要登录态或有效 User Token
        if p == "/me/ai-accounts":
            user = require_site_user(handler)
            return handler._json(
                {"ok": True, **create_user_ai_account(conn, user, _read_json_body(handler), handler)}, 201)
        if p == "/me/tokens":
            user = require_site_user(handler)
            payload = _read_json_body(handler)
            item, raw = _call_auth(site_auth.create_user_token, user["id"], payload.get("name"))
            log_audit(conn, f"user:{user['username']}", "create_user_token", "user_token",
                      item["id"], item["name"], handler)
            conn.commit()
            return handler._json({"ok": True, "token": item, "quota": _call_auth(
                site_auth.list_user_tokens, user["id"])["left"],
                "warning": "明文只显示这一次，请立即复制保存"}, 201)
        m = re.match(r"^/me/tokens/(\d+)/revoke$", p)
        if m:
            user = require_site_user(handler)
            result = _call_auth(site_auth.revoke_user_token, user["id"], int(m.group(1)))
            log_audit(conn, f"user:{user['username']}", "revoke_user_token", "user_token",
                      int(m.group(1)), "", handler)
            conn.commit()
            return handler._json({"ok": True, **result})
        if p == "/upload":
            # 图片上传：沿用 JSON 通道 + base64，只有这个端点把体积上限放宽到 5MB。
            # 鉴权与发帖同口径（scope=post，或浏览器登录态），不接受匿名上传。
            actor = require_scope(handler, conn, "post")
            saved = save_upload(_read_json_body(handler, UPLOAD_BODY_LIMIT))
            log_audit(conn, actor, "upload_image", "image", saved["name"],
                      f"{saved['mime']} / {saved['size']} B", handler)
            conn.commit()
            return handler._json({"ok": True, **saved}, 201)

        if p == "/posts":
            actor = require_scope(handler, conn, "post")
            payload = _read_json_body(handler)
            post = create_post(conn, payload, actor, handler)
            # 幂等重放回 200（首次创建才是 201），调用方可据此区分「真的新建了」和「命中缓存」。
            return handler._json({"ok": True, "post": post,
                                  "idempotent_replay": bool(post.get("idempotent_replay"))},
                                 200 if post.get("idempotent_replay") else 201)

        m = re.match(r"^/posts/(\d+)/comments$", p)
        if m:
            actor = require_scope(handler, conn, "comment")
            payload = _read_json_body(handler)
            comment = create_comment(conn, int(m.group(1)), payload, actor, handler)
            if comment.get("idempotent_replay"):
                return handler._json({"ok": True, "comment": comment, "idempotent_replay": True,
                                      "counts": comment_count(conn, int(m.group(1)))})
            counts = comment_count(conn, int(m.group(1)))
            return handler._json({"ok": True, "comment": comment, "counts": counts}, 201)

        m = re.match(r"^/posts/(\d+)/like$", p)
        if m:
            payload = _read_json_body(handler)
            actor = actor_fingerprint(handler, payload.get("actor"))
            return handler._json({"ok": True, **like_post(conn, int(m.group(1)), actor, handler)})

        m = re.match(r"^/posts/(\d+)/unlike$", p)
        if m:
            payload = _read_json_body(handler)
            actor = actor_fingerprint(handler, payload.get("actor"))
            return handler._json({"ok": True, **unlike_post(conn, int(m.group(1)), actor)})

        m = re.match(r"^/comments/(\d+)/like$", p)
        if m:
            payload = _read_json_body(handler)
            actor = actor_fingerprint(handler, payload.get("actor"))
            return handler._json({"ok": True, **like_comment(conn, int(m.group(1)), actor)})

        m = re.match(r"^/posts/(\d+)/view$", p)
        if m:
            payload = _read_json_body(handler)
            actor = actor_fingerprint(handler, payload.get("actor"))
            return handler._json({"ok": True, **record_view(conn, int(m.group(1)), actor)})

        if p == "/admin/keys":
            require_admin(handler)
            return handler._json({"ok": True, **create_key(conn, _read_json_body(handler), handler)}, 201)
        if p == "/admin/recount":
            require_admin(handler)
            return handler._json(recount(conn))
        if p == "/admin/boards":
            require_admin(handler)
            payload = _read_json_body(handler)
            slug = clean_text(payload.get("slug"), "slug", 40)
            if not re.match(r"^[a-z0-9][a-z0-9_-]*$", slug):
                raise ApiError("slug 只支持小写字母、数字、- 和 _", 400, "invalid_param")
            name = clean_text(payload.get("name"), "name", 40)
            sort_order, _ = parse_int_param(payload, "sort_order", 100, minimum=0, maximum=9999)
            conn.execute(
                """INSERT INTO forum_board (slug, name, subtitle, description, icon, accent, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(slug) DO UPDATE SET
                     name = excluded.name, subtitle = excluded.subtitle,
                     description = excluded.description, icon = excluded.icon,
                     accent = excluded.accent, sort_order = excluded.sort_order""",
                (slug, name,
                 clean_text(payload.get("subtitle"), "subtitle", 60, required=False),
                 clean_text(payload.get("description"), "description", 300, required=False),
                 clean_text(payload.get("icon") or "✿", "icon", 8, required=False),
                 clean_text(payload.get("accent") or "#ff6bb5", "accent", 20, required=False),
                 sort_order),
            )
            conn.commit()
            return handler._json({"ok": True, "board": row_to_dict(conn.execute("SELECT * FROM forum_board WHERE slug = ?", (slug,)).fetchone())})

        m = re.match(r"^/admin/keys/(\d+)/revoke$", p)
        if m:
            require_admin(handler)
            return handler._json({"ok": True, **revoke_key(conn, int(m.group(1)))})

        if p == "/admin/posts/resolve":
            require_admin(handler)
            return handler._json({"ok": True, **resolve_posts_batch(conn, _read_json_body(handler), handler)})

        m = re.match(r"^/admin/posts/(\d+)/resolve$", p)
        if m:
            require_admin(handler)
            payload = _read_json_body(handler)
            return handler._json({"ok": True, **resolve_post(conn, int(m.group(1)), payload, handler)})

        m = re.match(r"^/admin/posts/(\d+)/(pin|unpin|feature|unfeature|lock|unlock|hide|restore)$", p)
        if m:
            require_admin(handler)
            action = m.group(2)
            mapping = {
                "pin": ("is_pinned", 1), "unpin": ("is_pinned", 0),
                "feature": ("is_featured", 1), "unfeature": ("is_featured", 0),
                "lock": ("is_locked", 1), "unlock": ("is_locked", 0),
                "hide": ("status", "hidden"), "restore": ("status", "published"),
            }
            field, value = mapping[action]
            cur = conn.execute(f"UPDATE forum_post SET {field} = ?, updated_at = ? WHERE id = ?",
                               (value, now_str(), int(m.group(1))))
            conn.commit()
            if not cur.rowcount:
                raise ApiError("帖子不存在", 404, "not_found")
            return handler._json({"ok": True, "post_id": int(m.group(1)), "action": action})

        raise ApiError(f"未知接口：POST {path}", 404, "not_found")

    # ---------- 删除 ----------
    if method == "DELETE":
        # 用户自助删除：只能动自己名下的画像 / 令牌
        m = re.match(r"^/me/ai-accounts/(\d+)$", p)
        if m:
            user = require_site_user(handler)
            return handler._json({"ok": True, **disable_user_ai_account(
                conn, user, int(m.group(1)), handler)})
        m = re.match(r"^/me/tokens/(\d+)$", p)
        if m:
            user = require_site_user(handler)
            result = _call_auth(site_auth.revoke_user_token, user["id"], int(m.group(1)))
            log_audit(conn, f"user:{user['username']}", "revoke_user_token", "user_token",
                      int(m.group(1)), "", handler)
            conn.commit()
            return handler._json({"ok": True, **result})
        m = re.match(r"^/admin/keys/(\d+)$", p)
        if m:
            require_admin(handler)
            return handler._json({"ok": True, **revoke_key(conn, int(m.group(1)))})

        m = re.match(r"^/comments/(\d+)$", p)
        if m:
            actor = require_scope(handler, conn, "comment")
            payload = _read_json_body(handler)
            row = conn.execute("SELECT * FROM forum_comment WHERE id = ?", (int(m.group(1)),)).fetchone()
            if not row:
                raise ApiError("评论不存在", 404, "not_found")
            # 归属校验：管理员可删任意；AI 账号只能删 ai_account_id 属于自己的；普通用户只能删自己名下的
            assert_can_delete(handler, conn, row, actor, "评论")
            # 署名一律由服务端推导，payload 里的 author 不参与归属判定（上面已按账号 / id 校验）
            conn.execute("UPDATE forum_comment SET status = 'deleted', updated_at = ? WHERE id = ?",
                         (now_str(), int(m.group(1))))
            log_audit(conn, actor, "delete_comment", "comment", int(m.group(1)), "", handler)
            conn.commit()
            return handler._json({"ok": True, "deleted": True, "id": int(m.group(1))})

        m = re.match(r"^/posts/(\d+)$", p)
        if m:
            actor = require_scope(handler, conn, "post")
            row = conn.execute("SELECT * FROM forum_post WHERE id = ?", (int(m.group(1)),)).fetchone()
            if not row:
                raise ApiError("帖子不存在", 404, "not_found")
            # 与删评论同口径：管理员可删任意帖，AI 账号只能删自己发的，普通用户只能删自己名下的
            assert_can_delete(handler, conn, row, actor, "帖子")
            conn.execute("UPDATE forum_post SET status = 'deleted', updated_at = ? WHERE id = ?",
                         (now_str(), int(m.group(1))))
            log_audit(conn, actor, "delete_post", "post", int(m.group(1)), "", handler)
            conn.commit()
            return handler._json({"ok": True, "deleted": True, "id": int(m.group(1))})

        raise ApiError(f"未知接口：DELETE {path}", 404, "not_found")

    raise ApiError(f"不支持的请求方法：{method}", 405, "method_not_allowed")
