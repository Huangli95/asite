/* ==========================================================================
   算术闯关（Math Run）· 小游戏板块
   --------------------------------------------------------------------------
   玩法：
   1. 小人站在底线，可左右移动；身后跟着的队伍人数就是本局的生命与资源；
   2. 运算门从屏幕上方往下落，每道门被中线分成左右两半，各写一个算式；
   3. 门下落到小人所在高度时结算：小人站在哪半边，人数就按那半边的算式变化 —
      「+12」「7+5」是按常量增减，「×2」「÷3」按当前人数乘除，「×2+5」先乘再加；
   4. 撑过本关全部门数即闯关成功，进入下一关：门更多、下落更快、算式更复杂；
   5. 人数归零本局结束，回到第一关。
   数值与节奏全部由 CFG 控制，页面「设置」可实时改（不写 localStorage，刷新恢复默认）。
   ========================================================================== */
(function () {
  "use strict";

  var canvas = document.getElementById("mm-canvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  var ui = {
    stage: document.getElementById("mm-stage"),
    level: document.getElementById("mm-level"),
    count: document.getElementById("mm-count"),
    progress: document.getElementById("mm-progress"),
    score: document.getElementById("mm-score"),
    start: document.getElementById("mm-start"),
    startBtn: document.getElementById("mm-start-btn"),
    clear: document.getElementById("mm-clear"),
    clearLevel: document.getElementById("mm-clear-level"),
    clearCount: document.getElementById("mm-clear-count"),
    clearCarry: document.getElementById("mm-clear-carry"),
    clearScore: document.getElementById("mm-clear-score"),
    next: document.getElementById("mm-next"),
    over: document.getElementById("mm-over"),
    overTitle: document.getElementById("mm-over-title"),
    overText: document.getElementById("mm-over-text"),
    overLevel: document.getElementById("mm-over-level"),
    overScore: document.getElementById("mm-over-score"),
    again: document.getElementById("mm-again"),
    left: document.getElementById("mm-left"),
    right: document.getElementById("mm-right"),
    pause: document.getElementById("mm-pause"),
    restart: document.getElementById("mm-restart"),
    cfgOpen: document.getElementById("mm-cfg-open"),
    cfg: document.getElementById("mm-cfg"),
    cfgMask: document.getElementById("mm-cfg-mask"),
    cfgBody: document.getElementById("mm-cfg-body"),
    cfgClose: document.getElementById("mm-cfg-close"),
    cfgOk: document.getElementById("mm-cfg-ok"),
    cfgReset: document.getElementById("mm-cfg-reset")
  };

  /* ====================== 可配置项（默认配置） ====================== */

  var DEFAULT_CFG = {
    team: {
      startCount: 6,       /* 开局人数 */
      countCap: 999,       /* 人数上限（超出按上限算） */
      spriteMax: 60,       /* 画面上最多画多少个成员（人数再多也只画这么多） */
      moveSpeed: 1.0,      /* 横向移动速度 = 画布宽 * moveSpeed（像素/秒） */
      moveMin: 240, moveMax: 900
    },
    level: {
      gatesBase: 8,        /* 首关门数 */
      gatesPerLevel: 2,    /* 每过一关增加的门数 */
      gatesMax: 20,        /* 单关门数上限 */
      speedBase: 40,       /* 首关下落速度（像素/秒），本轮再减半 */
      speedPerLevel: 3,    /* 每关加速度（同步减半） */
      speedMax: 108,       /* 下落速度上限（同步减半） */
      gapK: 0.8,           /* 门间距 = 屏高 * gapK（默认加宽） */
      gapMin: 170,         /* 门间距下限（像素） */
      tierPerLevel: 1,     /* 每几关提升一档运算复杂度（默认每关一档） */
      maxTier: 5,          /* 运算复杂度档位上限 */
      carryRatio: 60,      /* 过关后带入下一关的人数比例（%），压制人数滚雪球 */
      clearDelay: 0.9      /* 最后一扇门结算后到过关弹窗的间隔（秒） */
    },
    rules: {
      allowLossBoth: "on", /* 能否出现两侧都减人的「取舍门」 */
      showResult: "off",   /* 门上是否直接显示算式结果 */
      scoreSurvivor: 10,   /* 过关每留 1 人得分 */
      scoreLevel: 60       /* 过关基础分（再乘关卡数） */
    },
    look: {
      gateRatio: 0.115,    /* 门高 = 屏高 * gateRatio（比初版明显加高） */
      gateMin: 48, gateMax: 92,
      fontSize: 0.44,      /* 门内算式字号 = 门高 * fontSize */
      gridSpeed: 0.55      /* 背景网格滚动速度系数 */
    }
  };

  /* 设置面板字段（p = 配置路径，l = 标签） */
  var CFG_FIELDS = [
    {
      g: "队伍", items: [
        { p: "team.startCount", l: "开局人数", min: 1, max: 30, step: 1 },
        { p: "team.countCap", l: "人数上限", min: 50, max: 999, step: 1 },
        { p: "team.spriteMax", l: "显示成员上限", min: 10, max: 120, step: 1 },
        { p: "team.moveSpeed", l: "横向速度系数", min: 0.3, max: 2.5, step: 0.05 }
      ]
    },
    {
      g: "关卡节奏", items: [
        { p: "level.gatesBase", l: "首关门数", min: 2, max: 20, step: 1 },
        { p: "level.gatesPerLevel", l: "每关增加门数", min: 0, max: 5, step: 1 },
        { p: "level.gatesMax", l: "门数上限", min: 3, max: 40, step: 1 },
        { p: "level.speedBase", l: "首关下落速度", min: 20, max: 300, step: 5 },
        { p: "level.speedPerLevel", l: "每关加速度", min: 0, max: 60, step: 1 },
        { p: "level.speedMax", l: "速度上限", min: 40, max: 500, step: 5 },
        { p: "level.gapK", l: "门间距（屏高比例）", min: 0.3, max: 1.2, step: 0.05 },
        { p: "level.carryRatio", l: "过关带入人数比例（%）", min: 20, max: 100, step: 5 }
      ]
    },
    {
      g: "难度与规则", items: [
        { p: "level.tierPerLevel", l: "每几关升一档运算", min: 1, max: 4, step: 1 },
        { p: "level.maxTier", l: "运算档位上限", min: 1, max: 5, step: 1 },
        { p: "rules.allowLossBoth", l: "两侧都减人的取舍门", options: [{ v: "on", t: "允许" }, { v: "off", t: "关闭" }] },
        { p: "rules.showResult", l: "门上显示算式结果", options: [{ v: "off", t: "不显示" }, { v: "on", t: "显示" }] },
        { p: "rules.scoreSurvivor", l: "过关每人得分", min: 0, max: 100, step: 1 },
        { p: "rules.scoreLevel", l: "过关基础分", min: 0, max: 500, step: 10 }
      ]
    },
    {
      g: "外观", items: [
        { p: "look.gateRatio", l: "门高（屏高比例）", min: 0.04, max: 0.3, step: 0.005 },
        { p: "look.gateMin", l: "门高下限（像素）", min: 20, max: 160, step: 2 },
        { p: "look.gateMax", l: "门高上限（像素）", min: 40, max: 240, step: 2 },
        { p: "look.fontSize", l: "字号（占门高比例）", min: 0.2, max: 0.7, step: 0.02 }
      ]
    }
  ];

  var CFG = deepClone(DEFAULT_CFG);

  /* ====================== 工具函数 ====================== */

  function deepClone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
  }

  function randInt(a, b) {
    if (b < a) { var t = a; a = b; b = t; }
    return a + Math.floor(Math.random() * (b - a + 1));
  }

  function getPath(obj, p) {
    var parts = String(p).split("."), cur = obj, i;
    for (i = 0; i < parts.length; i++) cur = cur[parts[i]];
    return cur;
  }

  function setPath(obj, p, v) {
    var parts = String(p).split("."), cur = obj, i;
    for (i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = v;
  }

  /* ====================== 尺寸与场地 ====================== */

  var W = 360, H = 560, DPR = 1, sized = false;
  var geo = { unit: 14, groundY: 480 };

  function gateHeight() {
    return clamp(Math.round(H * CFG.look.gateRatio), CFG.look.gateMin, CFG.look.gateMax);
  }

  function resize() {
    var rect = ui.stage.getBoundingClientRect();
    var w = Math.max(240, Math.round(rect.width));
    var h = Math.max(300, Math.round(rect.height));
    var dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (sized && w === W && h === H && dpr === DPR) return;

    var oldW = W, oldH = H;
    W = w;
    H = h;
    DPR = dpr;
    sized = true;

    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    geo.unit = clamp(Math.round(H * 0.026), 10, 17);
    geo.groundY = H - clamp(Math.round(H * 0.11), 34, 68);

    reflow(oldW, oldH);
  }

  /* 尺寸变化后按比例搬动已有元素，避免门 / 队伍跑到画面外 */
  function reflow(oldW, oldH) {
    if (!oldW || !oldH) return;
    var kx = W / oldW, ky = H / oldH, i;
    S.leader.x = clamp(S.leader.x * kx, geo.unit, W - geo.unit);
    for (i = 0; i < S.gates.length; i++) {
      S.gates[i].y *= ky;
      S.gates[i].h = gateHeight();
    }
    for (i = 0; i < S.crowd.length; i++) {
      S.crowd[i].x *= kx;
      S.crowd[i].y *= ky;
    }
  }

  /* ====================== 运算门：算式与结算 ====================== */

  function opAdd(v) {
    return { kind: "add", v: v, label: (v >= 0 ? "+" : "-") + Math.abs(v), res: 0, color: null };
  }

  function opSub(v) {
    return opAdd(-Math.abs(v));
  }

  function opExpr(label, delta) {
    return { kind: "add", v: delta, label: label, res: 0, color: null };
  }

  function opMul(v) {
    return { kind: "mul", v: v, label: "×" + v, res: 0, color: null };
  }

  function opDiv(v) {
    return { kind: "div", v: v, label: "÷" + v, res: 0, color: null };
  }

  function opMulAdd(v, add) {
    return { kind: "mulAdd", v: v, add: add, label: "×" + v + "+" + add, res: 0, color: null };
  }

  /* 把一个算式作用到当前人数上，返回结算后的人数 */
  function applyOp(op, q) {
    var r;
    if (op.kind === "mul") r = q * op.v;
    else if (op.kind === "div") r = Math.floor(q / op.v);
    else if (op.kind === "mulAdd") r = q * op.v + op.add;
    else r = q + op.v;
    if (r < 0) r = 0;
    if (r > CFG.team.countCap) r = CFG.team.countCap;
    return r;
  }

  /* 按档位生成一个算式：gain = 偏增益，risk = 偏差（只是数值偏好，与门颜色无关）
     第 1 档 只有加减｜第 2 档 单独的乘除｜第 3 档 加减乘混合｜第 4 档 加减乘除混合｜第 5 档 括号优先级、最多 5 项 */
  function randOp(tier, q, mode) {
    var t = clamp(tier, 1, 5);
    var gain = mode === "gain";
    var roll = Math.random();
    var a, b, c, d, e;

    if (t <= 1) {
      /* 第 1 档：单独的加减，也允许加减混合（如 8 + 6 - 3 / 2 + 3 - 8） */
      if (gain) {
        if (roll < 0.55) {
          a = randInt(2, 7);
          b = randInt(1, 5);
          return opExpr(a + " + " + b, a + b);
        }
        a = randInt(4, 9);
        b = randInt(1, 4);
        c = randInt(1, Math.max(1, a + b - 1));
        return opExpr(a + " + " + b + " - " + c, a + b - c);
      }
      if (roll < 0.5) {
        a = randInt(3, 9);
        b = a + randInt(1, 5);
        return opExpr(a + " - " + b, a - b);
      }
      if (roll < 0.75) {
        a = randInt(2, 5);
        b = randInt(1, 4);
        c = randInt(a + b + 1, a + b + 6);
        return opExpr(a + " + " + b + " - " + c, a + b - c);
      }
      return opSub(randInt(1, 3));
    }

    if (t === 2) {
      /* 第 2 档：只有单独的乘除法 */
      if (gain) return opMul(roll < 0.72 ? 2 : 3);
      return opDiv(roll < 0.72 ? 2 : 3);
    }

    if (t === 3) {
      /* 第 3 档：加减乘混合 */
      if (gain) {
        if (roll < 0.42) {
          a = randInt(2, 5); b = randInt(2, 6); c = randInt(2, 9);
          return opExpr(a + " × " + b + " + " + c, a * b + c);
        }
        if (roll < 0.78) {
          a = randInt(2, 4); b = randInt(3, 6); c = randInt(2, a * b - 1);
          return opExpr(a + " × " + b + " - " + c, a * b - c);
        }
        return opMul(2);
      }
      if (roll < 0.55) {
        a = randInt(2, 5); b = randInt(2, 4); c = randInt(a * b + 1, a * b + 8);
        return opExpr(c + " - " + a + " × " + b, c - a * b);
      }
      a = randInt(3, 7); b = randInt(2, 6); c = randInt(1, 3);
      return opExpr(a + " + " + b + " - " + c, a + b - c);
    }

    if (t === 4) {
      /* 第 4 档：加减乘除混合（除法全部整除） */
      if (gain) {
        if (roll < 0.34) {
          c = randInt(2, 4); a = c * randInt(2, 6); b = randInt(2, 5);
          return opExpr(a + " × " + b + " ÷ " + c, a * b / c);
        }
        if (roll < 0.68) {
          b = randInt(2, 4); a = b * randInt(2, 8); c = randInt(2, 9);
          return opExpr(a + " ÷ " + b + " + " + c, a / b + c);
        }
        a = randInt(2, 4); b = randInt(2, 5); c = randInt(2, 3); d = c * randInt(2, 4);
        return opExpr(a + " × " + b + " - " + d + " ÷ " + c, a * b - d / c);
      }
      if (roll < 0.55) {
        b = randInt(2, 4); a = b * randInt(2, 6); c = randInt(2, 6);
        return opExpr(a + " ÷ " + b + " - " + c, a / b - c);
      }
      b = randInt(2, 4); a = b * randInt(2, 5); c = randInt(1, 9);
      return opExpr(a + " ÷ " + b + " + " + c, a / b + c);
    }

    /* 第 5 档：括号优先级，最多 5 项 */
    if (gain) {
      if (roll < 0.40) {
        a = randInt(2, 8); b = randInt(2, 8); c = randInt(2, 3);
        return opExpr("(" + a + " + " + b + ") × " + c, (a + b) * c);
      }
      if (roll < 0.72) {
        a = randInt(2, 8); b = randInt(2, 8); c = randInt(2, 3); d = randInt(2, 9);
        return opExpr("(" + a + " + " + b + ") × " + c + " - " + d, (a + b) * c - d);
      }
      a = randInt(2, 6); b = randInt(2, 6); c = randInt(2, 3);
      d = randInt(2, 3); e = d * randInt(1, 3);
      return opExpr("(" + a + " + " + b + ") × " + c + " - " + e + " ÷ " + d, (a + b) * c - e / d);
    }
    if (roll < 0.45) {
      a = randInt(2, 5); b = randInt(2, 5); c = randInt(2, 3);
      return opExpr("-(" + a + " + " + b + ") × " + c, -((a + b) * c));
    }
    a = randInt(4, 9); b = randInt(1, 3); c = randInt(2, 3); d = randInt(1, 5);
    return opExpr("(" + a + " - " + b + ") × " + c + " - " + d, (a - b) * c - d);
  }

  /* 人数很少时收窄单次减值，并避免除法把队伍除空（保留风险，但不至于瞬杀） */
  function soften(op, q) {
    if (op.kind === "div" && q <= 4) return opAdd(-Math.max(1, q - 1));
    if (op.kind !== "add" || op.v >= 0) return op;
    var limit = q <= 4 ? Math.max(1, q - 1) : Math.max(1, Math.floor(q * 0.6));
    if (-op.v > limit) return opAdd(-limit);
    return op;
  }

  /* 生成一道门：左右各一个算式，保证两侧结果不同、且至少有一侧让人数增加 */
  function makeGate(q, tier) {
    var a, b, ra, rb, i;
    var allowBothLoss = CFG.rules.allowLossBoth === "on";

    /* 人数已经顶到上限时，任何「加」都无意义，改成两侧都减的取舍门 */
    if (q >= CFG.team.countCap) {
      a = soften(opSub(randInt(1, 4 + tier * 2)), q);
      b = soften(opSub(randInt(6, 10 + tier * 3)), q);
      return tintGate(a, b);
    }

    for (i = 0; i < 24; i++) {
      a = soften(randOp(tier, q, "gain"), q);
      b = soften(randOp(tier, q, "risk"), q);
      ra = applyOp(a, q);
      rb = applyOp(b, q);
      if (ra === rb) continue;
      if (Math.max(ra, rb) <= 0) continue;
      if (Math.max(ra, rb) > q) break;
      if (allowBothLoss && q > 8 && Math.random() < 0.18) break;
    }

    if (ra === rb || Math.max(ra, rb) <= 0) {
      b = opAdd(randInt(2, 4 + tier * 2));
      rb = applyOp(b, q);
      if (ra === rb) {
        a = opAdd(randInt(1, 3));
        ra = applyOp(a, q);
      }
    }

    return tintGate(a, b);
  }

  /* 随机左右摆放，并给两侧分配互不相同的磨砂配色（配色只做区分，与好坏无关） */
  function tintGate(a, b) {
    var i = randInt(0, TINTS.length - 1);
    var j = randInt(0, TINTS.length - 2);
    if (j >= i) j += 1;
    a.tint = i;
    b.tint = j;
    if (Math.random() < 0.5) return { left: b, right: a };
    return { left: a, right: b };
  }

  /* ====================== 游戏状态 ====================== */

  /* 飘字反馈色（只用于人数增减提示，与门的配色无关） */
  var COLOR = {
    good: { fill: "rgba(34,196,138,.20)", stroke: "rgba(92,244,186,.80)", text: "#c8ffe9" },
    bad: { fill: "rgba(214,58,92,.20)", stroke: "rgba(255,118,150,.78)", text: "#ffd2dc" },
    flat: { fill: "rgba(120,150,190,.16)", stroke: "rgba(160,196,235,.62)", text: "#dae8ff" }
  };

  /* 磨砂玻璃门配色：只作视觉区分，绝不代表选项好坏（绿色门的算式结果也可能是负数） */
  var TINTS = [
    { top: "rgba(150,205,238,.34)", mid: "rgba(118,172,214,.20)", bot: "rgba(88,138,184,.28)", edge: "rgba(214,240,255,.40)", text: "#f3fbff" },
    { top: "rgba(178,166,238,.34)", mid: "rgba(142,130,206,.20)", bot: "rgba(104,94,170,.28)", edge: "rgba(228,222,255,.38)", text: "#f7f5ff" },
    { top: "rgba(152,226,206,.32)", mid: "rgba(120,190,176,.18)", bot: "rgba(88,152,142,.26)", edge: "rgba(216,255,242,.36)", text: "#f2fffb" },
    { top: "rgba(228,228,238,.32)", mid: "rgba(186,192,208,.18)", bot: "rgba(140,148,166,.26)", edge: "rgba(242,248,255,.40)", text: "#ffffff" }
  ];

  var frostPattern = null;

  /* 生成一次性的磨砂噪点纹理，叠加到门上模拟半透明磨砂玻璃 */
  function frostFill() {
    if (frostPattern !== null) return frostPattern;
    frostPattern = false;
    try {
      var cv = document.createElement("canvas");
      cv.width = 64;
      cv.height = 64;
      var g2 = cv.getContext("2d");
      var img = g2.createImageData(64, 64);
      var i, v;
      for (i = 0; i < img.data.length; i += 4) {
        v = 200 + Math.random() * 55;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = Math.random() < 0.45 ? 0 : Math.round(Math.random() * 96);
      }
      g2.putImageData(img, 0, 0);
      frostPattern = ctx.createPattern(cv, "repeat") || false;
    } catch (err) {
      frostPattern = false;
    }
    return frostPattern;
  }

  var S = {
    mode: "ready",         /* ready / playing / paused / clearing / clear / over */
    level: 1,
    count: 5,
    passed: 0,
    target: 8,
    score: 0,
    gates: [],
    crowd: [],
    floats: [],
    leader: { x: 180 },
    keys: { left: false, right: false },
    drag: null,
    scroll: 0,
    time: 0,
    hitFlash: 0,
    clearTimer: 0
  };

  function gatesForLevel(level) {
    return clamp(CFG.level.gatesBase + (level - 1) * CFG.level.gatesPerLevel, 1, CFG.level.gatesMax);
  }

  function speedForLevel(level) {
    return clamp(CFG.level.speedBase + (level - 1) * CFG.level.speedPerLevel, 20, CFG.level.speedMax);
  }

  function tierForLevel(level) {
    return clamp(1 + Math.floor((level - 1) / Math.max(1, CFG.level.tierPerLevel)), 1, CFG.level.maxTier);
  }

  /* 按当前关卡重建门队列（人数保留，重置进度） */
  function buildLevel() {
    S.gates.length = 0;
    S.passed = 0;
    S.clearTimer = 0;
    S.target = gatesForLevel(S.level);

    var h = gateHeight();
    var spacing = Math.max(h + 30, Math.max(CFG.level.gapMin, H * CFG.level.gapK));
    var v = speedForLevel(S.level);
    var tier = tierForLevel(S.level);
    var startOffset = H * 0.12;
    var q = Math.max(1, S.count);
    var i, gate, pa, pb;

    for (i = 0; i < S.target; i++) {
      gate = makeGate(q, tier);
      gate.h = h;
      gate.y = -h - i * spacing + startOffset;
      gate.vy = v;
      gate.judged = false;
      refreshGate(gate);
      S.gates.push(gate);

      /* 用较优结果估算后一道门的人数，让算式随人数自然变化 */
      pa = applyOp(gate.left, q);
      pb = applyOp(gate.right, q);
      q = clamp(Math.max(pa, pb), 1, CFG.team.countCap);
    }
  }

  function refreshGate(gate) {
    gate.left.res = applyOp(gate.left, S.count);
    gate.right.res = applyOp(gate.right, S.count);
    if (gate.left.tint == null) gate.left.tint = 0;
    if (gate.right.tint == null) gate.right.tint = 1;
  }

  /* 队伍成员（画面上的小人）与人数保持同步 */
  function syncCrowd() {
    var n = clamp(S.count, 0, CFG.team.spriteMax);
    while (S.crowd.length < n) {
      S.crowd.push({ x: S.leader.x, y: geo.groundY });
    }
    while (S.crowd.length > n) S.crowd.pop();
  }

  function syncVip() {
    var inputs = ui.cfgBody.querySelectorAll("[data-path]"), i, el;
    for (i = 0; i < inputs.length; i++) {
      el = inputs[i];
      if (el.getAttribute("data-editing") === "1") continue;
      el.value = getPath(CFG, el.getAttribute("data-path"));
    }
  }

  function updateHud() {
    ui.level.textContent = S.level;
    ui.count.textContent = S.count;
    ui.progress.textContent = S.passed + "/" + S.target;
    ui.score.textContent = S.score;
  }

  function resetGame(level) {
    S.level = level;
    S.count = clamp(CFG.team.startCount, 1, CFG.team.countCap);
    S.score = 0;
    S.floats.length = 0;
    S.crowd.length = 0;
    S.leader.x = W / 2;
    S.scroll = 0;
    S.hitFlash = 0;
    buildLevel();
    syncCrowd();
    updateHud();
  }

  function startGame() {
    ui.start.hidden = true;
    ui.clear.hidden = true;
    ui.over.hidden = true;
    resetGame(1);
    S.mode = "playing";
    ui.pause.textContent = "暂停";
  }

  function nextLevel() {
    ui.clear.hidden = true;
    S.level += 1;
    /* 过关后按比例把人带入下一关，避免人数指数膨胀让高关失去张力 */
    S.count = carryCount();
    buildLevel();
    syncCrowd();
    updateHud();
    S.mode = "playing";
    ui.pause.textContent = "暂停";
  }

  function carryCount() {
    var k = clamp(CFG.level.carryRatio, 20, 100) / 100;
    return clamp(Math.max(1, Math.ceil(S.count * k)), 1, CFG.team.countCap);
  }

  function showClear() {
    if (S.mode !== "clearing") return;
    S.mode = "clear";
    var gain = S.count * CFG.rules.scoreSurvivor + CFG.rules.scoreLevel * S.level;
    S.score += gain;
    updateHud();
    ui.clearLevel.textContent = "第 " + S.level + " 关";
    ui.clearCount.textContent = S.count;
    if (ui.clearCarry) ui.clearCarry.textContent = carryCount();
    ui.clearScore.textContent = "+" + gain;
    ui.clear.hidden = false;
  }

  function gameOver(reason) {
    if (S.mode === "over") return;
    S.mode = "over";
    ui.overTitle.textContent = "本局结束";
    ui.overText.textContent = reason || "人数归零";
    ui.overLevel.textContent = S.level;
    ui.overScore.textContent = S.score;
    ui.over.hidden = false;
    updateHud();
  }

  function togglePause() {
    if (S.mode === "playing") {
      S.mode = "paused";
      ui.pause.textContent = "继续";
    } else if (S.mode === "paused") {
      S.mode = "playing";
      ui.pause.textContent = "暂停";
    }
  }

  /* ====================== 结算：门压到小人高度 ====================== */

  function judge(gate) {
    gate.judged = true;
    var isLeft = S.leader.x < W / 2;
    var op = isLeft ? gate.left : gate.right;
    var before = S.count;
    var after = applyOp(op, S.count);

    S.count = after;
    S.passed += 1;
    S.hitFlash = 0.26;

    var delta = after - before;
    S.floats.push({
      x: clamp(S.leader.x, geo.unit * 2, W - geo.unit * 2),
      y: geo.groundY - geo.unit * 3.2,
      text: (delta >= 0 ? "+" : "-") + Math.abs(delta),
      good: delta >= 0,
      life: 1.1,
      max: 1.1
    });

    syncCrowd();
    updateHud();

    if (S.count <= 0) {
      gameOver("人数归零，队伍全灭");
      return;
    }
    if (S.passed >= S.target) {
      S.mode = "clearing";
      S.clearTimer = CFG.level.clearDelay;
    }
  }

  /* ====================== 更新 ====================== */

  function update(dt) {
    S.time += dt;
    S.scroll += 130 * dt;
    if (S.hitFlash > 0) S.hitFlash = Math.max(0, S.hitFlash - dt);

    if (S.mode === "playing") {
      var dir = (S.keys.right ? 1 : 0) - (S.keys.left ? 1 : 0);
      var sp = clamp(W * CFG.team.moveSpeed, CFG.team.moveMin, CFG.team.moveMax);
      if (dir !== 0) {
        S.leader.x = clamp(S.leader.x + dir * sp * dt, geo.unit, W - geo.unit);
      }
      if (S.drag !== null) {
        S.leader.x = clamp(S.drag, geo.unit, W - geo.unit);
      }
    }

    updateGates(dt);
    updateCrowd(dt);
    updateFloats(dt);

    if (S.mode === "clearing") {
      S.clearTimer -= dt;
      if (S.clearTimer <= 0) showClear();
    }
  }

  function updateGates(dt) {
    var judgeY = geo.groundY - geo.unit * 1.15;
    var i, g;
    for (i = S.gates.length - 1; i >= 0; i--) {
      g = S.gates[i];
      g.y += g.vy * dt;

      if (!g.judged) {
        g.vy = speedForLevel(S.level);
        refreshGate(g);
        if (S.mode === "playing" && g.y + g.h * 0.5 >= judgeY) judge(g);
      }

      if (g.y > H + 6) S.gates.splice(i, 1);
    }
  }

  function updateCrowd(dt) {
    var n = S.crowd.length;
    if (!n) return;
    var u = geo.unit;
    var cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    var k = Math.min(1, dt * 15);
    var i, p, col, row, tx, ty;

    for (i = 0; i < n; i++) {
      col = i % cols;
      row = Math.floor(i / cols);
      tx = S.leader.x + (col - (cols - 1) / 2) * u * 1.25;
      ty = geo.groundY - row * u * 1.45;
      p = S.crowd[i];
      p.x += (clamp(tx, u * 0.7, W - u * 0.7) - p.x) * k;
      p.y += (ty - p.y) * k;
    }
  }

  function updateFloats(dt) {
    for (var i = S.floats.length - 1; i >= 0; i--) {
      S.floats[i].life -= dt;
      if (S.floats[i].life <= 0) S.floats.splice(i, 1);
    }
  }

  /* ====================== 绘制 ====================== */

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawBackdrop() {
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#071120");
    bg.addColorStop(0.55, "#08172a");
    bg.addColorStop(1, "#04090f");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    var step = Math.max(38, Math.round(W / 8));
    var off = (S.scroll * CFG.look.gridSpeed) % step;
    var x, y;

    ctx.strokeStyle = "rgba(110,231,255,.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (x = 0; x <= W + step; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
    }
    for (y = -step + off; y < H + step; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(W, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  function drawGround() {
    var gy = geo.groundY;
    var g = ctx.createLinearGradient(0, gy - 6, 0, H);
    g.addColorStop(0, "rgba(60,200,255,.16)");
    g.addColorStop(1, "rgba(6,12,22,.9)");
    ctx.fillStyle = g;
    ctx.fillRect(0, gy, W, H - gy);

    ctx.strokeStyle = "rgba(110,231,255,.75)";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(110,231,255,.6)";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(W, gy + 0.5);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawGate(g) {
    var top = g.y, h = g.h, mid = W / 2;
    if (top > H + 2 || top + h < -2) return;

    var alpha = g.judged ? 0.46 : 1;
    var fs = clamp(Math.round(h * CFG.look.fontSize), 12, 40);
    var r = Math.min(16, h * 0.26);
    var sides = [g.left, g.right];
    var pat = frostFill();
    var i, op, t, x, w, label, size, gd, hl;

    for (i = 0; i < 2; i++) {
      op = sides[i];
      t = TINTS[(op.tint || 0) % TINTS.length];
      x = i === 0 ? 0 : mid;
      w = i === 0 ? mid : W - mid;

      ctx.save();
      ctx.globalAlpha = alpha;

      /* 半透明玻璃底 */
      roundRect(x, top, w, h, r);
      gd = ctx.createLinearGradient(x, top, x, top + h);
      gd.addColorStop(0, t.top);
      gd.addColorStop(0.55, t.mid);
      gd.addColorStop(1, t.bot);
      ctx.fillStyle = gd;
      ctx.fill();

      /* 磨砂颗粒层 */
      if (pat) {
        ctx.save();
        roundRect(x, top, w, h, r);
        ctx.clip();
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillStyle = pat;
        ctx.fillRect(x, top, w, h);
        ctx.restore();
      }

      /* 顶部高光，做出玻璃厚度感 */
      hl = ctx.createLinearGradient(x, top, x, top + Math.max(8, h * 0.45));
      hl.addColorStop(0, "rgba(255,255,255,.24)");
      hl.addColorStop(1, "rgba(255,255,255,0)");
      roundRect(x + 2, top + 2, w - 4, Math.max(6, h * 0.45), Math.max(3, r * 0.6));
      ctx.fillStyle = hl;
      ctx.fill();

      /* 磨砂边缘 */
      roundRect(x, top, w, h, r);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = t.edge;
      ctx.stroke();

      /* 算式文字：长算式自动缩字号 */
      label = op.label;
      size = fs;
      ctx.font = "800 " + size + "px system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
      if (typeof ctx.measureText === "function") {
        while (size > 11 && ctx.measureText(label).width > w - 20) {
          size -= 1;
          ctx.font = "800 " + size + "px system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
        }
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(4,10,22,.5)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = t.text;
      if (CFG.rules.showResult === "on") {
        ctx.fillText(label, x + w / 2, top + h * 0.38);
        ctx.font = "600 " + Math.round(size * 0.58) + "px system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.8)";
        ctx.fillText("= " + op.res, x + w / 2, top + h * 0.73);
      } else {
        ctx.fillText(label, x + w / 2, top + h * 0.5);
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    /* 中线：门下压时是玩家要「站边」的分界 */
    ctx.save();
    ctx.globalAlpha = g.judged ? 0.34 : 0.92;
    ctx.strokeStyle = "rgba(238,251,255,.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mid, top + 3);
    ctx.lineTo(mid, top + h - 3);
    ctx.stroke();
    ctx.restore();
  }

  function drawPerson(x, footY, index) {
    var u = geo.unit;
    var bodyH = u * 1.5;
    var headR = u * 0.42;
    var bob = Math.sin(S.time * 9 + index * 0.7) * u * 0.13;
    var y = footY + bob;
    var hue = 196 - (index % 6) * 9;
    var legPhase = Math.sin(S.time * 9 + index);

    /* 腿 */
    ctx.strokeStyle = "rgba(190,232,255,.85)";
    ctx.lineWidth = Math.max(1.4, u * 0.17);
    ctx.beginPath();
    ctx.moveTo(x - u * 0.12, y - bodyH * 0.42);
    ctx.lineTo(x - u * 0.12 - legPhase * u * 0.12, y);
    ctx.moveTo(x + u * 0.12, y - bodyH * 0.42);
    ctx.lineTo(x + u * 0.12 + legPhase * u * 0.12, y);
    ctx.stroke();

    /* 身体 */
    ctx.fillStyle = index === 0 ? "#7bf1ff" : "hsl(" + hue + ",78%,58%)";
    roundRect(x - u * 0.28, y - bodyH * 0.82, u * 0.56, bodyH * 0.5, u * 0.2);
    ctx.fill();

    /* 头 */
    ctx.beginPath();
    ctx.arc(x, y - bodyH * 0.9, headR, 0, Math.PI * 2);
    ctx.fillStyle = "hsl(" + (hue + 4) + ",88%,72%)";
    ctx.fill();
  }

  function drawCrowd() {
    var n = S.crowd.length, i;
    for (i = n - 1; i >= 0; i--) {
      drawPerson(S.crowd[i].x, S.crowd[i].y, i);
    }
  }

  function drawFloats() {
    var i, f, k, alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (i = 0; i < S.floats.length; i++) {
      f = S.floats[i];
      k = 1 - f.life / f.max;
      alpha = clamp(f.life / f.max, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = f.good ? "#8dffd0" : "#ff9ab2";
      ctx.font = "800 " + Math.round(geo.unit * 1.5) + "px system-ui, -apple-system, sans-serif";
      ctx.fillText(f.text, f.x, f.y - k * geo.unit * 3.4);
      ctx.globalAlpha = 1;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawBackdrop();
    drawGround();

    for (var i = 0; i < S.gates.length; i++) drawGate(S.gates[i]);

    drawCrowd();
    drawFloats();

    if (S.hitFlash > 0) {
      ctx.fillStyle = "rgba(180,240,255," + (0.09 * S.hitFlash / 0.26).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }

    if (S.mode === "paused") {
      ctx.fillStyle = "rgba(4,8,16,.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#dbe9ff";
      ctx.font = "700 " + Math.round(H * 0.045) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("已暂停", W / 2, H / 2);
    }
  }

  /* ====================== 主循环 ====================== */

  var lastTs = 0;

  function loop(ts) {
    window.requestAnimationFrame(loop);
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.05) dt = 0.05;

    if (S.mode === "playing" || S.mode === "clearing") {
      update(dt);
    } else if (S.mode === "ready" || S.mode === "over" || S.mode === "clear") {
      S.time += dt;
      S.scroll += 40 * dt;
      updateCrowd(dt);
      updateFloats(dt);
    }

    draw();
  }

  /* ====================== 输入 ====================== */

  function bindHold(el, key) {
    function down(e) {
      e.preventDefault();
      S.keys[key] = true;
    }
    function up() {
      S.keys[key] = false;
    }
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }

  bindHold(ui.left, "left");
  bindHold(ui.right, "right");

  window.addEventListener("keydown", function (e) {
    var k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") {
      S.keys.left = true;
      e.preventDefault();
    } else if (k === "ArrowRight" || k === "d" || k === "D") {
      S.keys.right = true;
      e.preventDefault();
    } else if (k === " " || k === "Enter") {
      if (S.mode === "ready") startGame();
      else if (S.mode === "clear") nextLevel();
      else if (S.mode === "over") startGame();
      e.preventDefault();
    } else if (k === "p" || k === "P" || k === "Escape") {
      togglePause();
    }
  });

  window.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") S.keys.left = false;
    if (k === "ArrowRight" || k === "d" || k === "D") S.keys.right = false;
  });

  function stageX(e) {
    var rect = canvas.getBoundingClientRect();
    return (e.clientX - rect.left) * (W / Math.max(1, rect.width));
  }

  canvas.addEventListener("pointerdown", function (e) {
    if (S.mode !== "playing") return;
    S.drag = stageX(e);
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }
  });

  canvas.addEventListener("pointermove", function (e) {
    if (S.drag === null) return;
    S.drag = stageX(e);
  });

  function endDrag() {
    S.drag = null;
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", endDrag);

  ui.startBtn.addEventListener("click", startGame);
  ui.again.addEventListener("click", startGame);
  ui.next.addEventListener("click", nextLevel);
  ui.pause.addEventListener("click", togglePause);
  ui.restart.addEventListener("click", startGame);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && S.mode === "playing") {
      S.mode = "paused";
      ui.pause.textContent = "继续";
    }
  });

  /* ====================== 设置面板 ====================== */

  function buildCfg() {
    var html = [], i, j, group, item, val, k;
    for (i = 0; i < CFG_FIELDS.length; i++) {
      group = CFG_FIELDS[i];
      html.push('<div class="mm-group"><h4>' + group.g + "</h4>");
      for (j = 0; j < group.items.length; j++) {
        item = group.items[j];
        val = getPath(CFG, item.p);
        html.push('<label class="mm-row"><span>' + item.l + "</span>");
        if (item.options) {
          html.push('<select data-path="' + item.p + '">');
          for (k = 0; k < item.options.length; k++) {
            html.push('<option value="' + item.options[k].v + '"' +
              (String(val) === item.options[k].v ? " selected" : "") + ">" + item.options[k].t + "</option>");
          }
          html.push("</select>");
        } else {
          html.push('<input type="number" data-path="' + item.p + '" value="' + val +
            '" min="' + item.min + '" max="' + item.max + '" step="' + item.step + '">');
        }
        html.push("</label>");
      }
      html.push("</div>");
    }
    html.push('<p class="mm-note">改动即时生效，仅作用于当前页面，不写入本地存储；刷新页面恢复默认。' +
      '关卡节奏（门数 / 速度 / 运算档位）从下一关开始按新值计算，当前关已排好的门不变。</p>');
    ui.cfgBody.innerHTML = html.join("");
    bindCfgInputs();
  }

  function bindCfgInputs() {
    var inputs = ui.cfgBody.querySelectorAll("[data-path]"), i, el, changed;

    for (i = 0; i < inputs.length; i++) {
      el = inputs[i];
      changed = function (e) {
        var target = e.currentTarget;
        var path = target.getAttribute("data-path");
        var item = findField(path);

        if (target.tagName === "SELECT") {
          setPath(CFG, path, target.value);
          applyCfg();
          return;
        }

        /* 输入过程中允许中间态（如先删空再打新数字），只在区间内才写进 CFG；失焦时再规范化 */
        var num = parseFloat(target.value);
        if (isNaN(num) || !item) return;
        if (num < item.min || num > item.max) return;
        setPath(CFG, path, item.step >= 1 ? Math.round(num) : num);
        applyCfg();
      };

      el.addEventListener("input", changed);
      el.addEventListener("change", changed);

      el.addEventListener("focus", function (e) {
        e.currentTarget.setAttribute("data-editing", "1");
      });

      el.addEventListener("blur", function (e) {
        var target = e.currentTarget;
        target.removeAttribute("data-editing");
        var path = target.getAttribute("data-path");
        var item = findField(path);
        if (!item) return;
        var num = parseFloat(target.value);
        if (isNaN(num)) num = getPath(DEFAULT_CFG, path);
        num = clamp(num, item.min, item.max);
        if (item.step >= 1) num = Math.round(num);
        setPath(CFG, path, num);
        target.value = num;
        applyCfg();
      });

      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter") e.currentTarget.blur();
      });
    }
  }

  function findField(path) {
    var i, j, g, it;
    for (i = 0; i < CFG_FIELDS.length; i++) {
      g = CFG_FIELDS[i];
      for (j = 0; j < g.items.length; j++) {
        it = g.items[j];
        if (it.p === path) return it;
      }
    }
    return null;
  }

  /* 配置改动后让正在进行的对局立刻按新规则运行 */
  function applyCfg() {
    var i, g;
    for (i = 0; i < S.gates.length; i++) {
      g = S.gates[i];
      if (!g.judged) g.vy = speedForLevel(S.level);
    }
    S.count = clamp(S.count, 0, CFG.team.countCap);
    syncCrowd();
    updateHud();
  }

  function openCfg() {
    buildCfg();
    ui.cfg.hidden = false;
    syncVip();
  }

  function closeCfg() {
    ui.cfg.hidden = true;
  }

  ui.cfgOpen.addEventListener("click", openCfg);
  ui.cfgClose.addEventListener("click", closeCfg);
  ui.cfgOk.addEventListener("click", closeCfg);
  ui.cfgMask.addEventListener("click", closeCfg);
  ui.cfgReset.addEventListener("click", function () {
    CFG = deepClone(DEFAULT_CFG);
    buildCfg();
    applyCfg();
  });

  /* ====================== 启动 ====================== */

  resize();
  resetGame(1);
  S.mode = "ready";
  syncCrowd();
  updateHud();
  buildCfg();

  window.addEventListener("resize", resize);
  if (window.ResizeObserver) {
    try {
      new window.ResizeObserver(resize).observe(ui.stage);
    } catch (err) { /* 老浏览器忽略 */ }
  }

  window.requestAnimationFrame(loop);
})();
