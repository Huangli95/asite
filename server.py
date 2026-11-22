#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地AI项目广场 —— 多板块站点服务

- 纯 Python 标准库实现（http.server + sqlite3），无第三方依赖
- 数据源（外部定时任务写入，本站点**只读**，绝不写库、不建表、不加索引）：
  1. <Marvis User>/data/marvis-db/news.db     -> news_articles 表（热点新闻）
- 板块：热点新闻 + 数据概览（新闻库统计）+ 社区论坛；指数行情 / Steam 板块已下线
- 论坛与后台必须登录才能访问，账号由管理员创建，不开放注册（见 auth.py）
- 生产部署：只监听 127.0.0.1，由 Nginx 终止 TLS 并反向代理；MARVIS_TRUST_PROXY=1 时信任 XFF

启动：python server.py [--port 50001] [--host 127.0.0.1]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import traceback
from datetime import date, datetime, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote, quote

import auth  # 账号与会话（独立 auth.db）
import forum  # 论坛模块（独立 forum.db，自带读写接口）
import novel  # 小说模块（独立 novel.db，自带读写接口；复用 auth 账号体系）
import audio  # 音频素材模块（后台线程池调用 assets 脚本合成，产物按 TTL 过期清理）

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


# --------------------------------------------------------------------------- #
# 数据源（只读）
# --------------------------------------------------------------------------- #

def resolve_db_path() -> Path:
    """数据库路径：环境变量 MARVIS_SITE_DB > <Marvis User>/data/marvis-db/news.db > 项目内 data/news.db"""
    env = os.environ.get("MARVIS_SITE_DB")
    if env and env.strip():
        return Path(env).expanduser()
    try:
        user_root = BASE_DIR.parents[3]          # <openid>
        if user_root.name and len(user_root.name) >= 8 and (user_root / "workspace").exists():
            return user_root / "data" / "marvis-db" / "news.db"
    except IndexError:
        pass
    return BASE_DIR / "data" / "news.db"


DB_PATH = resolve_db_path()
TABLE = "news_articles"


class ReadOnlyDBError(RuntimeError):
    pass


def connect() -> sqlite3.Connection:
    """以只读方式打开外部数据库，保证站点不会改到定时任务的数据。"""
    if not DB_PATH.exists():
        raise ReadOnlyDBError(f"数据库文件不存在：{DB_PATH}")
    uri = DB_PATH.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
    except sqlite3.DatabaseError:
        pass
    return conn


def inspect_db() -> dict:
    """读取库结构信息，供 /api/health 自检。"""
    conn = connect()
    try:
        cols = [r["name"] for r in conn.execute(f'PRAGMA table_info("{TABLE}")')]
        if not cols:
            raise ReadOnlyDBError(f"数据表 {TABLE} 不存在")
        total = conn.execute(f'SELECT COUNT(*) FROM "{TABLE}"').fetchone()[0]
        latest = conn.execute(f'SELECT MAX(news_date) FROM "{TABLE}"').fetchone()[0]
        return {"columns": cols, "total": total, "latest_date": latest or "-"}
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# 板块注册表：新增板块在此登记，前端导航自动生成
# --------------------------------------------------------------------------- #

BOARDS = [
    {
        "key": "news",
        "name": "热点新闻",
        "desc": "按日期浏览定时任务抓取入库的热点新闻，支持关键词检索与分页",
        "status": "online",
    },
    {
        "key": "overview",
        "name": "数据概览",
        "desc": "新闻库的存量统计与近期入库分布",
        "status": "online",
    },
    {
        "key": "novel",
        "name": "小说板块",
        "desc": "章节管理（强制摘要）、角色与世界大事件、翻书详情与关系网拓扑图",
        "status": "online",
    },
    {
        "key": "games",
        "name": "小游戏",
        "desc": "纯前端小游戏大厅，手机触屏与桌面键鼠双适配，打开即玩",
        "status": "online",
    },
    {
        "key": "audio",
        "name": "音频素材",
        "desc": "选好时长与心情，后台异步合成一段随机音乐素材；在线试听、随时下载，过期自动清理",
        "status": "online",
    },
]


# --------------------------------------------------------------------------- #
# 小游戏注册表：新增小游戏在此登记一条，并把页面放到 static/game-<key>.html
# --------------------------------------------------------------------------- #

