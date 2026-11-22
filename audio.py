#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音频素材板块 —— 异步生成 + 过期清理 + 数量上限（纯 Python 标准库）

设计要点
--------
1. 任务队列：POST 提交只做参数校验与入队，立刻返回 job_id，真正的合成在后台线程池里跑，
   前端按 job_id 轮询状态，不会把 HTTP 请求挂住。
2. 并发上限：默认同时生成 5 个（MARVIS_AUDIO_CONCURRENCY 可改，1~16）。
   线程池容量固定为上限的天花板，真正限制并发的是 _Gate 信号量，
   这样以后想调并发不用重建线程池。
3. 过期清理：每个任务生成完成后写入 expires_at（默认 now + 24 小时，
   MARVIS_AUDIO_TTL_HOURS 可改），janitor 线程每 30 秒扫一次，到期即删目录。
4. 数量上限：本地同时最多保留 100 个音频（MARVIS_AUDIO_MAX_FILES 可改），
   超出时按创建时间最旧优先删除。
5. 目录隔离：一个任务一个目录 temp/audio/jobs/<job_id>/，输出文件名就是 job_id，
   同名覆盖在这套结构下不可能发生。
6. 生成脚本：默认用 <项目同级>/assets/gen_random_melody.py（MARVIS_AUDIO_SCRIPT 可改）。
   该脚本靠「同目录的 gen_scale_wav.py」提供合成引擎，因此必须以子进程方式、
   在脚本自身目录下调用，不能拷出来单独跑。

配置项（环境变量，改完重启服务生效）
----------------------------------
MARVIS_AUDIO_CONCURRENCY  同时生成上限，默认 5
MARVIS_AUDIO_TTL_HOURS    音频有效期（小时），默认 24
MARVIS_AUDIO_MAX_FILES    本地最多保留音频数，默认 100
MARVIS_AUDIO_MAX_QUEUE    排队任务上限，默认 20
MARVIS_AUDIO_MAX_SECONDS  单条音频最长秒数，默认 180
MARVIS_AUDIO_DIR          产物根目录，默认 <项目>/temp/audio
MARVIS_AUDIO_SCRIPT       生成脚本路径，默认 <项目同级>/assets/gen_random_melody.py

