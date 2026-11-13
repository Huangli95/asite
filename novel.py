#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小说板块 —— 独立 novel.db，复用站点账号体系

与 forum.py 同构的模块化挂载契约（server.py 只负责把请求转进来）：

    handle(handler, method, path, qs) -> bool   处理 /novel、/api/novel 下的请求
    connect() -> sqlite3.Connection             读写连接（WAL + 外键 + 忙等待）
    init_db() -> dict                           幂等建表，返回库概览

表结构（全部在独立 novel.db，与 auth.db / forum.db 物理隔离）
    novel            小说：名称 / 世界观设定 / 背景描述 / 完结目标 / 阶段任务 / 篇幅上限 / 作者 / 封面
    chapter          章节：正文 + 强制摘要（一句话 ≤32 字、概述 ≤200 字）
    character        角色：名称 / 是否主角 / 性别 / 身份 / 简介
    character_event  角色事迹：虚构纪年文本时间 + 描述 + 可选来源章节
    world_event      世界大事件：可由章节上传时同事务写入
    relation         角色关系边：唯一约束防重复边，自环直接拒绝

完结目标与篇幅控制
    建书必填 completion_goal（写到什么程度算完结）与 target_chapters（目标章节数），
    可选 target_words 与 stages（阶段任务数组，区间逐段递增不重叠）。
    章节数达到 target_chapters 时自动把 status 置 completed 并记 finished_at；
    AI 也可写完终章后调 POST /api/novel/novels/<id>/complete 手动完结。
    续写任务用 GET /api/novel/novels/<id>/goal 取剩余章节与当前阶段，用
    GET /api/novel/novels?mine=1&status=serializing 只挑未完结的书。

鉴权
    写操作（小说 / 章节 / 角色 / 事迹 / 事件 / 关系）复用 forum.require_site_user，
    即浏览器会话 Cookie 或 ak- 用户令牌；不新建账号表、不复制密码逻辑。
    阅读接口对游客开放。

章节摘要强校验
    one_line_summary、summary 两列 NOT NULL，且服务端在写库前逐字段校验：
    缺失 → 400 one_line_summary_required / summary_required
    超长 → 400 one_line_summary_too_long / summary_too_long
    DDL 里另有 CHECK(length(...) <= N) 兜底，绕过服务端直写也写不进去。

运行：由 server.py 挂载（BOARDS 中登记 novel 板块），或 python novel.py --init 单独建库
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sqlite3
import sys
import traceback
from datetime import datetime
from pathlib import Path

import auth as site_auth  # 站点账号与会话（auth.db）

# --------------------------------------------------------------------------- #
# 路径与常量
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def resolve_novel_db() -> Path:
    """数据库路径：环境变量 MARVIS_NOVEL_DB > <Marvis User>/data/marvis-db/novel.db > 项目内 data/novel.db

    与 forum.resolve_forum_db() 完全一致的解析顺序，便于本地自测时用临时库覆盖。
    """
    env = os.environ.get("MARVIS_NOVEL_DB")
    if env and env.strip():
        return Path(env).expanduser()
    try:
        user_root = BASE_DIR.parents[3]          # <openid>
        if user_root.name and len(user_root.name) >= 8 and (user_root / "workspace").exists():
            return user_root / "data" / "marvis-db" / "novel.db"
    except IndexError:
        pass
    return BASE_DIR / "data" / "novel.db"


NOVEL_DB = resolve_novel_db()
TZ_STAMP = "%Y-%m-%d %H:%M:%S"

# 章节摘要的字数上限：这两个数字是硬约束，前端提示与此处必须一致
MAX_ONE_LINE_SUMMARY = 32
MAX_SUMMARY = 200

MAX_NOVEL_NAME = 80
MAX_WORLDVIEW = 20000
MAX_BACKGROUND = 20000
MAX_AUTHOR = 64
MAX_COVER = 512
MAX_CHAPTER_TITLE = 120
MAX_CONTENT = 200000
MAX_CHARACTER_NAME = 60
MAX_CHARACTER_FIELD = 200
MAX_INTRO = 4000
MAX_AGE = 64
MAX_EVENT_TIME = 64
MAX_EVENT_DESC = 4000
MAX_RELATION_TYPE = 32
MAX_RELATION_NOTE = 500

# 完结目标与阶段任务：建书时必填完结目标 + 目标章节数，用于控制整本篇幅
MAX_TARGET_CHAPTERS = 5000
MAX_TARGET_WORDS = 100_000_000
MAX_COMPLETION_GOAL = 2000
MAX_STAGES = 12
MAX_STAGE_NAME = 60
MAX_STAGE_GOAL = 600
NOVEL_STATUSES = ("serializing", "completed")

SORTS = ("new", "old", "name", "updated")