GAMES = [
    {
        "key": "bounce",
        "name": "弹球打砖",
        "tag": "弹球",
        "desc": "瞄准发射小球，靠边界与方块反弹敲掉下落的小方块；方块为正方形、一行可排 8-12 列，一屏可容 12 层；方块血量随波次与轮数递增（最高 20 击）；碰到 +1 方块永久加球，方块触底扣生命，生命耗尽即结束；下落可选持续下落或按轮次逐行下降，逐行下降可开「补行」——每降一行顶部随机补出一行（每行随机空 2-3 格），不必打通整阵",
        "url": "/games/bounce",
        "accent": "#63e6ff",
        "status": "online",
    },
    {
        "key": "rogue",
        "name": "肉鸽卡牌",
        "tag": "卡牌",
        "desc": "卡组组好后自动按费用出牌的观战式肉鸽：每回合自动抽牌、按优先级与场面自动出牌，你只看连播战报；击败一波三选一加卡，输了本局即清零重开。纯局内构筑、无存档，单局约 5-10 分钟；支持暂停与倍速，页面内可直接改全部核心参数（含敌人成长、初始卡组、动画节奏）并可导出 JSON",
        "url": "/games/rogue",
        "accent": "#c07cff",
        "status": "online",
    },
    {
        "key": "mathrun",
        "name": "算术闯关",
        "tag": "闯关",
        "desc": "小人站在底线可左右移动，运算门从上方落下并被中线分成两半：站到门的哪半边，人数就按那半边的算式变化——「+12」「7+5」是常量增减，「×2」「÷3」按当前人数乘除，「×2+5」先乘再加。撑过本关全部门数即闯关成功进入下一关，门更多、下落更快、算式更复杂（最高五档，出现乘法、除法与混合运算）；人数归零本局结束。支持键盘 ←/→ 与 A/D、按钮长按、画布拖动，设置面板可实时改人数、节奏、运算档位与计分",
        "url": "/games/mathrun",
        "accent": "#22c48a",
        "status": "online",
    },
]


# --------------------------------------------------------------------------- #
# 数据访问（全部只读查询）
# --------------------------------------------------------------------------- #

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

BASE_COLUMNS = "id, title, url, source, category, summary, news_date, created_at"


def list_news(date_str: str | None, keyword: str | None, page: int, page_size: int) -> dict:
    where, params = [], []
    if date_str:
        if not DATE_RE.match(date_str):
            raise ValueError("date 参数格式应为 YYYY-MM-DD")
        where.append("news_date = ?")
        params.append(date_str)
    if keyword:
        kw = f"%{keyword.strip()}%"
        where.append("(title LIKE ? OR summary LIKE ? OR source LIKE ? OR category LIKE ?)")
        params.extend([kw, kw, kw, kw])
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    conn = connect()
    try:
        total = conn.execute(
            f'SELECT COUNT(*) FROM "{TABLE}"{where_sql}', params
        ).fetchone()[0]
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(max(page, 1), pages)
        offset = (page - 1) * page_size
        rows = conn.execute(
            f"""SELECT {BASE_COLUMNS} FROM "{TABLE}"{where_sql}
                ORDER BY news_date DESC, id DESC
                LIMIT ? OFFSET ?""",
            params + [page_size, offset],
        ).fetchall()
        items = [dict(r) for r in rows]

        date_rows = conn.execute(
            f"""SELECT news_date AS d, COUNT(*) AS c FROM "{TABLE}"
                WHERE news_date IS NOT NULL AND news_date <> ''
                GROUP BY news_date ORDER BY news_date DESC LIMIT 366"""
        ).fetchall()
        dates = [{"date": r["d"], "count": r["c"]} for r in date_rows]

        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": pages,
            "filter": {"date": date_str or "", "q": keyword or ""},
            "dates": dates,
        }
    finally:
        conn.close()