接口
----
GET  /api/audio/options          前端可选项 + 当前生效配置
GET  /api/audio/jobs             最近的音频任务列表 + 容量统计
GET  /api/audio/jobs/<id>        单个任务状态（前端轮询用）
POST /api/audio/jobs             提交生成任务（返回 job_id）
GET  /api/audio/file/<id>.wav    试听 / 下载（支持 Range，可断点续播）
"""

from __future__ import annotations

import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

BASE_DIR = Path(__file__).resolve().parent

AUDIO_ROOT = Path(
    os.environ.get("MARVIS_AUDIO_DIR") or (BASE_DIR / "temp" / "audio")
).expanduser().resolve()
JOBS_DIR = AUDIO_ROOT / "jobs"
INDEX_FILE = AUDIO_ROOT / "jobs.json"

SCRIPT_PATH = Path(
    os.environ.get("MARVIS_AUDIO_SCRIPT")
    or (BASE_DIR.parent / "assets" / "gen_random_melody.py")
).expanduser().resolve()

# 线程池容量天花板（并发上限最大只能配到这里）
CONCURRENCY_CAP = 16
# 单任务的最短/最长保护性超时
MIN_TIMEOUT = 90.0
# janitor 扫描间隔（秒）
SWEEP_INTERVAL = 30.0
# 认为任务卡死的阈值（秒）
STUCK_SECONDS = 1800.0


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #

def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, value))


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, value))


CONFIG = {
    "concurrency": _env_int("MARVIS_AUDIO_CONCURRENCY", 5, 1, CONCURRENCY_CAP),
    "ttl_hours": _env_float("MARVIS_AUDIO_TTL_HOURS", 24.0, 0.1, 24.0 * 30),
    "max_files": _env_int("MARVIS_AUDIO_MAX_FILES", 100, 1, 2000),
    "max_queue": _env_int("MARVIS_AUDIO_MAX_QUEUE", 20, 1, 200),
    "max_seconds": _env_int("MARVIS_AUDIO_MAX_SECONDS", 180, 5, 600),
}


# --------------------------------------------------------------------------- #
# 前端可选项：全部用大白话，不给用户看 bpm / 调式 / 织体这些词
# --------------------------------------------------------------------------- #

_LENGTHS = [
    {"key": "10", "sec": 10, "label": "10 秒", "hint": "试个味道"},
    {"key": "20", "sec": 20, "label": "20 秒", "hint": "一小段"},
    {"key": "30", "sec": 30, "label": "30 秒", "hint": "刚合适（推荐）"},
    {"key": "60", "sec": 60, "label": "1 分钟", "hint": "能听出完整句子"},
    {"key": "120", "sec": 120, "label": "2 分钟", "hint": "适合当背景音"},
    {"key": "180", "sec": 180, "label": "3 分钟", "hint": "最长，等得久一点"},
]

# 每个心情背后是一组旋律性格参数（走向、跳进、延音、混响、留白、和弦织体）
_MOODS = {
    "happy": {
        "label": "开心明亮", "hint": "往上走、跳一跳",
        "scale": "major", "contour": 0.80, "leap": 0.22, "legato": 0.22,
        "reverb": 0.12, "rest": 0.08, "chord_tex": "arp", "bpm": 0,
    },
    "gentle": {
        "label": "温柔舒缓", "hint": "慢慢来、贴着走",
        "scale": "major", "contour": 0.84, "leap": 0.08, "legato": 0.42,
        "reverb": 0.26, "rest": 0.14, "chord_tex": "pad", "bpm": -12,
    },
    "sad": {
        "label": "有点伤感", "hint": "小调、拖长音",
        "scale": "minor", "contour": 0.76, "leap": 0.12, "legato": 0.40,
        "reverb": 0.30, "rest": 0.16, "chord_tex": "pad", "bpm": -18,
    },
    "mystery": {
        "label": "神秘悬疑", "hint": "留白多、回声长",
        "scale": "minor", "contour": 0.70, "leap": 0.18, "legato": 0.34,
        "reverb": 0.38, "rest": 0.22, "chord_tex": "arp", "bpm": -22,
    },
    "calm": {
        "label": "平静治愈", "hint": "五声音阶，不刺激",
        "scale": "pentatonic", "contour": 0.86, "leap": 0.05, "legato": 0.46,
        "reverb": 0.30, "rest": 0.18, "chord_tex": "pad", "bpm": -20,
    },
    "cool": {
        "label": "酷炫带感", "hint": "花样多、够飒",
        "scale": "minor", "contour": 0.62, "leap": 0.30, "legato": 0.18,
        "reverb": 0.10, "rest": 0.06, "chord_tex": "both", "bpm": 14,
    },
}

# 乐器 = 主旋律音色 + 和声层音色（两者都是脚本内置音色名）
_INSTRUMENTS = {
    "piano": {"label": "钢琴", "hint": "干净耐听，最稳", "timbre": "piano", "pad": "strings"},
    "musicbox": {"label": "八音盒", "hint": "童年、清亮", "timbre": "musicbox", "pad": "strings"},
    "guitar": {"label": "吉他", "hint": "钢弦拨奏，干净利落", "timbre": "pluck",
               "pad": "strings", "octaves": 2},
    "guzheng": {"label": "古筝", "hint": "民乐拨弦，余音悠长", "timbre": "pluck",
                "pad": "pluck", "octaves": 3, "legato_add": 0.12, "reverb_add": 0.10},
    "flute": {"label": "长笛", "hint": "气声、悠远", "timbre": "flute", "pad": "organ"},
    "strings": {"label": "弦乐", "hint": "厚重、有弦群感", "timbre": "strings", "pad": "strings"},
    "bell": {"label": "钟琴", "hint": "金属余音很长", "timbre": "bell", "pad": "strings"},
    "organ": {"label": "风琴", "hint": "教堂 / 复古感", "timbre": "organ", "pad": "organ"},
    "epiano": {"label": "电钢琴", "hint": "柔和、有点电子味", "timbre": "epiano", "pad": "strings"},
    "chiptune": {"label": "8-bit 游戏音", "hint": "红白机那味儿", "timbre": "chiptune", "pad": "square"},
    "sine": {"label": "纯净单音", "hint": "最朴素，几乎没有音色", "timbre": "sine", "pad": "sine"},
}

_SPEEDS = {
    "slow": {"label": "慢慢来", "hint": "舒缓", "bpm": 68},
    "steady": {"label": "不紧不慢", "hint": "正常说话的速度", "bpm": 100},
    "brisk": {"label": "轻快", "hint": "走路带风", "bpm": 128},
    "fast": {"label": "很快很燃", "hint": "紧凑", "bpm": 158},
}

# 繁简度：节奏密度 + 伴奏音量
_COMPLEXITY = {
    "simple": {"label": "简单干净", "hint": "音少、留白多", "rhythm": "simple", "chord_vol": 0.20, "drums_vol": 0.45},
    "medium": {"label": "刚刚好", "hint": "最常用", "rhythm": "medium", "chord_vol": 0.28, "drums_vol": 0.62},
    "rich": {"label": "热热闹闹", "hint": "音密、伴奏满", "rhythm": "complex", "chord_vol": 0.36, "drums_vol": 0.80},
}

LENGTHS = [x for x in _LENGTHS if x["sec"] <= CONFIG["max_seconds"]] or [_LENGTHS[0]]
LENGTH_MAP = {x["key"]: x for x in LENGTHS}

DEFAULT_PARAMS = {
    "length": "30",  # 若 max_seconds 把 30 秒过滤掉了，下面会兜底改成最大可用档

    "mood": "happy",
    "instrument": "piano",
    "speed": "steady",
    "complexity": "medium",
    "harmony": True,
    "bass": True,
    "drums": True,
}

# 默认时长必须落在可用档位里：max_seconds 配小于 30 秒时，30 秒档会被过滤掉
if DEFAULT_PARAMS["length"] not in LENGTH_MAP:
    _safe = [x["key"] for x in LENGTHS if x["sec"] <= 30] or [x["key"] for x in LENGTHS] or ["30"]
    DEFAULT_PARAMS["length"] = _safe[-1]

# 单任务耗时约是音频时长的 0.45 倍 + 固定开销（实测 6 秒音频 3.5 秒、10 秒音频 7 秒出头）
ESTIMATE_RATIO = 0.45
ESTIMATE_BASE = 2.5
# 长音频不是线性增长：单核合成 + 内存搬运在时长上去后放大开销，
# 实测 30 秒约 12 秒、180 秒约 300 秒，幂律 12 × (sec/30)^1.8 能同时贴合这两点
ESTIMATE_KNEE = 60.0
ESTIMATE_POW_COEF = 12.0
ESTIMATE_POW_REF = 30.0
ESTIMATE_POW = 1.8


def estimate_seconds(sec) -> float:
    """预估单个任务耗时（秒）：短音频线性，长音频幂律，取两者较大值避免档位跳变。"""
    try:
        sec = float(sec or 0)
    except (TypeError, ValueError):
        sec = 0.0
    if sec <= 0:
        return round(ESTIMATE_BASE, 1)
    linear = sec * ESTIMATE_RATIO + ESTIMATE_BASE
    if sec <= ESTIMATE_KNEE:
        return round(linear, 1)
    power = ESTIMATE_POW_COEF * ((sec / ESTIMATE_POW_REF) ** ESTIMATE_POW)
    return round(max(linear, power), 1)


# --------------------------------------------------------------------------- #
# 运行时状态
# --------------------------------------------------------------------------- #

LOCK = threading.Lock()
JOBS: dict[str, dict] = {}
_STOP = threading.Event()
_JANITOR: threading.Thread | None = None
_REPORT: dict = {"expired": 0, "overflow": 0, "updated_at": 0.0}


class QueueBusy(RuntimeError):
    """排队任务过多。"""


class _Gate:
    """可变上限的并发闸门：拿到名额才开始合成，超出的任务在池里等。"""

    def __init__(self, limit: int) -> None:
        self.limit = max(1, int(limit))
        self.active = 0
        self._cv = threading.Condition()

    def acquire(self) -> None:
        with self._cv:
            while self.active >= self.limit:
                self._cv.wait(1.0)
            self.active += 1

    def release(self) -> None:
        with self._cv:
            self.active = max(0, self.active - 1)
            self._cv.notify_all()

    def snapshot(self) -> dict:
        with self._cv:
            return {"limit": self.limit, "active": self.active}


_GATE = _Gate(CONFIG["concurrency"])
_POOL = ThreadPoolExecutor(max_workers=CONCURRENCY_CAP, thread_name_prefix="audio-gen")


# --------------------------------------------------------------------------- #
# 索引持久化
# --------------------------------------------------------------------------- #

def _save_locked() -> None:
    """写索引（调用方必须已持有 LOCK）。先写临时文件再替换，避免半截文件。"""
    try:
        AUDIO_ROOT.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "saved_at": time.time(), "jobs": list(JOBS.values())}
        tmp = INDEX_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, INDEX_FILE)
    except OSError:
        traceback.print_exc()


def _save() -> None:
    with LOCK:
        _save_locked()


def _load() -> None:
    if not INDEX_FILE.exists():
        return
    try:
        data = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        traceback.print_exc()
        return
    for job in data.get("jobs") or []:
        if isinstance(job, dict) and job.get("id"):
            JOBS[str(job["id"])] = job


def _job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def _rm_dir(job_id: str) -> None:
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)


def _drop_locked(job_id: str) -> None:
    JOBS.pop(job_id, None)
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)


def _recover() -> None:
    """重启自愈：上次没跑完的任务标记失败；文件丢了的完成态任务直接删掉。"""
    now = time.time()
    with LOCK:
        for job_id in list(JOBS):
            job = JOBS[job_id]
            status = job.get("status")
            if status in ("queued", "running"):
                job.update({
                    "status": "failed",
                    "error": "服务重启，这条任务已中断，请重新生成",
                    "finished_at": now,
                    "expires_at": now + CONFIG["ttl_hours"] * 3600,
                })
                shutil.rmtree(_job_dir(job_id), ignore_errors=True)
                continue
            if status == "done":
                path = Path(job.get("file") or "")
                if not job.get("file") or not path.is_file():
                    JOBS.pop(job_id, None)
                    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
        _save_locked()


# --------------------------------------------------------------------------- #
# 清理：过期删除 + 数量上限（最旧优先）
# --------------------------------------------------------------------------- #

def _clean_orphan_dirs() -> int:
    """jobs 目录下没有登记记录的残留目录一并清掉（只碰本模块自己的目录）。"""
    removed = 0
    if not JOBS_DIR.is_dir():
        return removed
    with LOCK:
        known = set(JOBS)
    try:
        for child in JOBS_DIR.iterdir():
            if not child.is_dir():
                continue
            if child.name in known:
                continue
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
    except OSError:
        traceback.print_exc()
    return removed


def sweep() -> dict:
    """执行一次清理：过期删除、数量超限按最旧删、卡死任务收尾。"""
    now = time.time()
    expired = overflow = stuck = 0
    with LOCK:
        # 1) 过期
        for job_id in list(JOBS):
            job = JOBS[job_id]
            if job.get("status") not in ("done", "failed"):
                continue
            try:
                expires = float(job.get("expires_at") or 0)
            except (TypeError, ValueError):
                expires = 0.0
            if expires and expires <= now:
                _drop_locked(job_id)
                expired += 1
        # 2) 卡死
        for job_id in list(JOBS):
            job = JOBS[job_id]
            if job.get("status") != "running":
                continue
            try:
                started = float(job.get("started_at") or 0)
            except (TypeError, ValueError):
                started = 0.0
            if started and now - started > STUCK_SECONDS:
                job.update({
                    "status": "failed",
                    "error": "生成卡住了超过 %.0f 分钟，已中断，请重新生成" % (STUCK_SECONDS / 60.0),
                    "finished_at": now,
                    "expires_at": now + CONFIG["ttl_hours"] * 3600,
                })
                shutil.rmtree(_job_dir(job_id), ignore_errors=True)
                stuck += 1
        # 3) 数量上限
        done = [j for j in JOBS.values() if j.get("status") == "done"]
        done.sort(key=lambda j: float(j.get("created_at") or 0))
        while len(done) > CONFIG["max_files"]:
            victim = done.pop(0)
            _drop_locked(str(victim["id"]))
            overflow += 1
        if expired or overflow or stuck:
            _save_locked()
    _clean_orphan_dirs()
    _REPORT.update({"expired": _REPORT["expired"] + expired,
                    "overflow": _REPORT["overflow"] + overflow,
                    "updated_at": now})
    return {"expired": expired, "overflow": overflow, "stuck": stuck}


def _janitor_loop() -> None:
    while not _STOP.wait(SWEEP_INTERVAL):
        try:
            sweep()
        except Exception:  # noqa: BLE001
            traceback.print_exc()


# --------------------------------------------------------------------------- #
# 参数归一化（前端只传大白话选项，这里翻译成脚本参数）
# --------------------------------------------------------------------------- #

def _pick(raw: dict, key: str, catalog: dict, default: str) -> str:
    value = str(raw.get(key, "") or "").strip().lower()
    return value if value in catalog else default


def _flag(raw: dict, key: str, default: bool = True) -> bool:
    value = raw.get(key, default)
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


# 老版本前端提交过合并档位 "pluck"，统一映射到拆分后的吉他，避免回落到默认钢琴
INSTRUMENT_ALIASES = {"pluck": "guitar"}


def normalize(raw: dict) -> dict:
    """校验并翻译前端参数，返回 {raw, labels, sec, title, estimate}。"""
    if INSTRUMENT_ALIASES.get(str(raw.get("instrument", "")).strip().lower()):
        raw = dict(raw)
        raw["instrument"] = INSTRUMENT_ALIASES[str(raw["instrument"]).strip().lower()]
    length_key = _pick(raw, "length", LENGTH_MAP, DEFAULT_PARAMS["length"])
    mood_key = _pick(raw, "mood", _MOODS, DEFAULT_PARAMS["mood"])
    inst_key = _pick(raw, "instrument", _INSTRUMENTS, DEFAULT_PARAMS["instrument"])
    speed_key = _pick(raw, "speed", _SPEEDS, DEFAULT_PARAMS["speed"])
    comp_key = _pick(raw, "complexity", _COMPLEXITY, DEFAULT_PARAMS["complexity"])

    length = LENGTH_MAP[length_key]
    mood = _MOODS[mood_key]
    inst = _INSTRUMENTS[inst_key]
    speed = _SPEEDS[speed_key]
    comp = _COMPLEXITY[comp_key]

    flags = {
        "harmony": _flag(raw, "harmony", True),
        "bass": _flag(raw, "bass", True),
        "drums": _flag(raw, "drums", True),
    }

    sec = int(length["sec"])
    estimate = estimate_seconds(sec)
    title = "%s · %s · %s" % (inst["label"], mood["label"], length["label"])

    return {
        "raw": {"length": length_key, "mood": mood_key, "instrument": inst_key,
                "speed": speed_key, "complexity": comp_key, **flags},
        "labels": {"length": length["label"], "mood": mood["label"],
                   "instrument": inst["label"], "speed": speed["label"],
                   "complexity": comp["label"], **flags},
        "sec": sec,
        "title": title,
        "estimate": estimate,
        "parts": {"mood": mood, "inst": inst, "speed": speed, "comp": comp},
    }


def _build_command(raw: dict, job_dir: Path, job_id: str, sec: int, seed: int) -> list[str]:
    norm = normalize(raw)
    mood = norm["parts"]["mood"]
    inst = norm["parts"]["inst"]
    speed = norm["parts"]["speed"]
    comp = norm["parts"]["comp"]
    bpm = max(20.0, min(300.0, float(speed["bpm"]) + float(mood["bpm"])))
    flags = norm["raw"]
    # 拨弦类乐器共用底层音色，靠音域跨度 / 和声层音色 / 余音长短拉开听感差距
    octaves = int(inst.get("octaves", 2))
    legato = max(0.0, min(0.6, float(mood["legato"]) + float(inst.get("legato_add", 0.0))))
    reverb = max(0.0, min(0.6, float(mood["reverb"]) + float(inst.get("reverb_add", 0.0))))

    cmd = [
        sys.executable, "-u", str(SCRIPT_PATH),
        "-o", str(job_dir),
        "--name", job_id,
        "--seed", str(seed),
        "-D", str(sec),
        "-t", inst["timbre"],
        "-k", "C4",
        "-s", mood["scale"],
        "--bpm", "%.0f" % bpm,
        "--octaves", str(octaves),
        "--rhythm", comp["rhythm"],
        "--contour", "%.2f" % mood["contour"],
        "--leap", "%.2f" % mood["leap"],
        "--legato", "%.2f" % legato,
        "--reverb", "%.2f" % reverb,
        "--rest", "%.2f" % mood["rest"],
        "--chord-tex", mood["chord_tex"],
        "--chord-vol", "%.2f" % comp["chord_vol"],
        "--pad-timbre", inst["pad"],
        "--bass-timbre", "sine",
        "--drums-vol", "%.2f" % comp["drums_vol"],
        "--gain", "1.0",
        "--sample-rate", "44100",
        "--channels", "1",
        "--no-score",
        "--quiet",
    ]
    if not flags["harmony"]:
        cmd.append("--no-chord")
    if not flags["bass"]:
        cmd.append("--no-bass")
    if not flags["drums"]:
        cmd.append("--no-drums")
    return cmd


# --------------------------------------------------------------------------- #
# 生成
# --------------------------------------------------------------------------- #

def _decode(data: bytes | None) -> str:
    if not data:
        return ""
    for enc in ("utf-8", "gbk"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def _tail(text: str, limit: int = 1500) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else "…" + text[-limit:]


def _find_wav(job_dir: Path, job_id: str) -> Path | None:
    exact = job_dir / ("%s.wav" % job_id)
    if exact.is_file() and exact.stat().st_size > 1024:
        return exact
    if not job_dir.is_dir():
        return None
    candidates = [p for p in job_dir.glob("*.wav") if p.is_file() and p.stat().st_size > 1024]
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_size, reverse=True)
    return candidates[0]


def _explain(rc: int, out: str) -> str:
    text = (out or "").strip()
    for line in text.splitlines():
        if "[错误]" in line or "[超时]" in line:
            return line.replace("[错误]", "").strip() or line
    low = text.lower()
    if "can't open file" in low or "no such file" in low or "找不到" in text:
        return "生成脚本无法启动，脚本文件可能不存在，请检查 assets 目录"
    if rc == 2:
        return "生成脚本认为参数不合法（返回码 2）"
    if rc == 3:
        return "生成脚本无法创建输出目录（返回码 3）"
    if rc in (-9, 124):
        return "生成超时被终止，请把时长改短一点再试"
    if rc == -1:
        return "生成脚本启动失败，请检查 assets 目录是否完整"
    return "生成脚本异常退出（返回码 %s）" % rc


def _run_job(job_id: str) -> None:
    _GATE.acquire()
    try:
        with LOCK:
            job = JOBS.get(job_id)
            if not job or job.get("status") != "queued":
                return
            job["status"] = "running"
            job["started_at"] = time.time()
            raw = dict(job.get("raw") or normalize({})["raw"])
            sec = int(job.get("seconds") or 30)
            seed = int(job.get("seed") or random.randint(1, 9999999))
            _save_locked()

        job_dir = _job_dir(job_id)
        try:
            job_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            _fail(job_id, "无法创建输出目录：%s" % exc)
            return

        if not SCRIPT_PATH.is_file():
            _fail(job_id, "生成脚本不存在：%s（请检查 assets 目录是否完整）" % SCRIPT_PATH)
            return

        cmd = _build_command(raw, job_dir, job_id, sec, seed)
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        timeout = max(MIN_TIMEOUT, sec * 4.0 + 60.0)

        output, rc = "", 0
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(SCRIPT_PATH.parent),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                env=env,
            )
            output = _decode(proc.stdout)
            rc = int(proc.returncode)
        except subprocess.TimeoutExpired as exc:
            output = _decode(exc.stdout) + "\n[超时] 超过 %.0f 秒仍未完成" % timeout
            rc = -9
        except (OSError, ValueError) as exc:
            output = "[错误] 启动生成脚本失败：%s" % exc
            rc = -1

        wav = _find_wav(job_dir, job_id)
        if rc == 0 and wav is not None:
            size = wav.stat().st_size
            now = time.time()
            with LOCK:
                job = JOBS.get(job_id)
                if job is not None:
                    job.update({
                        "status": "done",
                        "finished_at": now,
                        "file": str(wav),
                        "size": size,
                        "error": "",
                        "log": _tail(output),
                        "expires_at": now + CONFIG["ttl_hours"] * 3600,
                    })
                    _save_locked()
        else:
            _fail(job_id, _explain(rc, output), output)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _fail(job_id, "生成过程出错：%s: %s" % (type(exc).__name__, exc))
    finally:
        _GATE.release()
        try:
            sweep()
        except Exception:  # noqa: BLE001
            traceback.print_exc()


def _fail(job_id: str, reason: str, output: str = "") -> None:
    now = time.time()
    with LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job.update({
            "status": "failed",
            "finished_at": now,
            "error": reason or "生成失败",
            "log": _tail(output),
            "expires_at": now + CONFIG["ttl_hours"] * 3600,
        })
        shutil.rmtree(_job_dir(job_id), ignore_errors=True)
        _save_locked()


# --------------------------------------------------------------------------- #
# 对外读取视图
# --------------------------------------------------------------------------- #

def _queue_position(job_id: str) -> int:
    """排队序号（1 = 下一个轮到），只对 queued 有意义。"""
    pending = sorted((j for j in JOBS.values() if j.get("status") == "queued"),
                     key=lambda j: float(j.get("created_at") or 0))
    for idx, job in enumerate(pending, 1):
        if job.get("id") == job_id:
            return idx
    return 0


def public_job(job: dict) -> dict:
    now = time.time()
    status = job.get("status") or "queued"
    job_id = str(job.get("id") or "")
    expires = job.get("expires_at")
    try:
        remaining = max(0, int(float(expires or 0) - now))
    except (TypeError, ValueError):
        remaining = 0
    try:
        elapsed = int(now - float(job.get("started_at") or job.get("created_at") or now))
    except (TypeError, ValueError):
        elapsed = 0
    url = ""
    download = ""
    if status == "done":
        url = "/api/audio/file/%s.wav" % job_id
        download = url + "?download=1"
    return {
        "id": job_id,
        "status": status,
        "title": job.get("title") or "随机音乐",
        "params": job.get("params") or {},
        "seed": job.get("seed"),
        "seconds": job.get("seconds"),
        "size": job.get("size") or 0,
        "created_at": job.get("created_at"),
        "finished_at": job.get("finished_at"),
        "expires_at": expires,
        "expires_in": remaining,
        "elapsed": elapsed,
        "estimate": job.get("estimate") or 0,
        "queue_position": _queue_position(job_id) if status == "queued" else 0,
        "url": url,
        "download_url": download,
        "error": job.get("error") or "",
    }


def stats() -> dict:
    with LOCK:
        done = sum(1 for j in JOBS.values() if j.get("status") == "done")
        running = sum(1 for j in JOBS.values() if j.get("status") == "running")
        queued = sum(1 for j in JOBS.values() if j.get("status") == "queued")
        failed = sum(1 for j in JOBS.values() if j.get("status") == "failed")
    gate = _GATE.snapshot()
    return {
        "available": done,
        "running": running,
        "queued": queued,
        "failed": failed,
        "concurrency": gate["limit"],
        "active": gate["active"],
        "max_files": CONFIG["max_files"],
        "ttl_hours": CONFIG["ttl_hours"],
        "max_queue": CONFIG["max_queue"],
        "max_seconds": CONFIG["max_seconds"],
        "script_ok": SCRIPT_PATH.is_file(),
        "cleaned": dict(_REPORT),
    }


def recent_jobs(limit: int = 50) -> list[dict]:
    with LOCK:
        items = list(JOBS.values())
    items.sort(key=lambda j: float(j.get("created_at") or 0), reverse=True)
    return [public_job(j) for j in items[:limit]]


def options_payload() -> dict:
    return {
        "defaults": dict(DEFAULT_PARAMS),
        "lengths": [{"key": x["key"], "label": x["label"], "hint": x["hint"]} for x in LENGTHS],
        "moods": [{"key": k, "label": v["label"], "hint": v["hint"]} for k, v in _MOODS.items()],
        "instruments": [{"key": k, "label": v["label"], "hint": v["hint"]} for k, v in _INSTRUMENTS.items()],
        "speeds": [{"key": k, "label": v["label"], "hint": v["hint"]} for k, v in _SPEEDS.items()],
        "complexities": [{"key": k, "label": v["label"], "hint": v["hint"]} for k, v in _COMPLEXITY.items()],
        "toggles": [
            {"key": "harmony", "label": "和声铺底", "hint": "垫一层和弦，听着更饱满"},
            {"key": "bass", "label": "低音", "hint": "加一层低音，声音更厚"},
            {"key": "drums", "label": "鼓点", "hint": "加强节奏感，会更有律动"},
        ],
        "config": stats(),
        "estimate_ratio": ESTIMATE_RATIO,
        # 前端「预计 X 秒左右做好」用同一套分段模型，避免两处口径不一致
        "estimate": {
            "ratio": ESTIMATE_RATIO,
            "base": ESTIMATE_BASE,
            "knee": ESTIMATE_KNEE,
            "coef": ESTIMATE_POW_COEF,
            "ref": ESTIMATE_POW_REF,
            "pow": ESTIMATE_POW,
        },
    }


# --------------------------------------------------------------------------- #
# 提交任务
# --------------------------------------------------------------------------- #

def submit(raw: dict) -> dict:
    payload = raw if isinstance(raw, dict) else {}
    with LOCK:
        pending = sum(1 for j in JOBS.values() if j.get("status") in ("queued", "running"))
    if pending >= CONFIG["max_queue"]:
        raise QueueBusy("后台排队的任务已经有 %d 个，等一会儿再来" % CONFIG["max_queue"])

    norm = normalize(payload)
    seed_raw = payload.get("seed")
    try:
        seed = int(seed_raw) if seed_raw not in (None, "") else random.randint(1, 9999999)
    except (TypeError, ValueError):
        seed = random.randint(1, 9999999)

    job_id = uuid.uuid4().hex[:12]
    now = time.time()
    job = {
        "id": job_id,
        "status": "queued",
        "created_at": now,
        "started_at": None,
        "finished_at": None,
        "seed": seed,
        "seconds": norm["sec"],
        "estimate": norm["estimate"],
        "title": norm["title"],
        "params": norm["labels"],
        "raw": norm["raw"],
        "size": 0,
        "file": "",
        "error": "",
        "log": "",
        # 先按提交时间给一个预估有效期，真正生成完会重写成「完成时间 + TTL」
        "expires_at": now + CONFIG["ttl_hours"] * 3600,
    }
    with LOCK:
        JOBS[job_id] = job
        _save_locked()
    _POOL.submit(_run_job, job_id)
    return public_job(job)


# --------------------------------------------------------------------------- #
# 音频文件下发（支持 Range，Safari / 拖动进度条都要）
# --------------------------------------------------------------------------- #

def _serve_wav(h, job: dict, download: bool = False) -> None:
    if job.get("status") != "done":
        return h._error("这个音频还没生成好", 409)
    path = Path(job.get("file") or "")
    if not path.is_file():
        return h._error("音频文件已过期或被清理", 410)
    total = path.stat().st_size
    if total <= 0:
        return h._error("音频文件为空", 500)

    start, end = 0, total - 1
    partial = False
    header = (h.headers.get("Range") or "").strip()
    if header.lower().startswith("bytes="):
        spec = header[6:].split(",")[0].strip()
        try:
            if spec.startswith("-"):
                length = int(spec[1:])
                start = max(0, total - length)
            elif "-" in spec:
                left, right = spec.split("-", 1)
                start = int(left) if left.strip() else 0
                if right.strip():
                    end = min(total - 1, int(right))
            start = max(0, min(start, total - 1))
            end = max(start, min(end, total - 1))
            partial = True
        except ValueError:
            start, end, partial = 0, total - 1, False

    length = end - start + 1
    h.send_response(206 if partial else 200)
    h.send_header("Content-Type", "audio/wav")
    h.send_header("Accept-Ranges", "bytes")
    h.send_header("Content-Length", str(length))
    if partial:
        h.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
    disposition = "attachment" if download else "inline"
    ascii_name = "audio-%s.wav" % job.get("id", "clip")
    pretty = "%s.wav" % (job.get("title") or "random-music")
    h.send_header(
        "Content-Disposition",
        "%s; filename=\"%s\"; filename*=UTF-8''%s" % (disposition, ascii_name, quote(pretty, safe="")),
    )
    h.send_header("Cache-Control", "private, max-age=600")
    h.end_headers()
    if getattr(h, "_head_only", False):
        return
    try:
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                h.wfile.write(chunk)
                remaining -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #

_JOB_RE = re.compile(r"^/api/audio/jobs/([0-9a-zA-Z]{6,40})$")
_FILE_RE = re.compile(r"^/api/audio/file/([0-9a-zA-Z]{6,40})(?:\.wav)?$")


def handle(h, method: str, path: str, qs: dict) -> bool:
    """与 forum / novel 模块同签名：处理了返回 True。"""
    if path != "/api/audio" and not path.startswith("/api/audio/"):
        return False

    if path == "/api/audio/options" and method in ("GET", "HEAD"):
        h._json({"ok": True, **options_payload()})
        return True

    if path in ("/api/audio/jobs", "/api/audio") and method in ("GET", "HEAD"):
        try:
            limit = int((qs.get("limit") or ["50"])[0])
        except (TypeError, ValueError):
            limit = 50
        limit = max(1, min(200, limit))
        h._json({"ok": True, "jobs": recent_jobs(limit), "stats": stats()})
        return True

    if path == "/api/audio/jobs" and method == "POST":
        try:
            payload = h._read_body(limit=8000)
        except ValueError as exc:
            h._error(exc, 400)
            return True
        try:
            job = submit(payload)
        except QueueBusy as exc:
            h._json({"ok": False, "error": str(exc), "code": "queue_full"}, 429)
            return True
        except ValueError as exc:
            h._error(exc, 400)
            return True
        h._json({"ok": True, "job": job}, 202)
        return True

    m = _JOB_RE.match(path)
    if m and method in ("GET", "HEAD"):
        job = JOBS.get(m.group(1))
        if not job:
            h._json({"ok": False, "error": "任务不存在或已过期清理", "code": "not_found"}, 404)
            return True
        h._json({"ok": True, "job": public_job(job)})
        return True

    m = _FILE_RE.match(path)
    if m and method in ("GET", "HEAD"):
        job = JOBS.get(m.group(1))
        if not job:
            h._json({"ok": False, "error": "音频不存在或已过期清理", "code": "not_found"}, 404)
            return True
        download = str((qs.get("download") or [""])[0]).strip() not in ("", "0", "false")
        _serve_wav(h, job, download)
        return True

    if method in ("POST", "GET", "HEAD"):
        h._error("未知的音频接口：" + path, 404)
        return True
    return False


# --------------------------------------------------------------------------- #
# 初始化
# --------------------------------------------------------------------------- #

def init() -> dict:
    """建目录、载入索引、重启自愈、扫一次、起 janitor 线程。"""
    AUDIO_ROOT.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    _load()
    _recover()
    result = sweep()
    global _JANITOR
    if _JANITOR is None or not _JANITOR.is_alive():
        _STOP.clear()
        _JANITOR = threading.Thread(target=_janitor_loop, name="audio-janitor", daemon=True)
        _JANITOR.start()
    info = {
        "root": str(AUDIO_ROOT),
        "script": str(SCRIPT_PATH),
        "script_ok": SCRIPT_PATH.is_file(),
        **CONFIG,
        "jobs": len(JOBS),
        "sweep": result,
    }
    return info


def shutdown() -> None:
    _STOP.set()
    _POOL.shutdown(wait=False, cancel_futures=True)