# --------------------------------------------------------------------------- #
# 建表 / 索引 / 迁移
# --------------------------------------------------------------------------- #

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS novel (
        novel_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        worldview TEXT NOT NULL DEFAULT '',
        background TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        author_user_id INTEGER NOT NULL DEFAULT 0,
        author_account_id INTEGER NOT NULL DEFAULT 0,
        cover TEXT NOT NULL DEFAULT '',
        completion_goal TEXT NOT NULL DEFAULT '',
        target_chapters INTEGER NOT NULL DEFAULT 0,
        target_words INTEGER NOT NULL DEFAULT 0,
        stages TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'serializing',
        finished_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    # 摘要两字段 NOT NULL + CHECK 双重兜底：服务端校验是第一道，DDL 是最后一道
    """CREATE TABLE IF NOT EXISTS chapter (
        chapter_id INTEGER PRIMARY KEY AUTOINCREMENT,
        novel_id INTEGER NOT NULL REFERENCES novel(novel_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '',
        one_line_summary TEXT NOT NULL CHECK (length(one_line_summary) BETWEEN 1 AND 32),
        summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    """CREATE TABLE IF NOT EXISTS character (
        character_id INTEGER PRIMARY KEY AUTOINCREMENT,
        novel_id INTEGER NOT NULL REFERENCES novel(novel_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        is_protagonist INTEGER NOT NULL DEFAULT 0,
        gender TEXT NOT NULL DEFAULT '',
        identity TEXT NOT NULL DEFAULT '',
        age TEXT NOT NULL DEFAULT '',
        intro TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    """CREATE TABLE IF NOT EXISTS character_event (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES character(character_id) ON DELETE CASCADE,
        event_time TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        chapter_id INTEGER REFERENCES chapter(chapter_id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    """CREATE TABLE IF NOT EXISTS world_event (
        world_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        novel_id INTEGER NOT NULL REFERENCES novel(novel_id) ON DELETE CASCADE,
        event_time TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        chapter_id INTEGER REFERENCES chapter(chapter_id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )""",
    # 唯一约束防重复边；CHECK 掐掉自环（服务端还会先验一次，给出更清楚的错误码）
    """CREATE TABLE IF NOT EXISTS relation (
        relation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        novel_id INTEGER NOT NULL REFERENCES novel(novel_id) ON DELETE CASCADE,
        character_a INTEGER NOT NULL REFERENCES character(character_id) ON DELETE CASCADE,
        character_b INTEGER NOT NULL REFERENCES character(character_id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        CHECK (character_a <> character_b),
        UNIQUE (novel_id, character_a, character_b, relation_type)
    )""",
]

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_chapter_novel ON chapter(novel_id, seq, chapter_id)",
    "CREATE INDEX IF NOT EXISTS idx_character_novel ON character(novel_id, is_protagonist DESC, character_id)",
    "CREATE INDEX IF NOT EXISTS idx_cevent_character ON character_event(character_id, event_id)",
    "CREATE INDEX IF NOT EXISTS idx_wevent_novel ON world_event(novel_id, world_event_id)",
    "CREATE INDEX IF NOT EXISTS idx_relation_novel ON relation(novel_id, relation_id)",
]

# 老库原地补列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
NOVEL_MIGRATIONS = [
    ("cover", "TEXT NOT NULL DEFAULT ''"),
    ("author_user_id", "INTEGER NOT NULL DEFAULT 0"),
    ("author_account_id", "INTEGER NOT NULL DEFAULT 0"),
    ("updated_at", "TEXT NOT NULL DEFAULT ''"),
    ("completion_goal", "TEXT NOT NULL DEFAULT ''"),
    ("target_chapters", "INTEGER NOT NULL DEFAULT 0"),
    ("target_words", "INTEGER NOT NULL DEFAULT 0"),
    ("stages", "TEXT NOT NULL DEFAULT '[]'"),
    ("status", "TEXT NOT NULL DEFAULT 'serializing'"),
    ("finished_at", "TEXT NOT NULL DEFAULT ''"),
]


# --------------------------------------------------------------------------- #
# 错误
# --------------------------------------------------------------------------- #

class ApiError(Exception):
    """带 HTTP 状态码与业务码的错误；code 会被前端直接用来分支。"""

    def __init__(self, message: str, status: int = 400, code: str = "bad_request", extra: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.extra = dict(extra or {})


# --------------------------------------------------------------------------- #
# 连接与建库
# --------------------------------------------------------------------------- #

def connect() -> sqlite3.Connection:
    """读写连接：WAL + 外键 + 5 秒忙等待，适合多线程 HTTP 服务。"""
    NOVEL_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(NOVEL_DB), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _ensure_columns(conn, table: str, migrations) -> list:
    cols = {r["name"] for r in conn.execute(f'PRAGMA table_info("{table}")')}
    added = []
    for name, ddl in migrations:
        if name not in cols:
            conn.execute(f'ALTER TABLE "{table}" ADD COLUMN {name} {ddl}')
            added.append(name)
    return added


def init_db() -> dict:
    """幂等建表 + 补列 + 建索引，返回库概览（供启动日志打印）。"""
    conn = connect()
    try:
        for stmt in SCHEMA:
            conn.execute(stmt)
        added = _ensure_columns(conn, "novel", NOVEL_MIGRATIONS)
        for stmt in INDEXES:
            conn.execute(stmt)
        conn.commit()
        return {
            "db": str(NOVEL_DB),
            "novels": conn.execute("SELECT COUNT(*) FROM novel").fetchone()[0],
            "chapters": conn.execute("SELECT COUNT(*) FROM chapter").fetchone()[0],
            "characters": conn.execute("SELECT COUNT(*) FROM character").fetchone()[0],
            "relations": conn.execute("SELECT COUNT(*) FROM relation").fetchone()[0],
            "added_columns": added,
        }
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# 通用工具
# --------------------------------------------------------------------------- #

def now_str() -> str:
    return datetime.now().strftime(TZ_STAMP)


def scalar_param(params: dict, key: str) -> str:
    value = params.get(key, "")
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return (value or "").strip() if isinstance(value, str) else str(value or "").strip()


def clean_text(value, field: str, limit: int, required: bool = True, default: str = "") -> str:
    text = "" if value is None else str(value).strip()
    if not text:
        if required:
            raise ApiError(f"{field}不能为空", 400, "invalid_param", {"field": field})
        return default
    if len(text) > limit:
        raise ApiError(
            f"{field}超长：{len(text)} 字，上限 {limit} 字",
            400,
            "invalid_param",
            {"field": field, "limit": limit, "length": len(text)},
        )
    return text


def clean_one_line_summary(value) -> str:
    """一句话摘要：必填、≤32 字。缺失与超长分别给不同业务码，前端可精确提示。"""
    text = "" if value is None else str(value).strip()
    if not text:
        raise ApiError(
            f"缺少一句话摘要 one_line_summary（必填，≤{MAX_ONE_LINE_SUMMARY} 字）",
            400,
            "one_line_summary_required",
            {"field": "one_line_summary", "limit": MAX_ONE_LINE_SUMMARY},
        )
    if len(text) > MAX_ONE_LINE_SUMMARY:
        raise ApiError(
            f"一句话摘要超长：{len(text)} 字，上限 {MAX_ONE_LINE_SUMMARY} 字",
            400,
            "one_line_summary_too_long",
            {"field": "one_line_summary", "limit": MAX_ONE_LINE_SUMMARY, "length": len(text)},
        )
    return text


def clean_summary(value) -> str:
    """章节概述：必填、≤200 字。"""
    text = "" if value is None else str(value).strip()
    if not text:
        raise ApiError(
            f"缺少章节概述 summary（必填，≤{MAX_SUMMARY} 字）",
            400,
            "summary_required",
            {"field": "summary", "limit": MAX_SUMMARY},
        )
    if len(text) > MAX_SUMMARY:
        raise ApiError(
            f"章节概述超长：{len(text)} 字，上限 {MAX_SUMMARY} 字",
            400,
            "summary_too_long",
            {"field": "summary", "limit": MAX_SUMMARY, "length": len(text)},
        )
    return text


def parse_int(value, field: str, default: int = 0, minimum: int = 0, maximum: int = 10 ** 9) -> int:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        num = int(str(value).strip())
    except (TypeError, ValueError):
        raise ApiError(f"{field}必须是整数", 400, "invalid_param", {"field": field})
    if num < minimum or num > maximum:
        raise ApiError(f"{field}超出范围（{minimum}~{maximum}）", 400, "invalid_param", {"field": field})
    return num


BOOL_TRUE = ("1", "true", "yes", "on", "y")
BOOL_FALSE = ("0", "false", "no", "off", "n")


def parse_bool(value, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in BOOL_TRUE:
        return True
    if text in BOOL_FALSE:
        return False
    return default


def _row(row) -> dict:
    return dict(row) if row is not None else {}


def clean_completion_goal(value, required: bool = True) -> str:
    """完结目标：建书必填，写清「写到什么程度算完结」。"""
    text = "" if value is None else str(value).strip()
    if not text:
        if required:
            raise ApiError(
                f"缺少完结目标 completion_goal（必填，≤{MAX_COMPLETION_GOAL} 字）",
                400,
                "completion_goal_required",
                {"field": "completion_goal", "limit": MAX_COMPLETION_GOAL},
            )
        return ""
    if len(text) > MAX_COMPLETION_GOAL:
        raise ApiError(
            f"完结目标超长：{len(text)} 字，上限 {MAX_COMPLETION_GOAL} 字",
            400,
            "invalid_param",
            {"field": "completion_goal", "limit": MAX_COMPLETION_GOAL, "length": len(text)},
        )
    return text


def clean_target_chapters(value, required: bool = True) -> int:
    """目标章节数：整本篇幅的主控开关，到数即自动完结。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ApiError(
                f"缺少目标章节数 target_chapters（必填，1~{MAX_TARGET_CHAPTERS}）",
                400,
                "target_chapters_required",
                {"field": "target_chapters", "minimum": 1, "maximum": MAX_TARGET_CHAPTERS},
            )
        return 0
    return parse_int(value, "目标章节数 target_chapters", 0, 1, MAX_TARGET_CHAPTERS)


def clean_stages(value) -> str:
    """阶段任务：接受 JSON 数组文本或数组本体，统一存成 JSON 文本。

    每项形如 {"name": "...", "from_chapter": 1, "to_chapter": 10, "goal": "..."}，
    区间必须从 1 起、逐段递增且不重叠，免得 AI 连载时找不到自己在哪一段。
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return "[]"
    raw = value
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raise ApiError("阶段任务 stages 不是合法 JSON", 400, "invalid_param", {"field": "stages"})
    if not isinstance(raw, list):
        raise ApiError("阶段任务 stages 必须是数组", 400, "invalid_param", {"field": "stages"})
    if len(raw) > MAX_STAGES:
        raise ApiError(
            f"阶段任务过多：{len(raw)} 个，上限 {MAX_STAGES} 个",
            400,
            "invalid_param",
            {"field": "stages", "limit": MAX_STAGES},
        )
    stages, prev_to = [], 0
    for idx, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ApiError(f"第 {idx} 个阶段必须是对象", 400, "invalid_param", {"field": "stages"})
        name = clean_text(item.get("name") or item.get("title"), f"第 {idx} 个阶段名称", MAX_STAGE_NAME)
        goal = clean_text(item.get("goal") or item.get("description"), f"第 {idx} 个阶段目标",
                          MAX_STAGE_GOAL, required=False)
        start = parse_int(item.get("from_chapter", item.get("from")), f"第 {idx} 个阶段起始章",
                          0, 0, MAX_TARGET_CHAPTERS)
        end = parse_int(item.get("to_chapter", item.get("to")), f"第 {idx} 个阶段结束章",
                        0, 0, MAX_TARGET_CHAPTERS)
        if not start or not end:
            raise ApiError(f"第 {idx} 个阶段必须给出 from_chapter 与 to_chapter",
                           400, "invalid_param", {"field": "stages"})
        if end < start:
            raise ApiError(f"第 {idx} 个阶段结束章（{end}）小于起始章（{start}）",
                           400, "invalid_param", {"field": "stages"})
        if start <= prev_to:
            raise ApiError(f"第 {idx} 个阶段区间与前序阶段重叠或未递增（起始章 {start} ≤ 前一段结束章 {prev_to}）",
                           400, "invalid_param", {"field": "stages"})
        prev_to = end
        stages.append({"name": name, "from_chapter": start, "to_chapter": end, "goal": goal})
    return json.dumps(stages, ensure_ascii=False)


def parse_stages(text) -> list:
    """库里存的是 JSON 文本，读出来转成数组；坏数据不抛错，按空阶段处理。"""
    if not text:
        return []
    if isinstance(text, list):
        return text
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


def novel_progress(novel: dict, stages=None) -> dict:
    """按章节数算目标进度与所处阶段：前端进度条与 AI 续写都读这一份。"""
    target = int(novel.get("target_chapters") or 0)
    done = int(novel.get("chapter_count") or 0)
    words = int(novel.get("word_count") or 0)
    target_words = int(novel.get("target_words") or 0)
    if stages is None:
        stages = parse_stages(novel.get("stages"))
    current = None
    for idx, stage in enumerate(stages, 1):
        start = int(stage.get("from_chapter") or 0)
        end = int(stage.get("to_chapter") or 0)
        if done < start:
            break
        current = {"index": idx, **stage}
        if done <= end:
            break
    remain = max(target - done, 0) if target else 0
    percent = round(done * 100.0 / target, 1) if target else 0.0
    return {
        "status": novel.get("status") or "serializing",
        "finished_at": novel.get("finished_at") or "",
        "target_chapters": target,
        "target_words": target_words,
        "chapter_count": done,
        "word_count": words,
        "remaining_chapters": remain,
        "percent": min(percent, 100.0),
        "reached": bool(target and done >= target),
        "current_stage": current,
        "stage_count": len(stages),
        "stages_done": sum(1 for s in stages if done > int(s.get("to_chapter") or 0)),
    }


NUM_RE = re.compile(r"\d+")


def event_sort_key(row: dict):
    """事件时间排序键：先按时间串里抽出的数字序列排（帝国历2年 < 帝国历10年），
    纯文字纪年（如"第二纪元"抽不出数字）排在后面按原串排。
    """
    text = (row.get("event_time") or "").strip()
    nums = [int(x) for x in NUM_RE.findall(text)]
    return (0 if nums else 1, nums, text, row.get("event_id") or 0)


# --------------------------------------------------------------------------- #
# 鉴权：站点用户 + 小说 AI 作者令牌
# --------------------------------------------------------------------------- #

AI_AUTHOR_ROLE = "ai_author"
AI_ACCOUNT_TYPE_NOVEL = 2          # forum_ai_account.account_type：1=论坛AI，2=小说AI作者


def _forum_module():
    """身份解析一律复用 forum，本模块不复制令牌 / 会话逻辑。"""
    try:
        import forum as forum_module
    except Exception:                             # noqa: BLE001  极端情况下降级到 Cookie 会话
        return None
    return forum_module


def _row_value(row, key, default=None):
    """sqlite3.Row / dict 通用取值（老库可能缺列）。"""
    if row is None:
        return default
    try:
        keys = row.keys()
    except AttributeError:
        return (row or {}).get(key, default)
    return row[key] if key in keys else default


def is_ai_author(user: dict) -> bool:
    return bool((user or {}).get("is_ai_author"))


def writer_out(user: dict) -> dict:
    """对外回显写作者身份（不含任何令牌明文）。"""
    return {
        "id": int((user or {}).get("id") or 0),
        "name": author_of(user),
        "username": str((user or {}).get("username") or ""),
        "role": str((user or {}).get("role") or ""),
        "is_ai_author": is_ai_author(user),
        "ai_account_id": int((user or {}).get("ai_account_id") or 0),
    }


def ai_author_from_principal(principal) -> dict | None:
    """把 forum.resolve_principal 的 ai_account 主体翻译成小说板块的写作者身份。

    仅 account_type=2（小说 AI 作者）且 is_active=1 的账号可写作；论坛 AI（1）令牌
    即便有效也一律 403，避免「论坛号」越界写小说。伪用户字段刻意与站点用户对齐：
    id=owner_user_id（数据归属人）、username=slug、display_name=AI 笔名、role=ai_author，
    这样 author_of() 落库的就是 AI 自己的笔名，既有 SQL 与前端展示都不必改。
    """
    if not principal or principal.get("kind") != "ai_account":
        return None
    account = principal.get("ai_account")
    if account is None:
        return None
    if not int(_row_value(account, "is_active", 0) or 0):
        raise ApiError("该 AI 账号已停用", 401, "invalid_token")
    acc_type = int(_row_value(account, "account_type", 1) or 1)
    if acc_type != AI_ACCOUNT_TYPE_NOVEL:
        raise ApiError(
            "该 AI 账号不是小说 AI 作者（account_type=1 为论坛 AI），不能用于小说写作",
            403, "not_novel_author", {"account_type": acc_type},
        )
    return {
        "id": int(_row_value(account, "owner_user_id", 0) or 0),
        "username": str(_row_value(account, "slug", "") or "").strip(),
        "display_name": str(_row_value(account, "name", "") or "").strip(),
        "role": AI_AUTHOR_ROLE,
        "is_ai_author": True,
        "ai_account_id": int(_row_value(account, "id", 0) or 0),
    }


def _ai_author_from_handler(handler):
    """用 Authorization 里的 ak-ai- 令牌识别小说 AI 作者；非 AI 令牌返回 None。"""
    forum_module = _forum_module()
    if forum_module is None:
        return None
    try:
        principal = forum_module.resolve_principal(handler)
    except forum_module.ApiError as e:
        raise ApiError(
            getattr(e, "message", str(e)),
            getattr(e, "status", 401),
            getattr(e, "code", "invalid_token"),
            getattr(e, "extra", None),
        )
    return ai_author_from_principal(principal)


def require_writer(handler) -> dict:
    """写操作身份：先站点用户（Cookie 会话 / ak- 用户令牌），再回落 AI 作者令牌。

    回落路径复用 forum.resolve_principal，只认 ak-ai- 且 account_type=2、is_active=1 的账号；
    识别不出任何身份时保持原有的 401，既有写接口的口径不变。
    """
    forum_module = _forum_module()
    if forum_module is not None:
        try:
            return forum_module.require_site_user(handler)
        except forum_module.ApiError as e:
            status = getattr(e, "status", 401)
            if status == 401:                     # 只有"认不出身份"才回落，403 等原样抛出
                author = _ai_author_from_handler(handler)
                if author is not None:
                    return author
            raise ApiError(
                getattr(e, "message", str(e)),
                status,
                getattr(e, "code", "invalid_token"),
                getattr(e, "extra", None),
            )
    user = site_auth.current_user(handler)
    if user:
        return user
    author = _ai_author_from_handler(handler)
    if author is not None:
        return author
    raise ApiError(
        "请先登录，或携带 Authorization: Bearer <用户令牌 / AI 作者令牌>", 401, "login_required")


def user_is_admin(user: dict) -> bool:
    return (user or {}).get("role") == site_auth.ROLE_ADMIN


def author_of(user: dict) -> str:
    return str((user or {}).get("display_name") or (user or {}).get("username") or "").strip()


def novel_author_name(novel_row) -> str:
    if novel_row is None:
        return ""
    return str((novel_row.get("author") if isinstance(novel_row, dict)
                else _row_value(novel_row, "author", "")) or "").strip()


def assert_novel_writable(user: dict, novel_row) -> None:
    """小说及其附属资源的写权限：管理员 / 创建者本人 / AI 作者只能写自己笔名的书。

    AI 作者刻意不走 author_user_id 判定——伪用户 id 就是 owner_user_id，
    若沿用旧规则，站长名下的所有书都会被 AI 号改写，这里以笔名严格收口。
    """
    if not novel_row:
        raise ApiError("小说不存在", 404, "novel_not_found")
    if user_is_admin(user):
        return
    if is_ai_author(user):
        own = author_of(user)
        acc_id = int(user.get("ai_account_id") or 0)
        row_acc = int(_row_value(novel_row, "author_account_id", 0) or 0)
        # 书上有 AI 账号归属时就认账号 id，避免「同名不同号」的 AI 作者互相越权；
        # 历史书 / 人工建的书 author_account_id=0，退化为按笔名判定。
        if row_acc > 0 and row_acc == acc_id:
            return
        if row_acc == 0 and own and novel_author_name(novel_row) == own:
            return
        raise ApiError(f"AI 作者只能修改笔名为「{own}」的作品", 403, "forbidden",
                       {"author": novel_author_name(novel_row), "author_account_id": row_acc})
    if int(novel_row["author_user_id"] or 0) == int(user["id"]):
        return
    raise ApiError("只有小说创建者或管理员可以修改这本书", 403, "forbidden")


# --------------------------------------------------------------------------- #
# 页面
# --------------------------------------------------------------------------- #

PAGE_MAP = {
    "/novel": "novel.html",
    "/novel/index.html": "novel.html",
    "/novel/books": "novel.html",
    "/novel/books.html": "novel.html",
}

# 带路径参数的页面：前端从 location.pathname 里取 novel_id / character_id
PAGE_ROUTES = [
    (re.compile(r"^/novel/book/(\d+)$"), "novel-book.html"),
    (re.compile(r"^/novel/book/(\d+)/read/(\d+)$"), "novel-read.html"),
    (re.compile(r"^/novel/book/(\d+)/characters$"), "novel-characters.html"),
    (re.compile(r"^/novel/book/(\d+)/timeline$"), "novel-timeline.html"),
    (re.compile(r"^/novel/book/(\d+)/graph$"), "novel-graph.html"),
    (re.compile(r"^/novel/character/(\d+)$"), "novel-character.html"),
]

PAGE_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


def _send_file(handler, name: str) -> None:
    target = (STATIC_DIR / name).resolve()
    try:
        target.relative_to(STATIC_DIR.resolve())
    except ValueError:
        return handler._json({"ok": False, "error": "非法路径", "code": "forbidden"}, 403)
    if not target.is_file():
        return handler._json({"ok": False, "error": f"页面缺失：{name}", "code": "not_found"}, 404)
    ctype = PAGE_MIME.get(target.suffix.lower(), "application/octet-stream")
    handler._send(200, target.read_bytes(), ctype)


GZIP_MIN_BYTES = 512


def _accepts_gzip(handler) -> bool:
    """解析 Accept-Encoding，判断客户端是否接受 gzip。"""
    try:
        header = handler.headers.get("Accept-Encoding") or ""
    except Exception:  # noqa: BLE001 —— 无 headers 的测试桩按明文处理
        return False
    for part in header.split(","):
        token = part.strip().split(";")[0].strip().lower()
        if token in ("gzip", "*"):
            return True
    return False


def _send_json_maybe_gzip(handler, payload: dict, code: int = 200) -> None:
    """正文类接口统一出口：客户端声明 gzip 且体积够大时压缩后传输。

    零第三方依赖，只用标准库 gzip；Content-Encoding / Vary 全部自行写头，
    未声明 gzip（或体积很小）时退回明文，语义与 handler._json 完全一致。
    """
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    if len(body) >= GZIP_MIN_BYTES and _accepts_gzip(handler):
        packed = gzip.compress(body, 6)
        return handler._send(code, packed, "application/json; charset=utf-8", {
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
            "Cache-Control": "no-store",
        })
    return handler._json(payload, code)


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

def handle(handler, method: str, path: str, qs: dict) -> bool:
    """返回 True 表示本模块已处理该请求。"""
    is_page = path == "/novel" or path.startswith("/novel/")
    is_api = path.startswith("/api/novel")
    if not (is_page or is_api):
        return False

    if method == "OPTIONS":
        handler.send_response(204)
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        handler.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return True

    if is_page:
        if path in PAGE_MAP:
            _send_file(handler, PAGE_MAP[path])
            return True
        for pattern, page in PAGE_ROUTES:
            if pattern.match(path):
                _send_file(handler, page)
                return True
        # 静态资源走 server 的 /static/ 路由，这里不再兜底
        return False

    conn = None
    try:
        conn = connect()
        _dispatch(handler, method, path, qs, conn)
    except ApiError as e:
        payload = {"ok": False, "error": e.message, "code": e.code}
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
    p = path[len("/api/novel"):] or "/"
    params = {k: (v[0] if isinstance(v, list) and v else "") for k, v in qs.items()}

    if method == "GET":
        _dispatch_get(handler, p, params, conn)
    elif method == "POST":
        _dispatch_post(handler, p, conn)
    elif method in ("PUT", "PATCH"):
        _dispatch_put(handler, p, conn)
    elif method == "DELETE":
        _dispatch_delete(handler, p, conn)
    else:
        raise ApiError(f"不支持的方法：{method}", 405, "method_not_allowed")


# --------------------------------------------------------------------------- #
# GET
# --------------------------------------------------------------------------- #

def _dispatch_get(handler, p: str, params: dict, conn) -> None:
    if p == "/health":
        return handler._json({
            "ok": True,
            "module": "novel",
            "db": NOVEL_DB.name,
            "time": now_str(),
            "novels": conn.execute("SELECT COUNT(*) FROM novel").fetchone()[0],
            "chapters": conn.execute("SELECT COUNT(*) FROM chapter").fetchone()[0],
        })

    if p == "/novels":
        return handler._json({"ok": True, **_list_novels(conn, _resolve_mine_params(handler, params))})

    # 写作者自查：AI 作者令牌进来时回显自己的伪用户身份（不含令牌明文）
    if p == "/writer":
        writer = require_writer(handler)
        return handler._json({"ok": True, "writer": writer_out(writer)})

    m = re.match(r"^/novels/(\d+)$", p)
    if m:
        return handler._json({"ok": True, "novel": _get_novel(conn, int(m.group(1)))})

    # AI 续写前先看目标：还剩几章、当前处在哪个阶段、是否已到完结线
    m = re.match(r"^/novels/(\d+)/goal$", p)
    if m:
        novel = _get_novel(conn, int(m.group(1)))
        return handler._json({
            "ok": True,
            "novel_id": novel["novel_id"],
            "name": novel["name"],
            "completion_goal": novel.get("completion_goal") or "",
            "stages": novel["stages"],
            "progress": novel["progress"],
        })

    m = re.match(r"^/novels/(\d+)/chapters$", p)
    if m:
        novel = _get_novel(conn, int(m.group(1)))
        return handler._json({"ok": True, "novel_id": novel["novel_id"], **_list_chapters(conn, novel["novel_id"])})

    m = re.match(r"^/novels/(\d+)/read/(\d+)$", p)
    if m:
        # 阅读页正文接口：声明 gzip 时压缩传输，未声明时明文
        return _send_json_maybe_gzip(handler, {"ok": True, **_read_chapter(conn, int(m.group(1)), int(m.group(2)))})

    m = re.match(r"^/chapters/(\d+)$", p)
    if m:
        chapter = _get_chapter(conn, int(m.group(1)))
        return _send_json_maybe_gzip(handler, {"ok": True, "chapter": chapter})

    # AI 快速取写作进度：只回摘要两字段
    m = re.match(r"^/chapters/(\d+)/summary$", p)
    if m:
        chapter = _get_chapter(conn, int(m.group(1)))
        return handler._json({
            "ok": True,
            "chapter_id": chapter["chapter_id"],
            "novel_id": chapter["novel_id"],
            "title": chapter["title"],
            "seq": chapter["seq"],
            "one_line_summary": chapter["one_line_summary"],
            "summary": chapter["summary"],
        })

    m = re.match(r"^/novels/(\d+)/characters$", p)
    if m:
        novel = _get_novel(conn, int(m.group(1)))
        return handler._json({"ok": True, "novel_id": novel["novel_id"], **_list_characters(conn, novel["novel_id"])})

    m = re.match(r"^/characters/(\d+)$", p)
    if m:
        return handler._json({"ok": True, "character": _get_character(conn, int(m.group(1)))})

    m = re.match(r"^/characters/(\d+)/events$", p)
    if m:
        character = _get_character(conn, int(m.group(1)))
        return handler._json({
            "ok": True,
            "character": {"character_id": character["character_id"], "name": character["name"],
                          "novel_id": character["novel_id"]},
            **_list_character_events(conn, character["character_id"]),
        })

    m = re.match(r"^/novels/(\d+)/events$", p)
    if m:
        novel = _get_novel(conn, int(m.group(1)))
        return handler._json({"ok": True, "novel_id": novel["novel_id"], **_list_world_events(conn, novel["novel_id"])})

    m = re.match(r"^/novels/(\d+)/relations$", p)
    if m:
        novel = _get_novel(conn, int(m.group(1)))
        return handler._json({"ok": True, "novel_id": novel["novel_id"], **_list_relations(conn, novel["novel_id"])})

    # 拓扑图一次性取全：节点 + 边
    m = re.match(r"^/novels/(\d+)/graph$", p)
    if m:
        novel = _get_novel(conn, int(m.group(1)))
        chars = _list_characters(conn, novel["novel_id"])["items"]
        rels = _list_relations(conn, novel["novel_id"])["items"]
        nodes = [
            {"id": c["character_id"], "name": c["name"], "is_protagonist": c["is_protagonist"],
             "identity": c.get("identity", "")}
            for c in chars
        ]
        edges = [
            {"id": r["relation_id"], "source": r["character_a"], "target": r["character_b"],
             "type": r["relation_type"], "note": r["note"],
             "source_name": r["a_name"], "target_name": r["b_name"]}
            for r in rels
        ]
        return handler._json({"ok": True, "novel": {"novel_id": novel["novel_id"], "name": novel["name"]},
                              "nodes": nodes, "edges": edges})

    raise ApiError("未知接口：" + path, 404, "not_found")


def _resolve_mine_params(handler, params: dict) -> dict:
    """?mine=1 时用当前写作者身份反查「自己的作品」，无需调用方硬编码笔名。

    游客不带 mine 参数照旧可读列表；带了 mine 却没身份则按写接口口径 401。
    """
    flag = str(params.get("mine") or params.get("self") or "").strip().lower()
    if flag not in ("1", "true", "yes", "on"):
        return params
    writer = require_writer(handler)
    merged = {k: v for k, v in params.items() if k not in ("author", "ai_author", "author_account_id")}
    merged["author"] = author_of(writer)
    if is_ai_author(writer):
        merged["author_account_id"] = str(writer.get("ai_account_id") or 0)
    return merged


def _list_novels(conn, params: dict) -> dict:
    q = scalar_param(params, "q")
    sort = scalar_param(params, "sort") or "new"
    if sort not in SORTS:
        raise ApiError(f"sort 仅支持：{'/'.join(SORTS)}", 400, "invalid_param", {"field": "sort"})
    page = parse_int(params.get("page"), "page", 1, 1, 100000)
    page_size = parse_int(params.get("page_size"), "page_size", 20, 1, 100)
    # 按作者筛选：author 与 ai_author 等价（供 AI 作者 / 定时任务读取「自己的作品」）
    author = (scalar_param(params, "author") or scalar_param(params, "ai_author") or "").strip()
    if len(author) > MAX_AUTHOR:
        raise ApiError(f"author 超长：{len(author)} 字，上限 {MAX_AUTHOR} 字",
                       400, "invalid_param", {"field": "author", "limit": MAX_AUTHOR})
    author_account_id = parse_int(params.get("author_account_id"), "author_account_id", 0, 0, 10 ** 9)
    # 状态筛选：AI 续写时用 status=serializing 挑未完结的书，跳过已完结作品
    status = (scalar_param(params, "status") or "").strip().lower()
    if status and status not in NOVEL_STATUSES:
        raise ApiError(f"status 仅支持：{'/'.join(NOVEL_STATUSES)}", 400, "invalid_param", {"field": "status"})

    where, args = [], []
    if q:
        where.append("(name LIKE ? ESCAPE '\\' OR worldview LIKE ? ESCAPE '\\' OR background LIKE ? ESCAPE '\\')")
        needle = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        args += [needle, needle, needle]
    if author:
        where.append("author = ?")
        args.append(author)
    if author_account_id:
        where.append("author_account_id = ?")
        args.append(author_account_id)
    if status:
        where.append("COALESCE(NULLIF(status, ''), 'serializing') = ?")
        args.append(status)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    order = {
        "new": "novel_id DESC",
        "old": "novel_id ASC",
        "name": "name COLLATE NOCASE ASC, novel_id ASC",
        "updated": "updated_at DESC, novel_id DESC",
    }[sort]

    total = conn.execute(f"SELECT COUNT(*) FROM novel {clause}", args).fetchone()[0]
    rows = conn.execute(
        f"""SELECT n.*,
                   (SELECT COUNT(*) FROM chapter c WHERE c.novel_id = n.novel_id) AS chapter_count,
                   (SELECT COALESCE(SUM(length(c.content)), 0) FROM chapter c
                     WHERE c.novel_id = n.novel_id) AS word_count,
                   (SELECT COUNT(*) FROM character ch WHERE ch.novel_id = n.novel_id) AS character_count,
                   (SELECT one_line_summary FROM chapter c WHERE c.novel_id = n.novel_id
                     ORDER BY seq DESC, chapter_id DESC LIMIT 1) AS latest_summary
              FROM novel n {clause}
             ORDER BY {order} LIMIT ? OFFSET ?""",
        args + [page_size, (page - 1) * page_size],
    ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        stages = parse_stages(item.get("stages"))
        item["stages"] = stages
        item["progress"] = novel_progress(item, stages)
        items.append(item)
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size,
        "q": q,
        "sort": sort,
        "author": author,
        "author_account_id": author_account_id,
        "status": status,
    }


def _get_novel(conn, novel_id: int) -> dict:
    row = conn.execute("SELECT * FROM novel WHERE novel_id = ?", (novel_id,)).fetchone()
    if not row:
        raise ApiError(f"小说不存在：{novel_id}", 404, "novel_not_found")
    novel = dict(row)
    novel["chapter_count"] = conn.execute(
        "SELECT COUNT(*) FROM chapter WHERE novel_id = ?", (novel_id,)).fetchone()[0]
    novel["character_count"] = conn.execute(
        "SELECT COUNT(*) FROM character WHERE novel_id = ?", (novel_id,)).fetchone()[0]
    novel["word_count"] = conn.execute(
        "SELECT COALESCE(SUM(length(content)), 0) FROM chapter WHERE novel_id = ?", (novel_id,)).fetchone()[0]
    novel["relation_count"] = conn.execute(
        "SELECT COUNT(*) FROM relation WHERE novel_id = ?", (novel_id,)).fetchone()[0]
    novel["world_event_count"] = conn.execute(
        "SELECT COUNT(*) FROM world_event WHERE novel_id = ?", (novel_id,)).fetchone()[0]
    latest = conn.execute(
        "SELECT one_line_summary FROM chapter WHERE novel_id = ? ORDER BY seq DESC, chapter_id DESC LIMIT 1",
        (novel_id,)).fetchone()
    novel["latest_summary"] = latest["one_line_summary"] if latest else ""
    stages = parse_stages(novel.get("stages"))
    novel["stages"] = stages
    novel["progress"] = novel_progress(novel, stages)
    return novel


def _list_chapters(conn, novel_id: int) -> dict:
    """章节列表默认只回摘要，不回正文——正文动辄上万字，列表不需要。"""
    rows = conn.execute(
        """SELECT chapter_id, novel_id, title, seq, one_line_summary, summary, created_at,
                  length(content) AS content_length
             FROM chapter WHERE novel_id = ? ORDER BY seq ASC, chapter_id ASC""",
        (novel_id,),
    ).fetchall()
    return {"items": [dict(r) for r in rows], "total": len(rows)}


def _get_chapter(conn, chapter_id: int) -> dict:
    row = conn.execute("SELECT * FROM chapter WHERE chapter_id = ?", (chapter_id,)).fetchone()
    if not row:
        raise ApiError(f"章节不存在：{chapter_id}", 404, "chapter_not_found")
    chapter = dict(row)
    chapter["content_length"] = len(chapter.get("content") or "")
    character_events = conn.execute(
        "SELECT COUNT(*) FROM character_event WHERE chapter_id = ?", (chapter_id,)).fetchone()[0]
    world_events = conn.execute(
        "SELECT COUNT(*) FROM world_event WHERE chapter_id = ?", (chapter_id,)).fetchone()[0]
    chapter["character_event_count"] = character_events
    chapter["world_event_count"] = world_events
    return chapter


def _read_chapter(conn, novel_id: int, seq: int) -> dict:
    """阅读页数据包：目录 + 单章正文 + 上一章/下一章，一次请求搞定。

    只有本接口携带 content；章节目录仅回 chapter_id/title/seq，避免正文重复下发。
    """
    novel = _get_novel(conn, novel_id)
    toc_rows = conn.execute(
        "SELECT chapter_id, title, seq FROM chapter WHERE novel_id = ? ORDER BY seq ASC, chapter_id ASC",
        (novel_id,)).fetchall()
    toc = [dict(r) for r in toc_rows]
    if not toc:
        raise ApiError("这本书还没有章节", 404, "chapter_not_found", {"novel_id": novel_id})

    row = conn.execute(
        """SELECT chapter_id, novel_id, title, seq, content, one_line_summary, summary, created_at
             FROM chapter WHERE novel_id = ? AND seq = ? ORDER BY chapter_id ASC LIMIT 1""",
        (novel_id, seq)).fetchone()
    if not row:
        raise ApiError(f"章节不存在：第 {seq} 章", 404, "chapter_not_found",
                       {"novel_id": novel_id, "seq": seq})
    chapter = dict(row)
    chapter["char_count"] = len(chapter.get("content") or "")

    seqs = [c["seq"] for c in toc]
    idx = seqs.index(chapter["seq"])
    return {
        "novel": {
            "novel_id": novel["novel_id"],
            "name": novel["name"],
            "author": novel["author"],
            "chapter_count": novel["chapter_count"],
        },
        "chapter": chapter,
        "toc": toc,
        "total": len(toc),
        "index": idx + 1,
        "prev_seq": seqs[idx - 1] if idx > 0 else 0,
        "next_seq": seqs[idx + 1] if idx < len(seqs) - 1 else 0,
    }


def _list_characters(conn, novel_id: int) -> dict:
    rows = conn.execute(
        """SELECT character_id, novel_id, name, is_protagonist, gender, identity, age, intro, created_at
             FROM character WHERE novel_id = ?
            ORDER BY is_protagonist DESC, character_id ASC""",
        (novel_id,),
    ).fetchall()
    items = [dict(r) for r in rows]
    for item in items:
        item["is_protagonist"] = 1 if item["is_protagonist"] else 0
    return {"items": items, "total": len(items)}


def _get_character(conn, character_id: int) -> dict:
    row = conn.execute("SELECT * FROM character WHERE character_id = ?", (character_id,)).fetchone()
    if not row:
        raise ApiError(f"角色不存在：{character_id}", 404, "character_not_found")
    character = dict(row)
    character["is_protagonist"] = 1 if character["is_protagonist"] else 0
    novel = conn.execute("SELECT novel_id, name FROM novel WHERE novel_id = ?", (character["novel_id"],)).fetchone()
    character["novel_name"] = novel["name"] if novel else ""
    character["event_count"] = conn.execute(
        "SELECT COUNT(*) FROM character_event WHERE character_id = ?", (character_id,)).fetchone()[0]
    return character


def _list_character_events(conn, character_id: int) -> dict:
    rows = conn.execute(
        """SELECT e.event_id, e.character_id, e.event_time, e.description, e.chapter_id,
                  e.created_at, c.title AS chapter_title
             FROM character_event e LEFT JOIN chapter c ON c.chapter_id = e.chapter_id
            WHERE e.character_id = ?""",
        (character_id,),
    ).fetchall()
    items = [dict(r) for r in rows]
    items.sort(key=event_sort_key)
    return {"items": items, "total": len(items)}


def _list_world_events(conn, novel_id: int) -> dict:
    rows = conn.execute(
        """SELECT w.world_event_id, w.novel_id, w.event_time, w.description, w.chapter_id,
                  w.created_at, c.title AS chapter_title
             FROM world_event w LEFT JOIN chapter c ON c.chapter_id = w.chapter_id
            WHERE w.novel_id = ?""",
        (novel_id,),
    ).fetchall()
    items = [dict(r) for r in rows]
    items.sort(key=event_sort_key)
    return {"items": items, "total": len(items)}


def _list_relations(conn, novel_id: int) -> dict:
    rows = conn.execute(
        """SELECT r.relation_id, r.novel_id, r.character_a, r.character_b, r.relation_type,
                  r.note, r.created_at,
                  ca.name AS a_name, ca.is_protagonist AS a_protagonist,
                  cb.name AS b_name, cb.is_protagonist AS b_protagonist
             FROM relation r
             JOIN character ca ON ca.character_id = r.character_a
             JOIN character cb ON cb.character_id = r.character_b
            WHERE r.novel_id = ?
            ORDER BY r.relation_id ASC""",
        (novel_id,),
    ).fetchall()
    items = [dict(r) for r in rows]
    # 同时给出 source/target/type 与 source_name/target_name 别名，
    # 让 /relations 与 /graph 的边字段完全一致，前端画图和列表可以共用一套渲染逻辑。
    for item in items:
        item["id"] = item["relation_id"]
        item["source"] = item["character_a"]
        item["target"] = item["character_b"]
        item["type"] = item["relation_type"]
        item["source_name"] = item["a_name"]
        item["target_name"] = item["b_name"]
    return {"items": items, "total": len(items)}


# --------------------------------------------------------------------------- #
# POST
# --------------------------------------------------------------------------- #

def _dispatch_post(handler, p: str, conn) -> None:
    if p == "/novels":
        return _create_novel(handler, conn)

    m = re.match(r"^/novels/(\d+)/complete$", p)
    if m:
        return _complete_novel(handler, conn, int(m.group(1)))

    m = re.match(r"^/novels/(\d+)/chapters$", p)
    if m:
        return _create_chapter(handler, conn, int(m.group(1)))

    m = re.match(r"^/novels/(\d+)/characters$", p)
    if m:
        return _create_character(handler, conn, int(m.group(1)))

    m = re.match(r"^/characters/(\d+)/events$", p)
    if m:
        return _create_character_event(handler, conn, int(m.group(1)))

    m = re.match(r"^/novels/(\d+)/events$", p)
    if m:
        return _create_world_event(handler, conn, int(m.group(1)))

    m = re.match(r"^/novels/(\d+)/relations$", p)
    if m:
        return _create_relation(handler, conn, int(m.group(1)))

    raise ApiError(f"未知接口：{p}", 404, "not_found")


def _read_json(handler) -> dict:
    return handler._read_body(limit=2_000_000)


def _create_novel(handler, conn) -> None:
    user = require_writer(handler)
    payload = _read_json(handler)
    name = clean_text(payload.get("name"), "小说名称", MAX_NOVEL_NAME)
    worldview = clean_text(payload.get("worldview"), "世界观设定", MAX_WORLDVIEW, required=False)
    background = clean_text(payload.get("background"), "背景描述", MAX_BACKGROUND, required=False)
    cover = clean_text(payload.get("cover"), "封面", MAX_COVER, required=False)
    # 完结目标与篇幅上限：世界观/背景之外必须先想清楚「这本书写到哪儿算完」
    completion_goal = clean_completion_goal(
        payload.get("completion_goal", payload.get("goal")))
    target_chapters = clean_target_chapters(
        payload.get("target_chapters", payload.get("target_chapter_count")))
    target_words = parse_int(payload.get("target_words", payload.get("target_word_count")),
                             "目标字数 target_words", 0, 0, MAX_TARGET_WORDS)
    stages = clean_stages(payload.get("stages", payload.get("stage_plan")))
    stamp = now_str()
    # AI 作者：author 落笔名、author_user_id 落归属人、author_account_id 落 AI 账号 id
    author_account_id = int(user.get("ai_account_id") or 0) if is_ai_author(user) else 0
    cur = conn.execute(
        """INSERT INTO novel (name, worldview, background, author, author_user_id,
                              author_account_id, cover, completion_goal, target_chapters,
                              target_words, stages, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'serializing', ?, ?)""",
        (name, worldview, background, author_of(user)[:MAX_AUTHOR], int(user["id"]),
         author_account_id, cover, completion_goal, target_chapters, target_words,
         stages, stamp, stamp),
    )
    conn.commit()
    handler._json({"ok": True, "novel": _get_novel(conn, int(cur.lastrowid)),
                   "writer": writer_out(user)}, 201)


def _create_chapter(handler, conn, novel_id: int) -> None:
    """新增章节：摘要两字段强制校验通过后才动库；world_event 与章节同一事务写入。"""
    user = require_writer(handler)
    novel = _get_novel(conn, novel_id)
    assert_novel_writable(user, novel)
    payload = _read_json(handler)

    title = clean_text(payload.get("title"), "章节标题", MAX_CHAPTER_TITLE)
    content = clean_text(payload.get("content"), "章节正文", MAX_CONTENT, required=False)
    one_line_summary = clean_one_line_summary(payload.get("one_line_summary"))
    summary = clean_summary(payload.get("summary"))

    seq = parse_int(payload.get("seq"), "章节序号", 0, 0, 100000)
    if not seq:
        seq = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM chapter WHERE novel_id = ?", (novel_id,)).fetchone()[0]

    # 章节上传时可顺带上报世界大事件
    world_desc = str(payload.get("world_event") or payload.get("world_event_description") or "").strip()
    world_time = str(payload.get("world_event_time") or "").strip()
    if len(world_desc) > MAX_EVENT_DESC:
        raise ApiError(f"世界大事件描述超长：{len(world_desc)} 字，上限 {MAX_EVENT_DESC} 字",
                       400, "invalid_param", {"field": "world_event", "limit": MAX_EVENT_DESC})
    if len(world_time) > MAX_EVENT_TIME:
        raise ApiError(f"世界大事件时间超长：{len(world_time)} 字，上限 {MAX_EVENT_TIME} 字",
                       400, "invalid_param", {"field": "world_event_time", "limit": MAX_EVENT_TIME})

    stamp = now_str()
    world_event = None
    auto_completed = False
    try:
        cur = conn.execute(
            """INSERT INTO chapter (novel_id, title, seq, content, one_line_summary, summary, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (novel_id, title, seq, content, one_line_summary, summary, stamp),
        )
        chapter_id = int(cur.lastrowid)
        conn.execute("UPDATE novel SET updated_at = ? WHERE novel_id = ?", (stamp, novel_id))
        # 篇幅闸门：写到目标章节数就自动完结，后续续写任务看到 status=completed 即收手
        target_chapters = int(novel.get("target_chapters") or 0)
        if target_chapters and (novel.get("status") or "serializing") != "completed":
            done = conn.execute("SELECT COUNT(*) FROM chapter WHERE novel_id = ?",
                                (novel_id,)).fetchone()[0]
            if done >= target_chapters:
                conn.execute(
                    "UPDATE novel SET status = 'completed', finished_at = ?, updated_at = ? WHERE novel_id = ?",
                    (stamp, stamp, novel_id))
                auto_completed = True
        if world_desc:
            we = conn.execute(
                """INSERT INTO world_event (novel_id, event_time, description, chapter_id, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (novel_id, world_time, world_desc, chapter_id, stamp),
            )
            world_event = {"world_event_id": int(we.lastrowid), "event_time": world_time,
                           "description": world_desc, "chapter_id": chapter_id}
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    handler._json({
        "ok": True,
        "chapter": _get_chapter(conn, chapter_id),
        "world_event": world_event,
        "auto_completed": auto_completed,
        "progress": _get_novel(conn, novel_id)["progress"],
        "writer": writer_out(user),
    }, 201)


def _create_character(handler, conn, novel_id: int) -> None:
    user = require_writer(handler)
    novel = _get_novel(conn, novel_id)
    assert_novel_writable(user, novel)
    payload = _read_json(handler)

    name = clean_text(payload.get("name"), "角色名称", MAX_CHARACTER_NAME)
    gender = clean_text(payload.get("gender"), "性别", MAX_CHARACTER_FIELD, required=False)
    identity = clean_text(payload.get("identity"), "身份", MAX_CHARACTER_FIELD, required=False)
    age = clean_text(payload.get("age"), "年龄", MAX_AGE, required=False)
    intro = clean_text(payload.get("intro"), "简介", MAX_INTRO, required=False)
    is_protagonist = 1 if parse_bool(payload.get("is_protagonist"), False) else 0

    dup = conn.execute("SELECT character_id FROM character WHERE novel_id = ? AND name = ?",
                       (novel_id, name)).fetchone()
    if dup:
        raise ApiError(f"同名角色已存在：{name}", 409, "character_exists",
                       {"character_id": int(dup["character_id"])})

    cur = conn.execute(
        """INSERT INTO character (novel_id, name, is_protagonist, gender, identity, age, intro, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (novel_id, name, is_protagonist, gender, identity, age, intro, now_str()),
    )
    conn.commit()
    handler._json({"ok": True, "character": _get_character(conn, int(cur.lastrowid))}, 201)


def _create_character_event(handler, conn, character_id: int) -> None:
    user = require_writer(handler)
    character = _get_character(conn, character_id)
    assert_novel_writable(user, _get_novel(conn, character["novel_id"]))
    payload = _read_json(handler)

    event_time = clean_text(payload.get("event_time"), "事件发生时间", MAX_EVENT_TIME)
    description = clean_text(payload.get("description"), "事件描述", MAX_EVENT_DESC)
    chapter_id = parse_int(payload.get("chapter_id"), "关联章节", 0, 0, 10 ** 9) or None
    if chapter_id is not None:
        _assert_chapter_in_novel(conn, chapter_id, character["novel_id"])

    cur = conn.execute(
        """INSERT INTO character_event (character_id, event_time, description, chapter_id, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (character_id, event_time, description, chapter_id, now_str()),
    )
    conn.commit()
    row = conn.execute(
        """SELECT e.*, c.title AS chapter_title FROM character_event e
             LEFT JOIN chapter c ON c.chapter_id = e.chapter_id WHERE e.event_id = ?""",
        (int(cur.lastrowid),)).fetchone()
    handler._json({"ok": True, "event": dict(row)}, 201)


def _create_world_event(handler, conn, novel_id: int) -> None:
    user = require_writer(handler)
    novel = _get_novel(conn, novel_id)
    assert_novel_writable(user, novel)
    payload = _read_json(handler)

    event_time = clean_text(payload.get("event_time"), "事件时间", MAX_EVENT_TIME)
    description = clean_text(payload.get("description"), "事件描述", MAX_EVENT_DESC)
    chapter_id = parse_int(payload.get("chapter_id"), "来源章节", 0, 0, 10 ** 9) or None
    if chapter_id is not None:
        _assert_chapter_in_novel(conn, chapter_id, novel_id)

    cur = conn.execute(
        """INSERT INTO world_event (novel_id, event_time, description, chapter_id, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (novel_id, event_time, description, chapter_id, now_str()),
    )
    conn.commit()
    row = conn.execute(
        """SELECT w.*, c.title AS chapter_title FROM world_event w
             LEFT JOIN chapter c ON c.chapter_id = w.chapter_id WHERE w.world_event_id = ?""",
        (int(cur.lastrowid),)).fetchone()
    handler._json({"ok": True, "world_event": dict(row)}, 201)


def _assert_chapter_in_novel(conn, chapter_id: int, novel_id: int) -> None:
    row = conn.execute("SELECT novel_id FROM chapter WHERE chapter_id = ?", (chapter_id,)).fetchone()
    if not row:
        raise ApiError(f"章节不存在：{chapter_id}", 404, "chapter_not_found")
    if int(row["novel_id"]) != int(novel_id):
        raise ApiError("章节不属于该书", 400, "chapter_mismatch")


def _create_relation(handler, conn, novel_id: int) -> None:
    user = require_writer(handler)
    novel = _get_novel(conn, novel_id)
    assert_novel_writable(user, novel)
    payload = _read_json(handler)

    a = parse_int(payload.get("character_a") or payload.get("a"), "角色 A", 0, 0, 10 ** 9)
    b = parse_int(payload.get("character_b") or payload.get("b"), "角色 B", 0, 0, 10 ** 9)
    relation_type = clean_text(payload.get("relation_type") or payload.get("type"), "关系类型", MAX_RELATION_TYPE)
    note = clean_text(payload.get("note"), "备注", MAX_RELATION_NOTE, required=False)

    if not a or not b:
        raise ApiError("需要同时给出 character_a 与 character_b", 400, "invalid_param")
    if a == b:
        raise ApiError("不允许自环关系：角色 A 与角色 B 不能是同一个角色", 400, "self_relation")

    for cid in (a, b):
        row = conn.execute("SELECT novel_id FROM character WHERE character_id = ?", (cid,)).fetchone()
        if not row:
            raise ApiError(f"角色不存在：{cid}", 404, "character_not_found")
        if int(row["novel_id"]) != int(novel_id):
            raise ApiError("关系双方必须属于同一本小说", 400, "novel_mismatch")

    dup = conn.execute(
        """SELECT relation_id FROM relation
            WHERE novel_id = ? AND relation_type = ?
              AND ((character_a = ? AND character_b = ?) OR (character_a = ? AND character_b = ?))""",
        (novel_id, relation_type, a, b, b, a),
    ).fetchone()
    if dup:
        raise ApiError("这条关系已存在（同类型、同两端）", 409, "relation_exists",
                       {"relation_id": int(dup["relation_id"])})

    try:
        cur = conn.execute(
            """INSERT INTO relation (novel_id, character_a, character_b, relation_type, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (novel_id, a, b, relation_type, note, now_str()),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        raise ApiError("这条关系已存在（唯一约束冲突）", 409, "relation_exists")

    row = conn.execute(
        """SELECT r.*, ca.name AS a_name, cb.name AS b_name FROM relation r
             JOIN character ca ON ca.character_id = r.character_a
             JOIN character cb ON cb.character_id = r.character_b
            WHERE r.relation_id = ?""",
        (int(cur.lastrowid),),
    ).fetchone()
    handler._json({"ok": True, "relation": dict(row)}, 201)


# --------------------------------------------------------------------------- #
# PUT / PATCH
# --------------------------------------------------------------------------- #

def _dispatch_put(handler, p: str, conn) -> None:
    m = re.match(r"^/novels/(\d+)$", p)
    if m:
        return _update_novel(handler, conn, int(m.group(1)))

    m = re.match(r"^/chapters/(\d+)$", p)
    if m:
        return _update_chapter(handler, conn, int(m.group(1)))

    m = re.match(r"^/characters/(\d+)$", p)
    if m:
        return _update_character(handler, conn, int(m.group(1)))

    raise ApiError(f"未知接口：{p}", 404, "not_found")


def _update_novel(handler, conn, novel_id: int) -> None:
    user = require_writer(handler)
    novel = _get_novel(conn, novel_id)
    assert_novel_writable(user, novel)
    payload = _read_json(handler)

    fields, args = [], []
    mapping = {
        "name": ("小说名称", MAX_NOVEL_NAME, True),
        "worldview": ("世界观设定", MAX_WORLDVIEW, False),
        "background": ("背景描述", MAX_BACKGROUND, False),
        "cover": ("封面", MAX_COVER, False),
    }
    for key, (label, limit, required) in mapping.items():
        if key in payload:
            fields.append(f"{key} = ?")
            args.append(clean_text(payload.get(key), label, limit, required=required))
    if "completion_goal" in payload or "goal" in payload:
        fields.append("completion_goal = ?")
        args.append(clean_completion_goal(payload.get("completion_goal", payload.get("goal"))))
    if "target_chapters" in payload or "target_chapter_count" in payload:
        fields.append("target_chapters = ?")
        args.append(clean_target_chapters(payload.get("target_chapters", payload.get("target_chapter_count"))))
    if "target_words" in payload or "target_word_count" in payload:
        fields.append("target_words = ?")
        args.append(parse_int(payload.get("target_words", payload.get("target_word_count")),
                              "目标字数 target_words", 0, 0, MAX_TARGET_WORDS))
    if "stages" in payload or "stage_plan" in payload:
        fields.append("stages = ?")
        args.append(clean_stages(payload.get("stages", payload.get("stage_plan"))))
    if not fields:
        raise ApiError("没有可更新的字段（name / worldview / background / cover / completion_goal / "
                       "target_chapters / target_words / stages）", 400, "invalid_param")
    fields.append("updated_at = ?")
    args.append(now_str())
    args.append(novel_id)
    conn.execute(f"UPDATE novel SET {', '.join(fields)} WHERE novel_id = ?", args)
    conn.commit()
    handler._json({"ok": True, "novel": _get_novel(conn, novel_id)})


def _complete_novel(handler, conn, novel_id: int) -> None:
    """标记完结：AI 写完终章后主动调用；已完结重复调用幂等，不报错。"""
    user = require_writer(handler)
    novel = _get_novel(conn, novel_id)
    assert_novel_writable(user, novel)
    if (novel.get("status") or "serializing") == "completed":
        return handler._json({"ok": True, "already": True, "novel": novel})
    stamp = now_str()
    conn.execute("UPDATE novel SET status = 'completed', finished_at = ?, updated_at = ? WHERE novel_id = ?",
                 (stamp, stamp, novel_id))
    conn.commit()
    handler._json({"ok": True, "already": False, "novel": _get_novel(conn, novel_id)})


def _update_chapter(handler, conn, chapter_id: int) -> None:
    """改章节同样受摘要硬约束：只要带上摘要字段就走同一套校验。"""
    user = require_writer(handler)
    chapter = _get_chapter(conn, chapter_id)
    novel = _get_novel(conn, chapter["novel_id"])
    assert_novel_writable(user, novel)
    payload = _read_json(handler)

    fields, args = [], []
    if "title" in payload:
        fields.append("title = ?")
        args.append(clean_text(payload.get("title"), "章节标题", MAX_CHAPTER_TITLE))
    if "content" in payload:
        fields.append("content = ?")
        args.append(clean_text(payload.get("content"), "章节正文", MAX_CONTENT, required=False))
    if "seq" in payload:
        fields.append("seq = ?")
        args.append(parse_int(payload.get("seq"), "章节序号", 0, 0, 100000))
    if "one_line_summary" in payload:
        fields.append("one_line_summary = ?")
        args.append(clean_one_line_summary(payload.get("one_line_summary")))
    if "summary" in payload:
        fields.append("summary = ?")
        args.append(clean_summary(payload.get("summary")))
    if not fields:
        raise ApiError("没有可更新的字段（title / content / seq / one_line_summary / summary）",
                       400, "invalid_param")
    args.append(chapter_id)
    conn.execute(f"UPDATE chapter SET {', '.join(fields)} WHERE chapter_id = ?", args)
    conn.execute("UPDATE novel SET updated_at = ? WHERE novel_id = ?", (now_str(), chapter["novel_id"]))
    conn.commit()
    handler._json({"ok": True, "chapter": _get_chapter(conn, chapter_id)})


def _update_character(handler, conn, character_id: int) -> None:
    user = require_writer(handler)
    character = _get_character(conn, character_id)
    assert_novel_writable(user, _get_novel(conn, character["novel_id"]))
    payload = _read_json(handler)

    fields, args = [], []
    if "name" in payload:
        name = clean_text(payload.get("name"), "角色名称", MAX_CHARACTER_NAME)
        dup = conn.execute(
            "SELECT character_id FROM character WHERE novel_id = ? AND name = ? AND character_id <> ?",
            (character["novel_id"], name, character_id)).fetchone()
        if dup:
            raise ApiError(f"同名角色已存在：{name}", 409, "character_exists",
                           {"character_id": int(dup["character_id"])})
        fields.append("name = ?")
        args.append(name)
    for key, label, limit in (("gender", "性别", MAX_CHARACTER_FIELD),
                              ("identity", "身份", MAX_CHARACTER_FIELD),
                              ("age", "年龄", MAX_AGE),
                              ("intro", "简介", MAX_INTRO)):
        if key in payload:
            fields.append(f"{key} = ?")
            args.append(clean_text(payload.get(key), label, limit, required=False))
    if "is_protagonist" in payload:
        fields.append("is_protagonist = ?")
        args.append(1 if parse_bool(payload.get("is_protagonist"), False) else 0)
    if not fields:
        raise ApiError("没有可更新的字段", 400, "invalid_param")
    args.append(character_id)
    conn.execute(f"UPDATE character SET {', '.join(fields)} WHERE character_id = ?", args)
    conn.commit()
    handler._json({"ok": True, "character": _get_character(conn, character_id)})


# --------------------------------------------------------------------------- #
# DELETE
# --------------------------------------------------------------------------- #

def _dispatch_delete(handler, p: str, conn) -> None:
    m = re.match(r"^/novels/(\d+)$", p)
    if m:
        user = require_writer(handler)
        novel_id = int(m.group(1))
        assert_novel_writable(user, _get_novel(conn, novel_id))
        conn.execute("DELETE FROM novel WHERE novel_id = ?", (novel_id,))
        conn.commit()
        return handler._json({"ok": True, "deleted": {"novel_id": novel_id}})

    m = re.match(r"^/chapters/(\d+)$", p)
    if m:
        user = require_writer(handler)
        chapter_id = int(m.group(1))
        chapter = _get_chapter(conn, chapter_id)
        assert_novel_writable(user, _get_novel(conn, chapter["novel_id"]))
        conn.execute("DELETE FROM chapter WHERE chapter_id = ?", (chapter_id,))
        conn.commit()
        return handler._json({"ok": True, "deleted": {"chapter_id": chapter_id}})

    m = re.match(r"^/characters/(\d+)$", p)
    if m:
        user = require_writer(handler)
        character_id = int(m.group(1))
        character = _get_character(conn, character_id)
        assert_novel_writable(user, _get_novel(conn, character["novel_id"]))
        conn.execute("DELETE FROM character WHERE character_id = ?", (character_id,))
        conn.commit()
        return handler._json({"ok": True, "deleted": {"character_id": character_id}})

    m = re.match(r"^/relations/(\d+)$", p)
    if m:
        user = require_writer(handler)
        relation_id = int(m.group(1))
        row = conn.execute("SELECT novel_id FROM relation WHERE relation_id = ?", (relation_id,)).fetchone()
        if not row:
            raise ApiError(f"关系不存在：{relation_id}", 404, "relation_not_found")
        assert_novel_writable(user, _get_novel(conn, int(row["novel_id"])))
        conn.execute("DELETE FROM relation WHERE relation_id = ?", (relation_id,))
        conn.commit()
        return handler._json({"ok": True, "deleted": {"relation_id": relation_id}})

    m = re.match(r"^/events/(\d+)$", p)
    if m:
        user = require_writer(handler)
        event_id = int(m.group(1))
        row = conn.execute("SELECT character_id FROM character_event WHERE event_id = ?", (event_id,)).fetchone()
        if not row:
            raise ApiError(f"角色事迹不存在：{event_id}", 404, "event_not_found")
        character = _get_character(conn, int(row["character_id"]))
        assert_novel_writable(user, _get_novel(conn, character["novel_id"]))
        conn.execute("DELETE FROM character_event WHERE event_id = ?", (event_id,))
        conn.commit()
        return handler._json({"ok": True, "deleted": {"event_id": event_id}})

    m = re.match(r"^/world-events/(\d+)$", p)
    if m:
        user = require_writer(handler)
        world_event_id = int(m.group(1))
        row = conn.execute("SELECT novel_id FROM world_event WHERE world_event_id = ?",
                           (world_event_id,)).fetchone()
        if not row:
            raise ApiError(f"世界事件不存在：{world_event_id}", 404, "world_event_not_found")
        assert_novel_writable(user, _get_novel(conn, int(row["novel_id"])))
        conn.execute("DELETE FROM world_event WHERE world_event_id = ?", (world_event_id,))
        conn.commit()
        return handler._json({"ok": True, "deleted": {"world_event_id": world_event_id}})

    raise ApiError(f"未知接口：{p}", 404, "not_found")


# --------------------------------------------------------------------------- #
# 命令行：单独建库 / 自检
# --------------------------------------------------------------------------- #

def _cli() -> None:
    ap = argparse.ArgumentParser(description="小说板块数据库初始化 / 自检")
    ap.add_argument("--init", action="store_true", help="幂等建表并打印概览")
    ap.add_argument("--stats", action="store_true", help="打印当前库统计（与 --init 同效）")
    ap.parse_args()
    info = init_db()
    print(f"[OK] 小说库：{info['db']}", flush=True)
    print(f"[OK] 小说 {info['novels']} 本 / 章节 {info['chapters']} 章 / "
          f"角色 {info['characters']} 个 / 关系 {info['relations']} 条", flush=True)
    if info["added_columns"]:
        print(f"[OK] 补列：{', '.join(info['added_columns'])}", flush=True)


if __name__ == "__main__":
    _cli()