def overview() -> dict:
    conn = connect()
    try:
        total = conn.execute(f'SELECT COUNT(*) FROM "{TABLE}"').fetchone()[0]
        date_cnt = conn.execute(
            f"SELECT COUNT(DISTINCT news_date) FROM \"{TABLE}\" WHERE news_date IS NOT NULL AND news_date <> ''"
        ).fetchone()[0]
        src_cnt = conn.execute(
            f"""SELECT COUNT(DISTINCT source) FROM "{TABLE}"
                WHERE source IS NOT NULL AND source <> ''"""
        ).fetchone()[0]
        latest = conn.execute(f'SELECT MAX(news_date) FROM "{TABLE}"').fetchone()[0]
        today = date.today().isoformat()
        today_cnt = conn.execute(
            f'SELECT COUNT(*) FROM "{TABLE}" WHERE news_date = ?', (today,)
        ).fetchone()[0]

        start = (date.today() - timedelta(days=6)).isoformat()
        rows = conn.execute(
            f'SELECT news_date AS d, COUNT(*) AS c FROM "{TABLE}" WHERE news_date >= ? GROUP BY news_date',
            (start,),
        ).fetchall()
        by_day = {r["d"]: r["c"] for r in rows}
        trend = []
        for i in range(6, -1, -1):
            d = (date.today() - timedelta(days=i)).isoformat()
            trend.append({"date": d, "count": by_day.get(d, 0)})

        cat_rows = conn.execute(
            f"""SELECT COALESCE(NULLIF(category,''),'未分类') AS c, COUNT(*) AS n
                FROM "{TABLE}" GROUP BY c ORDER BY n DESC LIMIT 10"""
        ).fetchall()

        return {
            "total": total,
            "date_count": date_cnt,
            "source_count": src_cnt,
            "today_count": today_cnt,
            "latest_date": latest or "-",
            "trend": trend,
            "categories": [{"category": r["c"], "count": r["n"]} for r in cat_rows],
            "db_path": DB_PATH.name,
        }
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "MarvisBoard/1.1"

    # ---------- 输出工具 ---------- #

    def _send(self, code: int, body: bytes, ctype: str, extra_headers: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        # HEAD 请求必须回真实的 Content-Length，但绝不能写 body。
        self.send_header("Content-Length", str(len(body)))
        # 默认 no-store：接口与页面都是动态的。论坛上传的图片是随机文件名、内容不变，
        # 由 forum.send_media 通过 extra_headers 覆盖成长缓存。
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if getattr(self, "_head_only", False):
            return
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, payload: dict, code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _error(self, msg: str, code: int = 400) -> None:
        self._json({"ok": False, "error": str(msg)}, code)

    # ---------- 路由 ---------- #

    def do_HEAD(self) -> None:  # noqa: N802
        """HEAD 与 GET 同路由、同响应头，只是不写 body。

        以前没有实现，任何 HEAD（/forum、/static/*.jpg）都落到 BaseHTTPRequestHandler
        的 501 兜底，探测类请求全部报错（#5）。
        """
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def send_error(self, code, message=None, explain=None) -> None:  # noqa: D401
        """框架级错误（非法请求行、未实现方法等）也统一回 JSON 体。

        默认实现回 HTML 错误页，与本站「接口一律 JSON」的口径冲突，
        调用方按 application/json 解析会拿到 0 字节（#212）。
        """
        try:
            body = json.dumps(
                {
                    "ok": False,
                    "code": "http_%d" % int(code),
                    "error": message or self.responses.get(int(code), ("",))[0],
                },
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(int(code))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if getattr(self, "_head_only", False):
                body = b""
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _gate(self, path: str) -> bool:
        """登录门禁：论坛写操作与后台必须登录；论坛读操作对游客开放。返回 True 表示已拦截并写完响应。

        放行三类请求：
        1) 论坛只读访问（GET/HEAD 的页面与读接口），游客免登录可看；
        2) 携带 Authorization 令牌的机器调用（令牌类型、权限由 forum 模块统一解析校验）；
        3) 已持有有效会话 Cookie 的浏览器。

        统一令牌协议后网关只判断「有没有 Authorization」，不再认 X-API-Key /
        X-Admin-Token / X-User-Token 等指向性 header，也不再按 ut_ 前缀特判：
        令牌真伪与 ak- / ak-ai- / adm_ 的分流全部下沉到 forum.resolve_principal。
        """
        if not self._protected(path):
            return False
        if self.command in ("GET", "HEAD") and self._guest_readable(path):
            return False
        # 有令牌就放行到 forum 层：鉴权失败由 forum 回 401 invalid_token / 403 insufficient_scope
        if (self.headers.get("Authorization") or "").strip():
            return False
        user = auth.current_user(self)
        if user:
            if path.startswith("/forum/accounts") and user["role"] != auth.ROLE_ADMIN:
                self._json({"ok": False, "error": "需要管理员权限", "code": "forbidden"}, 403)
                return True
            return False
        if path.startswith("/api/"):
            self._json({"ok": False, "error": "请先登录", "code": "login_required"}, 401)
            return True
        return self._redirect("/login?next=" + quote(path, safe=""))

    @staticmethod
    def _protected(path: str) -> bool:
        return path.startswith("/forum") or path.startswith("/api/forum") or path.startswith("/api/admin")

    @staticmethod
    def _guest_readable(path: str) -> bool:
        """游客只读白名单：论坛页面与读接口。

        写接口（POST/PUT/DELETE）根本不会走到这里，仍由 _gate 拦成 401；
        管理接口 /api/forum/admin/** 与账号管理页 /forum/accounts 也不放行。
        """
        if path.startswith("/api/forum"):
            return not path.startswith("/api/forum/admin")
        if path.startswith("/forum"):
            # 自助页面必须知道自己是谁，游客一律先登录再回来
            if path.startswith(("/forum/accounts", "/forum/my-ai", "/forum/my-tokens")):
                return False
            return True
        return False

    def _redirect(self, location: str, code: int = 302) -> bool:
        self.send_response(code)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _cookie_secure(self) -> bool:
        return os.environ.get("MARVIS_COOKIE_SECURE", "1") not in ("0", "false", "no")

    def _read_body(self, limit: int = 200_000) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > limit:
            raise ValueError(f"请求体过大（上限 {limit} 字节）")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return payload

    def _auth_error(self, e) -> None:
        self._json({"ok": False, "error": e.message, "code": e.code}, e.status)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        if self._gate(path):
            return
        if path in ("/login", "/login.html"):
            return self._static("login.html")
        if path == "/api/auth/me":
            user = auth.current_user(self)
            return self._json({"ok": True, "user": user, "logged_in": bool(user),
                               "is_admin": bool(user and user["role"] == auth.ROLE_ADMIN)})
        if path == "/api/admin/users":
            try:
                auth.require_admin_user(self)
            except auth.AuthError as e:
                return self._auth_error(e)
            users = auth.list_users()
            return self._json({"ok": True, "items": users, "total": len(users)})
        if forum.handle(self, "GET", path, qs):
            return
        if novel.handle(self, "GET", path, qs):
            return
        # 小游戏板块：大厅页 + /games/<key> 按注册表映射到 static/game-<key>.html
        if path == "/api/games":
            return self._json({"ok": True, "games": [g for g in GAMES if g.get("status") == "online"]})
        if path == "/games":
            return self._static("games.html")
        if path.startswith("/games/"):
            key = path[len("/games/"):].strip("/")
            if any(one["key"] == key for one in GAMES):
                return self._static("game-%s.html" % key)
            return self._error("小游戏不存在：" + key, 404)
        # 音频素材板块：页面 + /api/audio/**（任务状态、试听下载由 audio 模块处理）
        if path == "/audio":
            return self._static("audio.html")
        if audio.handle(self, "GET", path, qs):
            return
        try:
            if path in ("/", "/index.html"):
                return self._static("index.html")
            if path.startswith("/static/"):
                return self._static(unquote(path[len("/static/"):]))
            if path == "/api/boards":
                return self._json({"ok": True, "boards": BOARDS, "db_path": DB_PATH.name})
            if path == "/api/news":
                page = self._int(qs, "page", 1)
                size = min(max(self._int(qs, "page_size", 10), 1), 100)
                data = list_news(
                    (qs.get("date", [""])[0] or "").strip() or None,
                    (qs.get("q", [""])[0] or "").strip() or None,
                    page,
                    size,
                )
                return self._json({"ok": True, **data})
            if path == "/api/overview":
                return self._json({"ok": True, **overview()})
            if path == "/api/health":
                info = inspect_db()
                return self._json({
                    "ok": True,
                    "readonly": True,
                    "db": DB_PATH.name,
                    "time": datetime.now().isoformat(timespec="seconds"),
                    **info,
                })
            return self._error("未知接口或页面：" + path, 404)
        except ValueError as e:
            return self._error(e, 400)
        except ReadOnlyDBError as e:
            return self._error(f"数据源不可用：{e}", 503)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._error(f"{type(e).__name__}: {e}", 500)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        if self._gate(path):
            return
        # ---- 账号与会话 ----
        if path == "/api/auth/login":
            try:
                payload = self._read_body()
                token, user = auth.login(
                    str(payload.get("username") or ""),
                    str(payload.get("password") or ""),
                    auth.client_ip(self),
                    self.headers.get("User-Agent", ""),
                )
            except auth.AuthError as e:
                return self._auth_error(e)
            except ValueError as e:
                return self._error(e, 400)
            body = json.dumps({"ok": True, "user": user}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Set-Cookie",
                             auth.build_cookie_secure(token, secure=self._cookie_secure()))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if path == "/api/auth/logout":
            auth.logout(auth.session_token(self))
            self._json({"ok": True, "logged_out": True})
            return
        if path == "/api/auth/password":
            try:
                me = auth.require_user(self)
                payload = self._read_body()
                old = str(payload.get("old_password") or "")
                new = str(payload.get("new_password") or "")
                conn = auth.connect()
                try:
                    row = conn.execute("SELECT pass_hash FROM site_user WHERE id = ?", (me["id"],)).fetchone()
                finally:
                    conn.close()
                if not row or not auth.verify_password(old, row["pass_hash"]):
                    raise auth.AuthError("原密码不正确", 400, "bad_credentials")
                auth.reset_password(me["id"], new)
            except auth.AuthError as e:
                return self._auth_error(e)
            except ValueError as e:
                return self._error(e, 400)
            return self._json({"ok": True, "changed": True, "relogin": True})
        if path == "/api/admin/users":
            try:
                me = auth.require_admin_user(self)
                payload = self._read_body()
                user = auth.create_user(
                    payload.get("username"),
                    str(payload.get("password") or ""),
                    role=str(payload.get("role") or auth.ROLE_USER),
                    display_name=str(payload.get("display_name") or ""),
                    created_by=me["username"],
                )
            except auth.AuthError as e:
                return self._auth_error(e)
            except ValueError as e:
                return self._error(e, 400)
            return self._json({"ok": True, "user": user}, 201)
        m = re.match(r"^/api/admin/users/(\d+)/(password|status)$", path)
        if m:
            try:
                auth.require_admin_user(self)
                payload = self._read_body()
                uid = int(m.group(1))
                if m.group(2) == "password":
                    user = auth.reset_password(uid, str(payload.get("password") or ""))
                else:
                    user = auth.set_status(uid, str(payload.get("status") or ""))
            except auth.AuthError as e:
                return self._auth_error(e)
            except ValueError as e:
                return self._error(e, 400)
            return self._json({"ok": True, "user": user})
        # 论坛写接口（/api/forum/**）由 forum 模块处理
        if forum.handle(self, "POST", path, qs):
            return
        # 小说写接口（/api/novel/**）由 novel 模块处理，鉴权在模块内部复用站点账号体系
        if novel.handle(self, "POST", path, qs):
            return
        # 音频素材写接口（/api/audio/jobs 提交生成任务）由 audio 模块处理
        if audio.handle(self, "POST", path, qs):
            return
        # 看板部分仍为只读展示层，数据由外部定时任务维护
        return self._error("看板为只读：新闻数据由定时任务写入 news.db；发帖请到 /forum", 403)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        if self._gate(path):
            return
        m = re.match(r"^/api/admin/users/(\d+)$", path)
        if m:
            try:
                auth.require_admin_user(self)
                result = auth.delete_user(int(m.group(1)))
            except auth.AuthError as e:
                return self._auth_error(e)
            return self._json({"ok": True, **result})
        if forum.handle(self, "DELETE", path, qs):
            return
        if novel.handle(self, "DELETE", path, qs):
            return
        return self._error("未知接口：" + path, 404)

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        if self._gate(path):
            return
        if forum.handle(self, "PUT", path, qs):
            return
        if novel.handle(self, "PUT", path, qs):
            return
        return self._error("未知接口：" + path, 404)

    def do_OPTIONS(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if forum.handle(self, "OPTIONS", path, {}):
            return
        if novel.handle(self, "OPTIONS", path, {}):
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- 辅助 ---------- #

    @staticmethod
    def _int(qs: dict, key: str, default: int) -> int:
        try:
            return int(qs.get(key, [str(default)])[0])
        except (TypeError, ValueError):
            return default

    def _static(self, rel: str) -> None:
        target = (STATIC_DIR / rel).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self._error("非法路径", 403)
        if not target.is_file():
            return self._error("文件不存在：" + rel, 404)
        ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))


def main() -> None:
    ap = argparse.ArgumentParser(description="本地AI项目广场 + 论坛服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=50001)
    args = ap.parse_args()

    try:
        info = inspect_db()
        print(f"[OK] 数据源就绪：{DB_PATH}", flush=True)
        print(f"[OK] {TABLE} 列：{', '.join(info['columns'])}；共 {info['total']} 条，最新 {info['latest_date']}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] 数据源自检未通过：{e}", flush=True)
        print("[WARN] 站点仍会启动，页面将显示错误提示", flush=True)

    try:
        finfo = forum.init_db()
        print(f"[OK] 论坛库就绪：{finfo['db']}；{finfo['boards']} 个板块 / {finfo['posts']} 帖 / {finfo['comments']} 评论", flush=True)
        print(f"[OK] 论坛入口：http://{args.host}:{args.port}/forum   登录页：http://{args.host}:{args.port}/login", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] 论坛库初始化失败：{e}", flush=True)

    try:
        nvinfo = novel.init_db()
        print(f"[OK] 小说库就绪：{nvinfo['db']}；{nvinfo['novels']} 本书 / {nvinfo['chapters']} 章 / "
              f"{nvinfo['characters']} 角色 / {nvinfo['relations']} 条关系", flush=True)
        print(f"[OK] 小说入口：http://{args.host}:{args.port}/novel", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] 小说库初始化失败：{e}", flush=True)

    try:
        ainfo = auth.init_db()
        print(f"[OK] 账号库就绪：{ainfo['db']}；{ainfo['users']} 个账号 / {ainfo['admins']} 个管理员", flush=True)
        if ainfo["admins"] == 0:
            print("[WARN] 还没有管理员账号，请执行：python auth.py --create-admin <用户名>", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] 账号库初始化失败：{e}", flush=True)

    # 账号库就绪后再补一次 admin 静态令牌登记：forum.init_db 可能早于 auth 建库，
    # 那时库里还没有管理员。登记是幂等的，已登记则直接跳过；明文绝不打印。
    try:
        reg = forum.register_admin_static_token()
        if reg["registered"]:
            print(f"[OK] 已把 forum_admin.key 登记为管理员 user_id={reg['user_id']} 的令牌"
                  f"（token_id={reg['token_id']}，name={forum.ADMIN_TOKEN_NAME}）", flush=True)
        elif reg["reason"] == "exists_active":
            print(f"[OK] forum_admin.key 已登记在 site_user_token（{reg['reason']}），跳过", flush=True)
        elif reg["reason"] == "exists_revoked":
            print("[WARN] forum_admin.key 对应的令牌已被吊销，保持吊销不复活；如需恢复请执行"
                  " tools/register_admin_key.py --apply --reactivate", flush=True)
        elif reg["reason"] == "no_admin_user":
            print("[WARN] 还没有管理员账号，forum_admin.key 暂未登记；建号后重启即可自动登记"
                  "（或执行 tools/register_admin_key.py --apply）", flush=True)
        elif reg["reason"] == "no_token_file":
            pass
        else:
            print(f"[WARN] forum_admin.key 登记未完成：{reg['reason']}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] forum_admin.key 登记异常：{e}", flush=True)

    try:
        auinfo = audio.init()
        print(f"[OK] 音频素材就绪：产物目录 {auinfo['root']}；并发 {auinfo['concurrency']} / "
              f"有效期 {auinfo['ttl_hours']:g} 小时 / 最多保留 {auinfo['max_files']} 个", flush=True)
        if not auinfo["script_ok"]:
            print(f"[WARN] 找不到生成脚本：{auinfo['script']}（音频素材会提交失败）", flush=True)
        print(f"[OK] 音频素材入口：http://{args.host}:{args.port}/audio", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] 音频素材初始化失败：{e}", flush=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"[OK] 本地AI项目广场已启动 http://{args.host}:{args.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[STOP] 已停止", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

