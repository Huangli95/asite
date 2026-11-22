/* ==========================================================================
   弹球打砖（Bounce Bricks）· 小游戏板块
   --------------------------------------------------------------------------
   玩法：
   1. 底部发射器可左右移动、可旋转角度，点「发射」按当前位置与角度打出小球；
   2. 下落模式可切换：持续下落（随时间不断下移）/ 逐行下降（发射一轮结算一次，按轮次下移）；
      持续下落时小球撞到方块会暂停下落（CFG.feel.fallPause，累积上限 CFG.feel.fallPauseMax），
      球还困在方块阵内时下落也会按 CFG.feel.slowFactor 放缓，避免球没落下来阵就先压到底线；
      逐行下降的下移节奏随已下降行数加快 —— 前 3 行每 3 轮下一行、接着 2 行每 2 轮下一行、之后每轮下一行；
   3. 逐行下降可开「补行」：每下移一行就在最上层补出一行新方块，不必等上一阵全部打通才刷新；
   每一行（含每波刷新的各行）的方块数都不超过该行可容纳列数的 60%，其余位置随机留空；
   4. 方块上的数字是命中次数（随波次与已下降行数递增，封顶 20），+1 方块直接给小球数 +1，
      开局默认 3 颗球；
   5. 小球在左右边界、顶部与方块之间弹射，落到回收线以下即被收回；
   6. 方块触到回收线 → 扣 1 生命，生命耗尽本局结束；
   7. 小球长时间贴着水平方向来回弹（几乎不上不下）时，会在它前方的必经之路上出现一个
      引导圆点，撞上即以 46° 以上的角度弹出、圆点随即消失，防止卡在同一水平线上死循环。
   布局：方块为正方面，边长由「一屏 12 层」的层距与屏宽共同反推，一行可排 6-12 列。
   实现：单 canvas + requestAnimationFrame，固定列宽网格，圆-矩形碰撞 + 子步防穿透。
   ========================================================================== */
(function () {
  "use strict";

  var canvas = document.getElementById("gb-canvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  var ui = {
    stage: document.getElementById("gb-stage"),
    balls: document.getElementById("gb-balls"),
    wave: document.getElementById("gb-wave"),
    remain: document.getElementById("gb-remain"),
    lives: document.getElementById("gb-lives"),
    score: document.getElementById("gb-score"),
    fire: document.getElementById("gb-fire"),
    restart: document.getElementById("gb-restart"),
    again: document.getElementById("gb-again"),
    over: document.getElementById("gb-over"),
    overReason: document.getElementById("gb-over-reason"),
    overScore: document.getElementById("gb-over-score"),
    overWave: document.getElementById("gb-over-wave"),
    tip: document.getElementById("gb-tip"),
    modes: document.getElementById("gb-modes"),
    modeDrop: document.getElementById("gb-mode-drop"),
    modeRow: document.getElementById("gb-mode-row"),
    refill: document.getElementById("gb-refill"),
    modeHint: document.getElementById("gb-mode-hint"),
  cfgOpen: document.getElementById("gb-cfg-open")
  };

  /* ====================== 可配置项（默认配置） ======================
     这里就是「默认配置」：页面每次打开都按它初始化 CFG。
     游戏运行期间所有判断都读 CFG（不再读死值），前端「设置」弹窗改的也是 CFG，
     因此改完立刻生效；配置不写入 localStorage，刷新页面即恢复本默认配置。 */
  var DEFAULT_CFG = {
    ball: {
      startBalls: 3,        /* 开局可发射球数 */
      startLives: 3,        /* 开局生命数 */
      speedK: 1.75,         /* 球速 = 画布宽 * speedK，再夹到 min/max */
      speedMin: 420, speedMax: 780,
      moveK: 1.45,          /* 发射器移动速度 = 画布宽 * moveK，再夹到 min/max */
      moveMin: 320, moveMax: 620,
      rotSpeed: 1.15,       /* 角度调整速度（弧度/秒） */
      angleLimitDeg: 78,    /* 发射角度上限（度，左右各限） */
      aimAngle: -0.16,      /* 开局发射角度（弧度） */
      spreadStepDeg: 5.2,   /* 多发球之间的夹角（度） */
      spreadMax: 9,         /* 最多按几份夹角散开 */
      pointerLen: 44,       /* 炮口长度（决定出手点） */
      radiusDiv: 64,        /* 球半径 = 画布宽 / radiusDiv */
      radiusMin: 4.5, radiusMax: 7.5
    },
    board: {
      visibleRows: 12,      /* 一屏容纳的方块层数（决定行距/方块大小） */
      rowFillMax: 0.6,      /* 单行方块数上限 = 列数 * rowFillMax */
      rowMinBlocks: 2,      /* 单行最少方块数 */
      rowCapSlack: 2,       /* 实际数量最多比上限少几块 */
      colsMin: 6, colsMax: 12, colsPad: 8, leftPad: 6,
      cellMin: 16, cellMax: 64, cellWidthDiv: 9.5,
      gapRatio: 0.012, gapMin: 3, gapMax: 6,
      rowGapMin: 2, rowGapMax: 48,
      topPad: 8,            /* 阵顶位置 / 入场动画终点 */
      lineYOffset: 50,      /* 回收线距底部距离 */
      baseYOffset: 30,      /* 发射器基准高度距底部距离 */
      enterSpeed: 170       /* 新波次入场下滑速度 */
    },
    wave: {
      maxRows: 5,           /* 一次波次最多刷几行 */
      rowsBase: 2,          /* 波次行数 = rowsBase + (n-1)/rowsPerStep */
      rowsPerStep: 2,
      spawnDelay: 0.5,      /* 清屏后到下一波的间隔 */
      fallBase: 9,          /* 持续下落基础速度 */
      fallPerWave: 2,       /* 每波叠加速度 */
      fallMax: 30
    },
    bonus: {
      fromWave: 3,          /* 从第几波开始给 2 个加球块 */
      countEarly: 1, countLate: 2,
      rateSpawn: 0.14,      /* 新波次里每个方块变加球块的概率 */
      rateRefill: 0.2,      /* 补行时本次是否产出一个加球块 */
      refillPick: 0.25      /* 补行里具体某个方块被选中的概率 */
    },
    score: { hit: 5, kill: 12, bonus: 20, blastPerBlock: 12 },
    difficulty: {
      descStep: 3,          /* 每下降几行 +1 难度 */
      shotsStep: 8,         /* 每发射几轮 +1 难度 */
      hpSlope: 0.69,        /* 血量上限随难度增速 */
      hpCap: 100,           /* 血量上限封顶（配色最深一档到 100 点血，再高颜色固定） */
      colorStep: 5,         /* 配色档：每多少点血量把方块颜色加深一档 */
      hpRollDown: 5         /* 新块血量最多下浮几级 */
    },
    feel: {
      fallPause: 0.14,      /* 撞到方块暂停下落时长（秒） */
      fallPauseMax: 3,      /* 连续撞击累积暂停上限 */
      slowFactor: 0.3,      /* 球在阵内时下落减速系数 */
      shakeHit: 1.6, shakeHitMax: 6,
      shakeBlast: 2.4, shakeBlastMax: 8,
      shakeLeak: 7, shakeOver: 8
    },
    pace: {
      earlyCount: 3, roundsEarly: 3,   /* 前 N 行：每几次发射下降一行 */
      midCount: 5, roundsMid: 2,
      roundsLate: 1
    },
    flat: {
      ratio: 0.16,          /* |vy|/speed 低于此值算横飞 */
      hold: 3,              /* 横飞多久后放引导点 */
      dotR: 7, dotDist: 52, dotLife: 2.6,
      kickDeg: 46           /* 撞引导点后的最小偏转角 */
    },
    special: {
      chance: 0.69,         /* 每行出特效方块的概率 */
      minHp: 9,             /* 需要行内存在血量 >= 该值的方块才掷概率 */
      perRowMin: 0, perRowMax: 1
    },
    fx: {
      trailMode: "auto",    /* 球拖尾：auto = 每次打开页面随机一种，可选 water/particle/star/comet/none */
      trailLen: 14,         /* 拖尾采样点数（越大尾巴越长） */
      sparkDrag: 0.94, sparkGravity: 240,
      floaterRise: 34, shakeDecay: 34
    }
  };

  function cloneCfg(o) { return JSON.parse(JSON.stringify(o)); }

  /* 只覆盖已存在的键、且类型一致，防止外部乱传把结构打乱 */
  function mergeCfg(dst, src) {
    if (!src || typeof src !== "object") return dst;
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (!Object.prototype.hasOwnProperty.call(dst, k)) continue;
      if (dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) mergeCfg(dst[k], src[k]);
      else if (typeof src[k] === typeof dst[k]) dst[k] = src[k];
    }
    return dst;
  }

  /* 构建标记：配置面板标题会显示它，用来一眼分辨浏览器跑的是不是旧脚本。
     每次改默认配置都要同时改这里和页面引用的 ?v=，两者保持一致。 */
  var BUILD = "20261118b";
  if (typeof window !== "undefined") window.__gbBuild = BUILD;

  /* 清理历史遗留的配置存储键：早期版本曾把配置写进 localStorage，
     残留键会被当成「旧配置」。本游戏面板本身不写任何存储，这里只是把旧键彻底清掉。 */
  function purgeLegacyCfgStorage() {
    if (typeof window === "undefined" || !window.localStorage) return;
    var legacy = ["gb-config", "gb-config-v1", "gb-cfg", "gb-cfg-v1", "gb-cfg-config",
                  "game-bounce-config", "game-bounce-cfg", "bounce-config", "bounce-cfg"];
    for (var i = 0; i < legacy.length; i++) {
      try {
        if (window.localStorage.getItem(legacy[i]) !== null) window.localStorage.removeItem(legacy[i]);
      } catch (err) {}
    }
  }
  purgeLegacyCfgStorage();

  var CFG = cloneCfg(DEFAULT_CFG);
  /* 外部覆盖钩子必须带同一 BUILD 才生效：否则旧页面 / 旧快照注入的旧值会把新默认值顶掉 */
  if (typeof window !== "undefined" && window.GB_CONFIG) {
    if (window.GB_CONFIG_BUILD === BUILD) mergeCfg(CFG, window.GB_CONFIG);
    else {
      if (window.console && console.warn) console.warn("[game-bounce] 已忽略过期的 GB_CONFIG（缺少匹配的 GB_CONFIG_BUILD=" + BUILD + "）");
      window.GB_CONFIG = null;
    }
  }
  /* 启动快照：本次页面打开时的最终生效配置。打开设置面板时以它为准回锚，
     保证「打开面板」只读不写，永远不会把旧值 / 外部篡改值显示出来。 */
  var BOOT_CFG = cloneCfg(CFG);
  /* 本局是否在面板里手动改过配置：只有真改过才允许偏离启动快照 */
  var cfgDirty = false;

  /* 配置项元信息：弹窗表单就是按它自动生成的（path → 中文名/范围/单位） */
  var CFG_FIELDS = [
    { g: "基础 · 球与生命", items: [
      { p: "ball.startBalls", l: "开局球数", min: 1, max: 20, step: 1 },
      { p: "ball.startLives", l: "开局生命", min: 1, max: 20, step: 1 },
      { p: "ball.speedK", l: "球速系数（×画布宽）", min: 0.5, max: 4, step: 0.05 },
      { p: "ball.speedMin", l: "球速下限", min: 100, max: 1200, step: 10 },
      { p: "ball.speedMax", l: "球速上限", min: 200, max: 1800, step: 10 },
      { p: "ball.moveK", l: "移动速度系数（×画布宽）", min: 0.2, max: 4, step: 0.05 },
      { p: "ball.moveMin", l: "移动速度下限", min: 60, max: 1200, step: 10 },
      { p: "ball.moveMax", l: "移动速度上限", min: 100, max: 1500, step: 10 },
      { p: "ball.rotSpeed", l: "调角速度（弧度/秒）", min: 0.1, max: 4, step: 0.05 },
      { p: "ball.angleLimitDeg", l: "发射角上限（度）", min: 10, max: 89, step: 1 },
      { p: "ball.aimAngle", l: "开局发射角（弧度）", min: -1.2, max: 1.2, step: 0.01 },
      { p: "ball.spreadStepDeg", l: "多球夹角（度）", min: 0, max: 20, step: 0.1 },
      { p: "ball.spreadMax", l: "散开份数上限", min: 1, max: 20, step: 1 },
      { p: "ball.pointerLen", l: "炮口长度", min: 10, max: 90, step: 1 },
      { p: "ball.radiusDiv", l: "球半径 = 宽 / 该值", min: 20, max: 200, step: 1 },
      { p: "ball.radiusMin", l: "球半径下限", min: 2, max: 12, step: 0.5 },
      { p: "ball.radiusMax", l: "球半径上限", min: 3, max: 20, step: 0.5 }
    ]},
    { g: "棋盘 · 方块布局", items: [
      { p: "board.visibleRows", l: "一屏层数", min: 4, max: 20, step: 1 },
      { p: "board.rowFillMax", l: "单行填充率（×列数）", min: 0.1, max: 1, step: 0.05 },
      { p: "board.rowMinBlocks", l: "单行最少方块", min: 1, max: 8, step: 1 },
      { p: "board.rowCapSlack", l: "实际数比上限少几块", min: 0, max: 6, step: 1 },
      { p: "board.colsMin", l: "最少列数", min: 3, max: 16, step: 1 },
      { p: "board.colsMax", l: "最多列数", min: 4, max: 24, step: 1 },
      { p: "board.cellWidthDiv", l: "方块最大宽 = 宽 / 该值", min: 4, max: 20, step: 0.5 },
      { p: "board.cellMin", l: "方块最小边长", min: 8, max: 40, step: 1 },
      { p: "board.cellMax", l: "方块最大边长", min: 20, max: 96, step: 1 },
      { p: "board.gapRatio", l: "列间距比例（×画布宽）", min: 0, max: 0.06, step: 0.001 },
      { p: "board.gapMin", l: "列间距下限", min: 0, max: 20, step: 1 },
      { p: "board.gapMax", l: "列间距上限", min: 1, max: 30, step: 1 },
      { p: "board.colsPad", l: "列数反推留白", min: 0, max: 40, step: 1 },
      { p: "board.leftPad", l: "阵左最小边距", min: 0, max: 40, step: 1 },
      { p: "board.topPad", l: "阵顶位置", min: 0, max: 60, step: 1 },
      { p: "board.lineYOffset", l: "回收线离底距离", min: 40, max: 200, step: 1 },
      { p: "board.baseYOffset", l: "发射器离底距离", min: 30, max: 160, step: 1 },
      { p: "board.rowGapMin", l: "行间距下限", min: 0, max: 30, step: 1 },
      { p: "board.rowGapMax", l: "行间距上限", min: 2, max: 80, step: 1 },
      { p: "board.enterSpeed", l: "波次入场速度", min: 30, max: 600, step: 10 }
    ]},
    { g: "波次 · 节奏与下落", items: [
      { p: "wave.maxRows", l: "一波最多刷几行", min: 1, max: 8, step: 1 },
      { p: "wave.rowsBase", l: "首波行数基数", min: 1, max: 6, step: 1 },
      { p: "wave.rowsPerStep", l: "每几波多一行", min: 1, max: 6, step: 1 },
      { p: "wave.spawnDelay", l: "清屏后补波间隔（秒）", min: 0, max: 3, step: 0.1 },
      { p: "wave.fallBase", l: "下落基础速度", min: 1, max: 40, step: 1 },
      { p: "wave.fallPerWave", l: "每波加速", min: 0, max: 10, step: 0.5 },
      { p: "wave.fallMax", l: "下落速度上限", min: 5, max: 80, step: 1 },
      { p: "pace.earlyCount", l: "前几行走慢节奏", min: 0, max: 10, step: 1 },
      { p: "pace.roundsEarly", l: "慢节奏每几轮降一行", min: 1, max: 8, step: 1 },
      { p: "pace.midCount", l: "中段到第几行", min: 0, max: 15, step: 1 },
      { p: "pace.roundsMid", l: "中段每几轮降一行", min: 1, max: 8, step: 1 },
      { p: "pace.roundsLate", l: "后段每几轮降一行", min: 1, max: 8, step: 1 }
    ]},
    { g: "难度 · 方块血量", items: [
      { p: "difficulty.descStep", l: "每降几行 +1 难度", min: 1, max: 10, step: 1 },
      { p: "difficulty.shotsStep", l: "每几轮发射 +1 难度", min: 1, max: 20, step: 1 },
      { p: "difficulty.hpSlope", l: "血量增速", min: 0, max: 1.5, step: 0.05 },
      { p: "difficulty.hpCap", l: "血量封顶（配色最深到该值）", min: 5, max: 100, step: 1 },
      { p: "difficulty.colorStep", l: "配色档（每几点血加深一档）", min: 1, max: 25, step: 1 },
      { p: "difficulty.hpRollDown", l: "血量最多下浮", min: 0, max: 20, step: 1 }
    ]},
    { g: "手感 · 撞击与横飞", items: [
      { p: "feel.fallPause", l: "撞块暂停下落（秒）", min: 0, max: 1, step: 0.01 },
      { p: "feel.fallPauseMax", l: "暂停累积上限（秒）", min: 0, max: 3, step: 0.05 },
      { p: "feel.slowFactor", l: "阵内下落减速系数", min: 0, max: 1, step: 0.05 },
      { p: "feel.shakeHit", l: "撞块震屏", min: 0, max: 12, step: 0.2 },
      { p: "feel.shakeHitMax", l: "撞块震屏上限", min: 0, max: 24, step: 0.5 },
      { p: "feel.shakeBlast", l: "特效震屏", min: 0, max: 16, step: 0.2 },
      { p: "feel.shakeBlastMax", l: "特效震屏上限", min: 0, max: 24, step: 0.5 },
      { p: "feel.shakeLeak", l: "漏球震屏", min: 0, max: 24, step: 0.5 },
      { p: "feel.shakeOver", l: "结束震屏", min: 0, max: 24, step: 0.5 },
      { p: "flat.ratio", l: "横飞判定阈值", min: 0, max: 0.9, step: 0.01 },
      { p: "flat.hold", l: "横飞多久放引导点（秒）", min: 0.05, max: 5, step: 0.05 },
      { p: "flat.dotR", l: "引导点半径", min: 2, max: 24, step: 1 },
      { p: "flat.dotDist", l: "引导点距离", min: 10, max: 160, step: 2 },
      { p: "flat.dotLife", l: "引导点存活（秒）", min: 0.3, max: 10, step: 0.1 },
      { p: "flat.kickDeg", l: "偏转角（度）", min: 5, max: 89, step: 1 }
    ]},
    { g: "特效 · 加球块与消除", items: [
      { p: "special.chance", l: "每行出特效概率", min: 0, max: 1, step: 0.05 },
      { p: "special.minHp", l: "触发门槛血量", min: 1, max: 40, step: 1 },
      { p: "special.perRowMin", l: "每行特效数下限", min: 0, max: 5, step: 1 },
      { p: "special.perRowMax", l: "每行特效数上限", min: 0, max: 5, step: 1 },
      { p: "bonus.fromWave", l: "第几波起给更多加球块", min: 1, max: 20, step: 1 },
      { p: "bonus.countEarly", l: "前期加球块数量", min: 1, max: 6, step: 1 },
      { p: "bonus.countLate", l: "后期加球块数量", min: 1, max: 8, step: 1 },
      { p: "bonus.rateSpawn", l: "新波次加球块概率", min: 0, max: 1, step: 0.01 },
      { p: "bonus.rateRefill", l: "补行产出加球块概率", min: 0, max: 1, step: 0.01 },
      { p: "bonus.refillPick", l: "补行抽空位比例", min: 0, max: 1, step: 0.01 },
      { p: "score.hit", l: "命中得分", min: 0, max: 100, step: 1 },
      { p: "score.kill", l: "击碎得分", min: 0, max: 200, step: 1 },
      { p: "score.bonus", l: "加球块得分", min: 0, max: 200, step: 1 },
      { p: "score.blastPerBlock", l: "特效每清一块得分", min: 0, max: 200, step: 1 }
    ]},
    { g: "特效 · 粒子表现", items: [
      { p: "fx.trailMode", l: "球拖尾效果", type: "enum", options: [
        { v: "auto", l: "随机（每次打开换一种）" },
        { v: "water", l: "水流" },
        { v: "particle", l: "粒子" },
        { v: "star", l: "星星" },
        { v: "comet", l: "霓虹彗星" },
        { v: "none", l: "关闭拖尾" }
      ] },
      { p: "fx.trailLen", l: "拖尾采样点数", min: 0, max: 30, step: 1 },
      { p: "fx.sparkDrag", l: "火花阻尼", min: 0.5, max: 1, step: 0.01 },
      { p: "fx.sparkGravity", l: "火花重力", min: 0, max: 800, step: 10 },
      { p: "fx.floaterRise", l: "飘字上升速度", min: 0, max: 120, step: 2 },
      { p: "fx.shakeDecay", l: "震屏衰减速度", min: 1, max: 120, step: 1 }
    ]}
  ];

  function cfgGet(path) {
    var parts = path.split("."), cur = CFG;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /* 按 path 取字段定义（含 min / max / step），用于手输校验 */
  function cfgFieldOf(path) {
    for (var i = 0; i < CFG_FIELDS.length; i++) {
      var items = CFG_FIELDS[i].items;
      for (var j = 0; j < items.length; j++) if (items[j].p === path) return items[j];
    }
    return null;
  }

  function cfgSet(path, val) {
    var parts = path.split("."), cur = CFG;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) return false;
      cur = cur[parts[i]];
    }
    var f = cfgFieldOf(path);
    if (f && f.type === "enum") {
      var ok = false;
      for (var k = 0; k < f.options.length; k++) if (f.options[k].v === val) ok = true;
      if (!ok) return false;                        /* 枚举项只接受选项里的值 */
    } else if (f) {
      if (!isFinite(val)) return false;
      val = Math.min(f.max, Math.max(f.min, val));   /* 手输越界一律夹到范围内 */
    }
    cur[parts[parts.length - 1]] = val;
    cfgDirty = true;
    return true;
  }

  function angleLimit() { return CFG.ball.angleLimitDeg * Math.PI / 180; }

  /* --------------------------- 配置弹窗 ---------------------------
     表单由 CFG_FIELDS 自动生成：改一个值 → 写回 CFG → 立刻按新值运行。
     仅内存生效，不写 localStorage，刷新页面即回到 DEFAULT_CFG。 */
  var cfgOpenFlag = false;

  function cfgPanelEl() { return document.getElementById("gb-cfg"); }

  function cfgBuildForm() {
    var panel = cfgPanelEl();
    if (!panel) return;
    /* 只有同一构建且已建过的表单才复用；构建变了就整体重建，避免残留旧 DOM / 旧值 */
    if (panel.getAttribute("data-built") === "1" && panel.getAttribute("data-build") === BUILD) return;
    var html = "";
    html += '<div class="gbf-mask" data-gbf-close="1"></div>';
    html += '<div class="gbf-card" role="dialog" aria-modal="true" aria-label="游戏配置">';
    html += '<div class="gbf-head"><b>配置</b><i>改动立即生效 · 刷新页面恢复默认 · build ' + BUILD + '</i>';
    html += '<button class="gbf-x" type="button" data-gbf-close="1" aria-label="关闭">×</button></div>';
    html += '<div class="gbf-body">';
    for (var i = 0; i < CFG_FIELDS.length; i++) {
      var group = CFG_FIELDS[i];
      html += '<div class="gbf-group"><h4>' + group.g + '</h4>';
      for (var j = 0; j < group.items.length; j++) {
        var f = group.items[j];
        html += '<label class="gbf-row"><span>' + f.l + '</span>';
        if (f.type === "enum") {
          var cur = String(cfgGet(f.p));
          html += '<select data-path="' + f.p + '">';
          for (var e = 0; e < f.options.length; e++) {
            var op = f.options[e];
            html += '<option value="' + op.v + '"' + (cur === op.v ? " selected" : "") + '>' + op.l + '</option>';
          }
          html += '</select></label>';
          continue;
        }
        html += '<input type="number" inputmode="decimal" data-path="' + f.p + '" value="' + cfgGet(f.p) +
                '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '"></label>';
      }
      html += '</div>';
    }
    html += '<p class="gbf-note">开局球数 / 生命只在「重开」后生效，其余项改完立刻生效。</p>';
    html += '</div>';
    html += '<div class="gbf-foot">';
    html += '<button class="gbf-btn" type="button" id="gb-cfg-reset">恢复默认</button>';
    html += '<button class="gbf-btn gbf-btn--main" type="button" data-gbf-close="1">完成</button>';
    html += '</div></div>';
    panel.innerHTML = html;
    panel.setAttribute("data-built", "1");
    panel.setAttribute("data-build", BUILD);
    /* 事件只绑一次：重建表单时不能重复绑定，否则一次输入会触发多次写回 */
    if (panel.getAttribute("data-bound") === "1") return;
    panel.setAttribute("data-bound", "1");

    panel.addEventListener("input", function (e) {
      var el = e.target;
      if (!el || el.tagName !== "INPUT" || !el.getAttribute) return;
      var path = el.getAttribute("data-path");
      if (!path) return;
      /* 打上「正在编辑」标记：cfgSyncInputs 会跳过它，否则输入中途会被回写打断 */
      el.setAttribute("data-editing", "1");
      var f = cfgFieldOf(path);
      var raw = parseFloat(el.value);
      /* 空值或非法中间态（""、"-"、"1e" 等）：先不动 CFG，等失焦/回车再规范化 */
      if (!isFinite(raw)) return;
      /* 越界中间态（例如把 200 改成 60 途中的 "6"）：不夹取也不写回，同样留到失焦时处理 */
      if (f && (raw < f.min || raw > f.max)) return;
      if (cfgSet(path, raw)) applyCfg(path);
    });
    /* 回车等于确认：触发失焦，交给 focusout 统一规范化 */
    panel.addEventListener("keydown", function (e) {
      var el = e.target;
      if (!el || el.tagName !== "INPUT") return;
      if (e.key === "Enter" || e.keyCode === 13) {
        if (el.blur) el.blur();
        if (e.preventDefault) e.preventDefault();
      }
    });
    /* 失焦/回车时才规范化：空值回填当前 CFG 值，越界夹到 min~max */
    panel.addEventListener("focusout", function (e) {
      var el = e.target;
      if (!el || el.tagName !== "INPUT" || !el.getAttribute) return;
      var path = el.getAttribute("data-path");
      if (!path) return;
      el.removeAttribute("data-editing");
      var raw = parseFloat(el.value);
      if (isFinite(raw)) cfgSet(path, raw);   /* cfgSet 内部按 min/max 夹取 */
      cfgSyncInputs();                        /* 统一把框内文字回正为最终生效值 */
      if (isFinite(raw)) applyCfg(path);
    });
    panel.addEventListener("change", function (e) {
      var el = e.target;
      if (!el || el.tagName !== "SELECT" || !el.getAttribute) return;
      var path = el.getAttribute("data-path");
      if (!path) return;
      cfgSet(path, el.value);
      applyCfg(path);
    });
    panel.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.id === "gb-cfg-reset") { resetCfg(); return; }
      if (t.getAttribute("data-gbf-close") === "1") closeCfg();
    });
  }

  /* 配置写回后让新值立即作用于当前局 */
  function applyCfg(path) {
    if (CFG.special.perRowMin > CFG.special.perRowMax) CFG.special.perRowMin = CFG.special.perRowMax;
    if (CFG.ball.radiusMin > CFG.ball.radiusMax) CFG.ball.radiusMin = CFG.ball.radiusMax;
    if (CFG.ball.speedMin > CFG.ball.speedMax) CFG.ball.speedMin = CFG.ball.speedMax;
    if (CFG.board.colsMin > CFG.board.colsMax) CFG.board.colsMin = CFG.board.colsMax;
    if (path === "fx.trailMode") refreshTrailMode();
    if (CFG.pace.earlyCount > CFG.pace.midCount) CFG.pace.midCount = CFG.pace.earlyCount;
    syncTipText();
    if (ui.modeHint) ui.modeHint.textContent = modeHintText();
    grid.top0 = CFG.board.topPad;
    if (!grid.entering) grid.top = CFG.board.topPad;
    resize();            /* 布局/尺寸类改动立刻重算 */
    relocateBlocks();
    syncHud();
    if (path) cfgSyncInputs();
  }

  function cfgSyncInputs() {
    var panel = cfgPanelEl();
    if (!panel) return;
    var els = panel.querySelectorAll("input[data-path], select[data-path]");
    for (var i = 0; i < els.length; i++) {
      /* 正在编辑的输入框不回写：否则用户刚敲的数字会被 CFG 旧值覆盖 */
      if (els[i].getAttribute("data-editing") === "1") continue;
      var key = els[i].getAttribute("data-path");
      var v = cfgGet(key);
      if (String(els[i].value) !== String(v)) els[i].value = v;
    }
  }

  /* 清掉所有输入框的「正在编辑」标记（打开面板 / 恢复默认时用） */
  function cfgClearEditing() {
    var panel = cfgPanelEl();
    if (!panel) return;
    var els = panel.querySelectorAll("input[data-editing]");
    for (var i = 0; i < els.length; i++) els[i].removeAttribute("data-editing");
  }

  function resetCfg() {
    var def = cloneCfg(DEFAULT_CFG);
    mergeCfg(CFG, def);
    cfgDirty = false;
    cfgClearEditing();
    cfgSyncInputs();
    applyCfg();
  }

  function openCfg() {
    var panel = cfgPanelEl();
    if (!panel) return;
    cfgBuildForm();
    /* 打开面板是只读动作，绝不把任何旧值写回 CFG。
       若本次打开后还没在面板里改过配置，就把 CFG 回锚到启动快照，
       即便有外部脚本或旧缓存把 CFG 改成了旧值，一开面板也会立刻纠正。 */
    if (!cfgDirty) {
      var beforeOpen = JSON.stringify(CFG);
      mergeCfg(CFG, cloneCfg(BOOT_CFG));
      if (JSON.stringify(CFG) !== beforeOpen) applyCfg();
    }
    cfgClearEditing();
    cfgSyncInputs();
    panel.hidden = false;
    cfgOpenFlag = true;
    input.left = false; input.right = false; input.rotLeft = false; input.rotRight = false;
    if (ui.cfgOpen) ui.cfgOpen.classList.add("is-on");
  }

  function closeCfg() {
    var panel = cfgPanelEl();
    if (panel) panel.hidden = true;
    cfgOpenFlag = false;
    if (ui.cfgOpen) ui.cfgOpen.classList.remove("is-on");
    hideTip();
  }

  var TAU = Math.PI * 2;
  var RING_TIME = 0.34;
  var FLASH_TIME = 0.2;

/* 随机消除特效配置：直接引用 CFG.special（默认值见文件头部 DEFAULT_CFG） */
var SPECIAL_CFG = CFG.special;

/* 特效类型：上下左右各一格 / 周围 8 格 / 整行 / 整列 / 所在行列 */
var BLAST_KINDS = ["cross1", "around8", "row", "col", "crossFull"];
var BLAST_META = {
  cross1:    { icon: "✛", label: "上下左右各一格", color: "#7ef0ff", fill: "rgba(126,240,255,.26)", line: "rgba(126,240,255,.98)", text: "#c9f9ff" },
  around8:   { icon: "❋", label: "周围 8 格", color: "#ffd166", fill: "rgba(255,209,102,.26)", line: "rgba(255,209,102,.98)", text: "#fff0c2" },
  row:       { icon: "⇔", label: "整行", color: "#ff8fb1", fill: "rgba(255,143,177,.26)", line: "rgba(255,143,177,.98)", text: "#ffd6e2" },
  col:       { icon: "⇕", label: "整列", color: "#b48cff", fill: "rgba(180,140,255,.28)", line: "rgba(180,140,255,.98)", text: "#e0d0ff" },
  crossFull: { icon: "✥", label: "所在行列", color: "#8effc0", fill: "rgba(142,255,192,.24)", line: "rgba(142,255,192,.98)", text: "#d4ffe8" }
};

/* 允许外部在加载前覆盖特效配置 */
if (typeof window !== "undefined" && window.GB_SPECIAL_CFG) {
  if (window.GB_SPECIAL_CFG_BUILD === BUILD) mergeCfg(SPECIAL_CFG, window.GB_SPECIAL_CFG);
  else window.GB_SPECIAL_CFG = null;
}

/* 波次刷新配置：直接引用 CFG.wave */
var WAVE_CFG = CFG.wave;

/* 允许外部在加载前覆盖波次配置 */
if (typeof window !== "undefined" && window.GB_WAVE_CFG) {
  if (window.GB_WAVE_CFG_BUILD === BUILD) mergeCfg(WAVE_CFG, window.GB_WAVE_CFG);
  else window.GB_WAVE_CFG = null;
}

  var W = 360, H = 560, DPR = 1;

  /* 方块配色：血量越高颜色越"烫"，按 CFG.difficulty.colorStep 点一档，
     血量到 CFG.difficulty.hpCap（默认 100）封顶，再高也只固定最深一色。
     色带依次走过 青绿 → 黄绿 → 亮黄 → 橙 → 橙红 → 玫红 → 紫 → 蓝紫，
     取色按"色带弧长等距"而非参数等距，保证任意相邻两档色差一致且肉眼可辨 */
  var HP_PALETTE = [
    { t: 0.00, c: [ 74, 246, 190] },
    { t: 0.12, c: [130, 244, 150] },
    { t: 0.24, c: [196, 240,  96] },
    { t: 0.34, c: [255, 236,  74] },
    { t: 0.44, c: [255, 204,  52] },
    { t: 0.54, c: [255, 160,  48] },
    { t: 0.63, c: [255, 112,  60] },
    { t: 0.72, c: [240,  64,  96] },
    { t: 0.81, c: [206,  44, 132] },
    { t: 0.90, c: [156,  40, 168] },
    { t: 1.00, c: [ 96,  36, 178] }
  ];
  var HP_RGB_LOW = { r: 74, g: 246, b: 190 };    /* 1 点血：亮青绿 */
  var HP_RGB_HIGH = { r: 96, g: 36, b: 178 };    /* 满血量：深蓝紫 */

  /* 色带按参数 t（0~1）线性插值 */
  function hpRampAt(t) {
    t = clamp(t, 0, 1);
    var i, a = HP_PALETTE[0], b = HP_PALETTE[HP_PALETTE.length - 1];
    for (i = 0; i < HP_PALETTE.length - 1; i++) {
      if (t <= HP_PALETTE[i + 1].t) { a = HP_PALETTE[i]; b = HP_PALETTE[i + 1]; break; }
    }
    var span = b.t - a.t;
    var f = span < 1e-9 ? 0 : (t - a.t) / span;
    return {
      r: a.c[0] + (b.c[0] - a.c[0]) * f,
      g: a.c[1] + (b.c[1] - a.c[1]) * f,
      b: a.c[2] + (b.c[2] - a.c[2]) * f
    };
  }

  /* 把色带重采样成"弧长等距"查找表，避免黄—橙段过渡慢导致相邻档撞色 */
  var HP_RAMP = (function () {
    var SAMPLES = 240, pts = [], acc = [0], i;
    for (i = 0; i < SAMPLES; i++) pts.push(hpRampAt(i / (SAMPLES - 1)));
    for (i = 1; i < SAMPLES; i++) {
      var dr = pts[i].r - pts[i - 1].r;
      var dg = pts[i].g - pts[i - 1].g;
      var db = pts[i].b - pts[i - 1].b;
      acc.push(acc[i - 1] + Math.sqrt(dr * dr + dg * dg + db * db));
    }
    return { pts: pts, acc: acc, total: acc[SAMPLES - 1] };
  })();

  /* 按弧长比例 k 取色：k=0 最浅（1 档血），k=1 最深（满血） */
  function hpRampColor(k) {
    var table = HP_RAMP;
    var target = table.total * clamp(k, 0, 1);
    var lo = 0, hi = table.acc.length - 1;
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (table.acc[mid] < target) lo = mid; else hi = mid;
    }
    var seg = table.acc[hi] - table.acc[lo];
    var f = seg < 1e-9 ? 0 : (target - table.acc[lo]) / seg;
    var a = table.pts[lo], b = table.pts[hi];
    return {
      r: Math.round(a.r + (b.r - a.r) * f),
      g: Math.round(a.g + (b.g - a.g) * f),
      b: Math.round(a.b + (b.b - a.b) * f)
    };
  }

  /* 血量落在第几档：1~5 → 第 1 档，6~10 → 第 2 档，……到 hpCap 封顶 */
  function hpTier(hp) {
    var step = Math.max(1, Math.round(CFG.difficulty.colorStep || 5));
    var cap = Math.max(step, Math.round(CFG.difficulty.hpCap || 100));
    var top = Math.max(0, Math.ceil(cap / step) - 1);
    var idx = Math.ceil(Math.max(1, hp) / step) - 1;
    return { idx: clamp(idx, 0, top), top: top };
  }

  function hpStyleIndex(hp) { return hpTier(hp).idx; }

  /* 血量 → 填充 / 描边 / 数字三色 + 描边线宽；k 越大颜色越烫、越实、边框越粗 */
  function hpStyle(hp) {
    var t = hpTier(hp);
    var k = t.top > 0 ? t.idx / t.top : 0;
    var col = hpRampColor(k);
    var r = col.r, g = col.g, b = col.b;
    /* 描边与数字在自身色相上提亮，高档深色块也压得住，不会整片冲成白色 */
    var lift = 0.30 + 0.06 * k;
    var lr = Math.round(r + (255 - r) * lift);
    var lg = Math.round(g + (255 - g) * lift);
    var lb = Math.round(b + (255 - b) * lift);
    return {
      fill: "rgba(" + r + "," + g + "," + b + "," + (0.28 + 0.62 * k).toFixed(3) + ")",
      line: "rgba(" + lr + "," + lg + "," + lb + "," + (0.88 + 0.12 * k).toFixed(3) + ")",
      text: "rgba(" + Math.round(lr + (255 - lr) * 0.40) + "," + Math.round(lg + (255 - lg) * 0.40) +
            "," + Math.round(lb + (255 - lb) * 0.40) + ",.98)",
      lw: Math.round((1.2 + 1.0 * k) * 100) / 100
    };
  }
  var BONUS_STYLE = { fill: "rgba(255,206,84,.26)", line: "rgba(255,214,120,.98)", text: "#fff2c9" };
  var BALL_GLOW = "#63e6ff";
  var POINTER_COLOR = "#6ee7ff";
  var GUIDE_COLOR = "#8ef0c6";
  var DANGER_COLOR = "#ff5f7e";

  var state = {
    phase: "aiming",   // aiming | flying | over
    balls: CFG.ball.startBalls,   // 累计可发射球数
    lives: CFG.ball.startLives,   // 漏球容错：方块越线扣 1，扣光结束
    score: 0,
    wave: 0,
    r: 6,
    lineY: 0,
    baseY: 0,
    pointerLen: 46,
    time: 0,
    frame: 0,
    waveDelay: 0,
    shake: 0,
    shot: false,
    dropPause: 0,      // 持续下落模式下，撞到方块后的剩余暂停时间（秒）
    mode: "drop",      // drop = 持续下落 | row = 按发射轮次逐行下降
    rowRounds: 0,      // row 模式：当前档位已累计的发射轮数
    descCount: 0,      // row 模式：本局已下降的行数（决定下降节奏）
    shots: 0,          // 本局累计发射轮数（难度随轮数上升）
    refill: true,      // row 模式：每降一行是否在顶部补出新行
    freshWave: true    // 当前方块阵是否为尚未被发射过的新波次（为真时收球不下降）
  };

  var launcher = { x: 180, angle: CFG.ball.aimAngle };
  var grid = { cols: 6, rows: 3, cellW: 50, cellH: 50, gap: 6, rowGap: 6, left: 12, top: CFG.board.topPad, top0: CFG.board.topPad, entering: true };
  var blocks = [];
  var balls = [];
  var guide = null;   /* 横飞引导点：{x,y,r,life,max}，同时最多一个 */
  var sparks = [];
  var rings = [];
  var floaters = [];

  var input = { left: false, right: false, rotLeft: false, rotRight: false };

  /* ----------------------------- 基础工具 ----------------------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function blockRect(blk) {
    return {
      x: grid.left + blk.col * (grid.cellW + grid.gap),
      y: grid.top + blk.row * (grid.cellH + grid.rowGap),
      w: grid.cellW,
      h: grid.cellH
    };
  }

  function ballSpeed() { return clamp(W * CFG.ball.speedK, CFG.ball.speedMin, CFG.ball.speedMax); }
  function moveSpeed() { return clamp(W * CFG.ball.moveK, CFG.ball.moveMin, CFG.ball.moveMax); }
  function fallSpeed() { return Math.min(CFG.wave.fallBase + state.wave * CFG.wave.fallPerWave, CFG.wave.fallMax); }

  /* ------------------------------- 布局 ------------------------------- */

  function measure() {
    state.r = clamp(W / CFG.ball.radiusDiv, CFG.ball.radiusMin, CFG.ball.radiusMax);
    state.lineY = H - CFG.board.lineYOffset;
    state.baseY = H - CFG.board.baseYOffset;
    state.pointerLen = CFG.ball.pointerLen;
    grid.gap = clamp(Math.round(W * CFG.board.gapRatio), CFG.board.gapMin, CFG.board.gapMax);

    /* 一屏正好排下 CFG.board.visibleRows 层：取层距，方块按正方形做，且限个边长上限避免高屏变大砖；
       剩余高度全部给行间距，保证最底一层仍压在回收线之上 */
    var avail = state.lineY - grid.top0;
    var pitch = avail / CFG.board.visibleRows;
    var cell = Math.min(pitch - grid.gap, W / CFG.board.cellWidthDiv);
    grid.cellW = clamp(cell, CFG.board.cellMin, CFG.board.cellMax);
    grid.cellH = grid.cellW;
    grid.rowGap = clamp(pitch - grid.cellH, CFG.board.rowGapMin, CFG.board.rowGapMax);

    /* 列数由可用宽度反推：方块小了，一行能排更多列；整排水平居中 */
    var span = grid.cellW + grid.gap;
    grid.cols = clamp(Math.floor((W - CFG.board.colsPad + grid.gap) / span), CFG.board.colsMin, CFG.board.colsMax);
    grid.left = Math.max(CFG.board.leftPad, (W - (grid.cols * grid.cellW + (grid.cols - 1) * grid.gap)) / 2);
  }

  /* 尺寸变化后把已有方块收回有效列范围，并去掉撞格重叠 */
  function relocateBlocks() {
    var seen = {};
    for (var i = blocks.length - 1; i >= 0; i--) {
      var blk = blocks[i];
      blk.col = clamp(blk.col, 0, grid.cols - 1);
      var key = blk.row + ":" + blk.col;
      if (seen[key]) { blocks.splice(i, 1); continue; }
      seen[key] = true;
    }
  }

  function resize() {
    var rect = ui.stage.getBoundingClientRect();
    W = Math.max(260, Math.round(rect.width));
    H = Math.max(300, Math.round(rect.height));
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    measure();
    relocateBlocks();
    launcher.x = clamp(launcher.x, state.r + 22, W - state.r - 22);
    for (var i = 0; i < balls.length; i++) {
      balls[i].x = clamp(balls[i].x, balls[i].r, W - balls[i].r);
      if (balls[i].y > state.lineY) balls[i].y = state.lineY - 4;
    }
  }

  /* ------------------------------- 关卡 ------------------------------- */

  /* 难度等级：波次 + 已下降行数 + 已发射轮数共同决定；
     逐行下降靠补行续命时波次不涨，必须让行数与轮数也把难度顶上去 */
  function difficultyLevel() {
    return Math.max(state.wave, 1)
      + Math.floor(Math.max(0, state.descCount) / CFG.difficulty.descStep)
      + Math.floor(Math.max(0, state.shots) / CFG.difficulty.shotsStep);
  }

  /* 方块血量上限：随难度递增（曲线放缓），封顶 20 次 */
  function hpCeiling() {
    return clamp(1 + Math.floor((difficultyLevel() - 1) * CFG.difficulty.hpSlope), 1, CFG.difficulty.hpCap);
  }

  /* 新方块血量：以当前上限为基线，随机下浮 0-4 级，最低 1 */
  function rollHp() {
    var ceil = hpCeiling();
    return clamp(ceil - Math.floor(Math.random() * Math.min(ceil, CFG.difficulty.hpRollDown)), 1, CFG.difficulty.hpCap);
  }

  /* 每行方块数上限：不超过该行可容纳列数（grid.cols）的 60%，且至少 2 块 */
  function rowBlockCap() {
    return Math.max(CFG.board.rowMinBlocks, Math.floor(grid.cols * CFG.board.rowFillMax));
  }

  /* 本行实际放几块：在上限内随机，最多比上限少 2 块，最少 2 块 */
  function rowBlockCount() {
    var cap = rowBlockCap();
    var low = Math.max(CFG.board.rowMinBlocks, cap - CFG.board.rowCapSlack);
    return low + Math.floor(Math.random() * (cap - low + 1));
  }

  /* 从全部列里洗牌，取前 n 列作为本行放块的位置（其余留空） */
  function pickRowCols(n) {
    var pool = [];
    for (var c = 0; c < grid.cols; c++) pool.push(c);
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    var picked = {};
    for (var k = 0; k < n && k < pool.length; k++) picked[pool[k]] = true;
    return picked;
  }

  function spawnWave(n) {
    state.wave = n;
    state.waveDelay = 0;
    blocks.length = 0;
    var waveRows = Math.min(CFG.board.visibleRows, Math.max(1, Math.round(WAVE_CFG.maxRows)));
    var rows = Math.min(waveRows, CFG.wave.rowsBase + Math.floor((n - 1) / CFG.wave.rowsPerStep));
    var bonusLeft = n >= CFG.bonus.fromWave ? CFG.bonus.countLate : CFG.bonus.countEarly;
    for (var row = 0; row < rows; row++) {
      /* 每一行都按 60% 上限留空，避免一刷出就是满墙 */
      var picked = pickRowCols(rowBlockCount());
      var rowBlocks = [];
      for (var col = 0; col < grid.cols; col++) {
        if (!picked[col]) continue;
        var bonus = bonusLeft > 0 && Math.random() < CFG.bonus.rateSpawn;
        if (bonus) bonusLeft--;
        var cell = {
          col: col,
          row: row,
          hp: bonus ? 1 : rollHp(),
          special: bonus,
          blast: null,
          hitAt: -9,
          _f: -1
        };
        blocks.push(cell);
        rowBlocks.push(cell);
      }
      markSpecials(rowBlocks);
    }
    grid.top = -rows * (grid.cellH + grid.rowGap) - CFG.board.topPad;
    grid.entering = true;
    state.dropPause = 0;
    state.freshWave = true;     /* 新波次尚未被发射处理，收球时不下降 */
    syncHud();
  }

  function reset() {
    state.phase = "aiming";
    state.balls = CFG.ball.startBalls;
    state.lives = CFG.ball.startLives;
    state.score = 0;
    state.wave = 0;
    state.shake = 0;
    state.waveDelay = 0;
    state.shot = false;
    state.dropPause = 0;
    state.rowRounds = 0;
    state.shots = 0;
    state.descCount = 0;
    balls.length = 0;
    guide = null;
    sparks.length = 0;
    rings.length = 0;
    floaters.length = 0;
    launcher.x = W / 2;
    launcher.angle = CFG.ball.aimAngle;
    if (ui.over) ui.over.hidden = true;
    spawnWave(1);
  }

  function gameOver() {
    if (state.phase === "over") return;
    state.phase = "over";
    state.shake = CFG.feel.shakeOver;
    if (ui.overScore) ui.overScore.textContent = state.score;
    if (ui.overWave) ui.overWave.textContent = state.wave;
    if (ui.over) ui.over.hidden = false;
  }

  /* ------------------------------- HUD -------------------------------- */

  function syncHud() {
    if (ui.balls) ui.balls.textContent = state.balls;
    if (ui.wave) ui.wave.textContent = state.wave;
    if (ui.score) ui.score.textContent = state.score;
    if (ui.remain) ui.remain.textContent = blocks.length;
    if (ui.lives) ui.lives.textContent = Math.max(0, state.lives);
  }

  /* ------------------------------- 发射 ------------------------------- */

  function fire() {
    if (state.phase !== "aiming") return;
    var n = Math.max(1, state.balls);
    var speed = ballSpeed();
    var spreadTotal = Math.min(n - 1, CFG.ball.spreadMax) * CFG.ball.spreadStepDeg * Math.PI / 180;
    var ox = launcher.x + Math.sin(launcher.angle) * state.pointerLen;
    var oy = state.baseY - Math.cos(launcher.angle) * state.pointerLen;
    for (var i = 0; i < n; i++) {
      var t = n === 1 ? 0 : (i / (n - 1) - 0.5);
      var a = launcher.angle + t * spreadTotal;
      balls.push({
        x: clamp(ox, state.r, W - state.r),
        y: oy - 2,
        vx: Math.sin(a) * speed,
        vy: -Math.cos(a) * speed,
        r: state.r,
        flatT: 0,        /* 横飞累计时长 */
        armed: false,    /* 是否已进入过底线之上的有效场地（炮口在回收线下方，出生不算进场） */
        belowT: 0,       /* 已在回收线下方滞留的时长，用于兜底回收 */
        trail: []
      });
    }
    state.phase = "flying";
    state.shot = true;
    state.shots += 1;
    state.freshWave = false;    /* 已对本波次发射，收球后照常下降 */
    hideTip();
    addSparks(ox, oy, 10, POINTER_COLOR, 130);
  }

  /* ------------------------------- 碰撞 ------------------------------- */

  function hits(b, rect) {
    var nx = clamp(b.x, rect.x, rect.x + rect.w);
    var ny = clamp(b.y, rect.y, rect.y + rect.h);
    var dx = b.x - nx, dy = b.y - ny;
    return dx * dx + dy * dy <= b.r * b.r;
  }

  function reflect(b, rect) {
    var cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    var dx = b.x - cx, dy = b.y - cy;
    var ox = (rect.w / 2 + b.r) - Math.abs(dx);
    var oy = (rect.h / 2 + b.r) - Math.abs(dy);
    if (ox <= 0 || oy <= 0) {
      b.vx = -b.vx;
      b.vy = -b.vy;
      return;
    }
    if (ox < oy) {
      b.x += dx >= 0 ? ox : -ox;
      b.vx = Math.abs(b.vx) * (dx >= 0 ? 1 : -1);
    } else {
      b.y += dy >= 0 ? oy : -oy;
      b.vy = Math.abs(b.vy) * (dy >= 0 ? 1 : -1);
      /* 按撞击点偏离方块中心的程度给横向分量，撞偏侧就斜着弹开，避免垂直死循环 */
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
      var tangent = (b.x - cx) / (rect.w / 2 + b.r);
      if (Math.abs(tangent) > 0.12) {
        b.vx += tangent * sp * 0.55;
        var sp2 = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
        b.vx = b.vx / sp2 * sp;
        b.vy = b.vy / sp2 * sp;
      }
    }
  }

  /* ---------------------- 随机消除特效（血量 >= minHp） ---------------------- */

  function rollBlastKind() {
    return BLAST_KINDS[Math.floor(Math.random() * BLAST_KINDS.length)];
  }

  /* 给同一行方块掷特效：整行先按 chance 掷一次，命中后从合格方块里随机挑 perRowMin~perRowMax 个 */
  /* 给同一行方块掷特效：该行存在血量 >= minHp 的方块时整行按 chance 掷一次，
     命中后从该行可用方块里随机挑 perRowMin~perRowMax 个挂特效（默认 1 个） */
  function markSpecials(list) {
    if (!list || !list.length) return 0;
    var hasQualified = false;   /* 本行是否有碰撞次数达标的方块 */
    var pool = [];              /* 候选：本行所有可挂特效的方块（不限血量） */
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || b.special || b.blast) continue;
      if (b.hp >= SPECIAL_CFG.minHp) hasQualified = true;
      pool.push(b);
    }
    if (!hasQualified || !pool.length) return 0;
    if (Math.random() >= SPECIAL_CFG.chance) return 0;
    var hi = Math.max(0, Math.min(Math.round(SPECIAL_CFG.perRowMax), pool.length));
    if (hi < 1) return 0;
    var lo = Math.max(1, Math.min(Math.round(SPECIAL_CFG.perRowMin), hi));
    var n = lo + Math.floor(Math.random() * (hi - lo + 1));
    var marked = 0;
    for (var k = 0; k < n && pool.length; k++) {
      var pick = Math.floor(Math.random() * pool.length);
      var target = pool.splice(pick, 1)[0];
      target.blast = rollBlastKind();
      marked++;
    }
    return marked;
  }

  /* 特效是否波及到格子 o */
  function blastHit(blk, o) {
    if (!blk || !o || o === blk) return false;
    var dc = o.col - blk.col;
    var dr = o.row - blk.row;
    switch (blk.blast) {
      case "cross1": return (dc === 0 && Math.abs(dr) <= 1) || (dr === 0 && Math.abs(dc) <= 1);
      case "around8": return Math.abs(dc) <= 1 && Math.abs(dr) <= 1;
      case "row": return dr === 0;
      case "col": return dc === 0;
      case "crossFull": return dr === 0 || dc === 0;
      default: return false;
    }
  }

  /* 特效方块被打爆时引爆：清掉波及范围内所有方块 */
  function triggerBlast(blk) {
    var meta = BLAST_META[blk.blast] || BLAST_META.cross1;
    var rect = blockRect(blk);
    var cx = rect.x + rect.w / 2;
    var cy = rect.y + rect.h / 2;
    var killed = 0;
    for (var i = blocks.length - 1; i >= 0; i--) {
      var o = blocks[i];
      if (o !== blk && !blastHit(blk, o)) continue;
      addBurst(blockRect(o));
      blocks.splice(i, 1);
      killed++;
    }
    if (!killed) killed = 1;
    state.score += CFG.score.blastPerBlock * killed;
    state.shake = Math.min(state.shake + CFG.feel.shakeBlast, CFG.feel.shakeBlastMax);
    addSparks(cx, cy, 22, meta.color, 260);
    rings.push({
      x: rect.x - rect.w * 0.6, y: rect.y - rect.h * 0.6,
      w: rect.w * 2.2, h: rect.h * 2.2,
      life: RING_TIME * 1.6, max: RING_TIME * 1.6
    });
    addFloater(cx, rect.y - 8, meta.icon + " " + meta.label + " 消除 " + killed, meta.color);
    return killed;
  }
  function damage(blk, index, ball) {
    var rect = blockRect(blk);
    blk.hitAt = state.time;
    addRing(rect);
    state.shake = Math.min(state.shake + CFG.feel.shakeHit, CFG.feel.shakeHitMax);
    /* 持续下落模式：每次撞到方块暂停下落几帧，避免球还没落下来阵就压到底线 */
    if (state.mode === "drop" && !grid.entering) {
      state.dropPause = Math.min(state.dropPause + CFG.feel.fallPause, CFG.feel.fallPauseMax);
    }

    if (blk.special) {
      state.balls += 1;
      blocks.splice(index, 1);
      state.score += CFG.score.bonus;
      addSparks(rect.x + rect.w / 2, rect.y + rect.h / 2, 16, "#ffd678", 220);
      addFloater(rect.x + rect.w / 2, rect.y + rect.h / 2, "+1 球", "#ffd678");
    } else {
      blk.hp -= 1;
      state.score += CFG.score.hit;
      var style = hpStyle(blk.hp);
      addSparks(ball.x, ball.y, 7, blk.hp > 0 ? style.line : "#ffffff", 160);
      if (blk.hp <= 0) {
        if (blk.blast) {
          /* 带消除特效：按特效范围成片清除 */
          triggerBlast(blk);
        } else {
          blocks.splice(index, 1);
          state.score += CFG.score.kill;
          addBurst(rect);
        }
      }
    }
    if (!blocks.length) state.waveDelay = CFG.wave.spawnDelay;
    syncHud();
  }

  function collideBlocks(b) {
    for (var i = blocks.length - 1; i >= 0; i--) {
      var blk = blocks[i];
      if (!blk) continue;
      var rect = blockRect(blk);
      if (!hits(b, rect)) continue;
      reflect(b, rect);
      if (blk._f === state.frame) continue;
      blk._f = state.frame;
      damage(blk, i, b);
    }
  }

  /* ------------------------------- 更新 ------------------------------- */

  function maxBlockRow() {
    var maxRow = -1;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].row > maxRow) maxRow = blocks[i].row;
    }
    return maxRow;
  }

  /* 方块阵底部是否压到回收线 */
  function checkLeak() {
    var maxRow = maxBlockRow();
    if (maxRow < 0) return false;
    var bottom = grid.top + maxRow * (grid.cellH + grid.rowGap) + grid.cellH;
    if (bottom >= state.lineY) { leakRow(maxRow); return true; }
    return false;
  }

  /* row 模式：当前档位下移一行需要多少发射轮 —— 前 3 次每 3 轮、接着 2 次每 2 轮、之后每轮 */
  function rowNeedRounds() {
    if (state.descCount < CFG.pace.earlyCount) return CFG.pace.roundsEarly;
    if (state.descCount < CFG.pace.midCount) return CFG.pace.roundsMid;
    return CFG.pace.roundsLate;
  }

  /* 整阵下移 n 行：行索引后移，grid.top 不变（视觉位移 = n * 行距） */
  function shiftRows(n) {
    for (var i = 0; i < blocks.length; i++) blocks[i].row += n;
  }

  /* 行号归零：整阵回顶时让最上面一行回到 row 0 */
  function normalizeRows() {
    var minRow = 1e9;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].row < minRow) minRow = blocks[i].row;
    }
    if (minRow === 1e9 || minRow === 0) return;
    for (var j = 0; j < blocks.length; j++) blocks[j].row -= minRow;
  }

  /* 把历史累积在 grid.top 上的下移量折算成行号：折算后 row 0 恒等于画面最顶端。
     否则中途打开补行时，grid.top 早已被推下去，补出来的新行只会贴在「当前最上层方块
     的上面」，画面顶端则一路空着 */
  function foldTopOffset() {
    var step = grid.cellH + grid.rowGap;
    if (!(step > 0)) return 0;
    var off = grid.top - grid.top0;
    if (!(off > 0.5)) return 0;   /* 没下移过、或还在入场动画（off < 0）就别动 */
    var rows = Math.round(off / step);
    if (!(rows > 0)) return 0;    /* 不足半行，忽略，别为几像素把阵顶硬拉回去 */
    grid.top = grid.top0;
    shiftRows(rows);
    return rows;
  }

  /* 在画面最顶端（row 0）补出一行新方块：按每行上限随机放，其余留空 */
  function refillTopRow() {
    foldTopOffset();   /* 先把历史下移量折算成行号，保证新行落在画面最顶端 */
    var picked = pickRowCols(rowBlockCount());

    var bonus = Math.random() < CFG.bonus.rateRefill ? 1 : 0;
    var rowBlocks = [];
    for (var col = 0; col < grid.cols; col++) {
      if (!picked[col]) continue;
      var special = false;
      if (bonus > 0 && Math.random() < CFG.bonus.refillPick) { special = true; bonus -= 1; }
      var cell = {
        col: col,
        row: 0,
        hp: special ? 1 : rollHp(),
        special: special,
        blast: null,
        hitAt: -9,
        _f: -1
      };
      blocks.push(cell);
      rowBlocks.push(cell);
    }
    markSpecials(rowBlocks);
    syncHud();
  }

  /* row 模式：一轮发射结束（小球全部回收）后，按节奏决定方块阵是否下移一行 */
  function descRow() {
    if (state.mode !== "row" || state.phase === "over") return;
    if (!blocks.length || grid.entering) return;

    var need = rowNeedRounds();
    if (state.rowRounds < need) state.rowRounds += 1;
    if (state.rowRounds < need) {
      var left = need - state.rowRounds;
      addFloater(W / 2, Math.max(26, grid.top + grid.cellH * 1.6),
        "还需 " + left + " 轮下落", POINTER_COLOR);
      return;
    }

    state.rowRounds = 0;
    state.descCount += 1;
    if (state.refill) {
      /* 补行模式：不必打通整阵，整阵下移一行就在顶部补一行新方块 */
      shiftRows(1);
      refillTopRow();
    } else {
      grid.top += grid.cellH + grid.rowGap;
    }
    if (!checkLeak()) {
      addFloater(W / 2, Math.max(26, grid.top + grid.cellH * 0.5),
        state.refill ? "↓ 1 行 · 顶部补行" : "↓ 1 行", POINTER_COLOR);
    }
  }

  /* 方块阵最底边的 y（没有方块时等于阵顶） */
  function blocksBottom() {
    var maxRow = -1;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].row > maxRow) maxRow = blocks[i].row;
    }
    if (maxRow < 0) return grid.top;
    return grid.top + maxRow * (grid.cellH + grid.rowGap) + grid.cellH;
  }

  /* 是否还有小球卡在方块阵区域里（阵顶到阵底之间） */
  function ballsInField() {
    var bottom = blocksBottom();
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (b.y >= grid.top - b.r && b.y <= bottom + b.r) return true;
    }
    return false;
  }

  function updateBlocks(dt) {
    if (!blocks.length) {
      state.waveDelay -= dt;
      if (state.waveDelay <= 0) spawnWave(state.wave + 1);
      return;
    }
    if (grid.entering) {
      grid.top += CFG.board.enterSpeed * dt;
      if (grid.top >= CFG.board.topPad) { grid.top = CFG.board.topPad; grid.entering = false; }
    } else if (state.mode === "drop") {
      if (state.dropPause > 0) {
        /* 撞到方块后整阵先冻住，给小球飞出方块阵的时间 */
        state.dropPause = Math.max(0, state.dropPause - dt);
      } else {
        /* 球还在方块阵里打转时减速下落，避免球没落下来阵就压线 */
        grid.top += fallSpeed() * (ballsInField() ? CFG.feel.slowFactor : 1) * dt;
      }
    } else {
      return;   /* row 模式：方块静置，等本轮发射结束再下移 */
    }
    checkLeak();
  }

  /* 方块阵底部越过底线：扣 1 命，整阵推倒重来，命扣光即结束 */
  function leakRow(row) {
    state.lives -= 1;
    state.shake = CFG.feel.shakeLeak;
    /* 必须清空整阵：补行模式下最上面一行总是有块、minRow 恒为 0，
       只做 normalizeRows 无法把行号压回去，会原地再次触底连扣生命 */
    blocks.length = 0;
    normalizeRows();
    grid.top = grid.top0;
    state.dropPause = 0;
    addSparks(W / 2, state.lineY, 20, DANGER_COLOR, 260);
    addFloater(W / 2, state.lineY - 20, "-1 生命", DANGER_COLOR);
    syncHud();
    if (state.lives <= 0) gameOver();
  }

  /* 球横着飞（几乎不下落）时，在它前方必经之路上放一个引导点 */
  function placeGuide(b) {
    var dir = b.vx >= 0 ? 1 : -1;
    var x = b.x + dir * CFG.flat.dotDist;
    if (x < CFG.flat.dotR + 2 || x > W - CFG.flat.dotR - 2) {
      dir = -dir;
      x = b.x + dir * CFG.flat.dotDist;
    }
    x = clamp(x, CFG.flat.dotR + 2, W - CFG.flat.dotR - 2);
    /* 引导点紧贴球当下的行进路线放：纵坐标取自球当前的 y，只在屏幕上下边界内钳制 */
    var y = clamp(b.y, CFG.flat.dotR + 2, H - CFG.flat.dotR - 2);
    guide = { x: x, y: y, r: CFG.flat.dotR, life: CFG.flat.dotLife, max: CFG.flat.dotLife };
    b.flatT = 0;
    addSparks(x, y, 6, GUIDE_COLOR, 90);
  }

  /* 撞到引导点：以较大偏转角弹出，引导点随即消失 */
  function deflect(b) {
    var speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || ballSpeed();
    var dirY = (b.y < state.lineY * 0.5) ? 1 : -1;   /* 上半场往下弹、下半场往上弹 */
    var dirX = b.vx >= 0 ? 1 : -1;
    if (dirY < 0 && b.y < state.lineY * 0.35) dirY = 1;
    if (dirY > 0 && b.y > state.lineY * 0.75) dirY = -1;
    b.vx = dirX * speed * Math.cos((CFG.flat.kickDeg * Math.PI / 180));
    b.vy = dirY * speed * Math.sin((CFG.flat.kickDeg * Math.PI / 180));
    b.flatT = 0;
    /* 被弹出后重新起算线下滞留计时，避免刚出炮口的球刚被踢起身就被兜底回收 */
    b.belowT = 0;
    addSparks(guide.x, guide.y, 12, GUIDE_COLOR, 150);
    addRing({ x: guide.x - guide.r, y: guide.y - guide.r, w: guide.r * 2, h: guide.r * 2 });
    guide = null;
  }

  /* 球是否算「漏过底线、该回收」。
     炮口本身就架在回收线下方（baseYOffset 58 < lineYOffset 92），球是朝上射出去的，
     所以不能一刀切「y 越过线就收」，否则刚发射的球会被立刻吃掉。
     判定只看「是否进过场」：
     · 进过场的球：球心一越过回收线就立刻回收，不留任何线下存活窗口；
     · 没进过场的球：仍在上升就先留着，一旦 vy >= 0（不再往场内爬）或在下方滞留超过
       BELOW_GRACE 才兜底收掉。 */
  var BELOW_GRACE = 0.8;          /* 未进场的球（刚出炮口）在底线下方滞留多久后兜底回收（秒） */
  /* 回收特效：落在球真正消失的坐标上（已进场的球就消失于回收线附近），
     只有越出屏幕下边界时才钳到可视区内，避免特效看不见 */
  function recycleFx(b) {
    var ey = Math.min(b.y, H - 2);
    if (ey < 2) ey = 2;
    addSparks(b.x, ey, 6, DANGER_COLOR, 120);
  }

  function ballLost(b) {
    if (!(b.y > state.lineY)) {
      /* 回到有效场地，标记已进场并清零滞留计时 */
      b.armed = true;
      b.belowT = 0;
      return false;
    }
    if (b.armed) return true;              /* 已进场：球心越过回收线立刻回收，无等待窗口 */
    if (b.vy >= 0) return true;            /* 出生点就在线下且不再上升：留着也是横飞 */
    return b.belowT > BELOW_GRACE;         /* 朝上但慢到爬不回场地：兜底收掉 */
  }

  function updateBalls(dt) {
    for (var i = balls.length - 1; i >= 0; i--) {
      var b = balls[i];
      /* 球落到回收线下方后累计滞留时间：只服务于刚出炮口、还没进场的球做兜底回收 */
      if (b.y > state.lineY) b.belowT = (b.belowT || 0) + dt;
      var speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
      var steps = Math.max(1, Math.ceil(speed * dt / Math.max(2, b.r * 0.8)));
      var sdt = dt / steps;
      var recycled = false;

      /* 横飞检测：只有竖直速度分量极小（几乎全在横向来回反弹）且持续够久，才在必经之路上放点；
         刚出炮口、还没进场的球仍在回收线下方，判定与门槛和线上完全一致；
         同一时刻只保留一个点，已有的点不会被顶掉，避免连续刷新堆叠 */
      if (speed > 0.01) {
        if (Math.abs(b.vy) / speed < CFG.flat.ratio) b.flatT = (b.flatT || 0) + dt;
        else b.flatT = 0;
        if (!guide && b.flatT >= CFG.flat.hold) placeGuide(b);
      }

      for (var s = 0; s < steps; s++) {
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;

        if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }
        if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx); }
        if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }

        if (ballLost(b)) {
          recycleFx(b);
          balls.splice(i, 1);
          recycled = true;
          break;
        }
        if (guide) {
          var gdx = b.x - guide.x, gdy = b.y - guide.y, gr = b.r + guide.r;
          if (gdx * gdx + gdy * gdy <= gr * gr) deflect(b);
        }
        collideBlocks(b);

        /* 兜底再判一次：方块碰撞发生在上面那次判定之后，reflect 可能在本帧最后一步
           把球心挤出底线（且不改变 vy 方向），这里补一轮，保证球不会在线下多活一帧 */
        if (ballLost(b)) {
          recycleFx(b);
          balls.splice(i, 1);
          recycled = true;
          break;
        }
      }

      if (recycled) continue;
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > CFG.fx.trailLen) b.trail.shift();
    }

    if (guide) {
      guide.life -= dt;
      if (guide.life <= 0) guide = null;
    }

    if (state.phase === "flying" && !balls.length) {
      state.phase = "aiming";
      if (!blocks.length) {
        /* 方块已打空：标记为新鲜波次，收球时不再让新刷出的方块下降一行 */
        state.freshWave = true;
        if (state.waveDelay <= 0) state.waveDelay = CFG.wave.spawnDelay;
      } else if (!state.freshWave) {
        descRow();   /* row 模式：本轮发射结束，方块阵下移一行（drop 模式内部直接 return） */
      }
    }
  }

  function updateFx(dt) {
    var i;
    for (i = sparks.length - 1; i >= 0; i--) {
      var p = sparks[i];
      p.life -= dt;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= CFG.fx.sparkDrag;
      p.vy = p.vy * CFG.fx.sparkDrag + CFG.fx.sparkGravity * dt;
    }
    for (i = rings.length - 1; i >= 0; i--) {
      rings[i].life -= dt;
      if (rings[i].life <= 0) rings.splice(i, 1);
    }
    for (i = floaters.length - 1; i >= 0; i--) {
      floaters[i].life -= dt;
      floaters[i].y -= CFG.fx.floaterRise * dt;
      if (floaters[i].life <= 0) floaters.splice(i, 1);
    }
    if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * CFG.fx.shakeDecay);
  }

  function update(dt) {
    state.time += dt;
    state.frame += 1;

    if (state.phase !== "over") {
      var moveDir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      if (moveDir) launcher.x += moveDir * moveSpeed() * dt;
      launcher.x = clamp(launcher.x, state.r + 20, W - state.r - 20);

      var rotDir = (input.rotRight ? 1 : 0) - (input.rotLeft ? 1 : 0);
      if (rotDir) launcher.angle = clamp(launcher.angle + rotDir * CFG.ball.rotSpeed * dt, -angleLimit(), angleLimit());

      updateBlocks(dt);
      updateBalls(dt);
    }
    updateFx(dt);
  }

  /* ------------------------------- 特效 ------------------------------- */

  function addSparks(x, y, n, color, speed) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU;
      var sp = (0.35 + Math.random() * 0.85) * (speed || 180);
      sparks.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.26 + Math.random() * 0.24,
        max: 0.5,
        color: color,
        size: 1 + Math.random() * 1.9
      });
    }
  }

  function addRing(rect) {
    rings.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, life: RING_TIME, max: RING_TIME });
  }

  function addBurst(rect) {
    var cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    for (var i = 0; i < 4; i++) {
      addSparks(cx + (Math.random() - 0.5) * rect.w, cy + (Math.random() - 0.5) * rect.h, 4, "#ffffff", 200);
    }
    rings.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, life: RING_TIME * 1.2, max: RING_TIME * 1.2 });
  }

  function addFloater(x, y, text, color) {
    floaters.push({ x: x, y: y, text: text, color: color, life: 0.9, max: 0.9 });
  }

  /* ------------------------------- 渲染 ------------------------------- */

  function drawBoard() {
    /* 竖向细网格，给下落一点参照 */
    ctx.save();
    ctx.strokeStyle = "rgba(120,180,255,.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = grid.left + grid.cellW / 2; x < W; x += grid.cellW + grid.gap) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, state.lineY);
    }
    for (var y = 40; y < state.lineY; y += 40) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    ctx.restore();

    /* 左右边界 */
    ctx.save();
    ctx.strokeStyle = "rgba(110,231,255,.16)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(1, 0);
    ctx.lineTo(1, state.lineY);
    ctx.moveTo(W - 1, 0);
    ctx.lineTo(W - 1, state.lineY);
    ctx.stroke();
    ctx.restore();

    /* 回收线：下方方块逼近时变亮闪烁 */
    var near = false;
    var maxRow = -1;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].row > maxRow) maxRow = blocks[i].row;
    }
    if (maxRow >= 0) {
      var bottom = grid.top + maxRow * (grid.cellH + grid.rowGap) + grid.cellH;
      near = bottom > state.lineY - grid.cellH * 1.6;
    }
    var pulse = near ? 0.45 + 0.4 * Math.abs(Math.sin(state.time * 6)) : 0.3;
    ctx.save();
    ctx.setLineDash([9, 8]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,95,126," + pulse.toFixed(3) + ")";
    ctx.beginPath();
    ctx.moveTo(0, state.lineY);
    ctx.lineTo(W, state.lineY);
    ctx.stroke();
    ctx.restore();

    /* 持续下落：撞击暂停 / 阵内仍有球时给个缓降提示 */
    if (state.mode === "drop" && !grid.entering && state.phase !== "over") {
      var hold = state.dropPause > 0;
      if (hold || ballsInField()) {
        ctx.save();
        ctx.font = "11px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = hold ? "rgba(110,231,255,.85)" : "rgba(110,231,255,.45)";
        ctx.fillText(hold ? "撞击暂停" : "缓降中", W - 8, state.lineY - 6);
        ctx.restore();
      }
    }
  }

  function drawBlocks() {
    for (var i = 0; i < blocks.length; i++) {
      var blk = blocks[i];
      var rect = blockRect(blk);
      if (rect.y > state.lineY + 4) continue;
      var blastMeta = blk.blast ? (BLAST_META[blk.blast] || BLAST_META.cross1) : null;
      var style = blk.special ? BONUS_STYLE : (blastMeta || hpStyle(blk.hp));

      ctx.save();
      ctx.fillStyle = style.fill;
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, Math.min(7, rect.w * 0.22));
      ctx.fill();
      ctx.lineWidth = blk.special || blastMeta ? 2.2 : (style.lw || 1.4);
      ctx.strokeStyle = style.line;
      ctx.stroke();

      /* 命中闪一下 */
      var flash = 1 - (state.time - blk.hitAt) / FLASH_TIME;
      if (flash > 0) {
        ctx.globalAlpha = Math.min(1, flash) * 0.62;
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = style.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (blk.special) {
        ctx.font = "700 " + Math.round(rect.h * 0.36) + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
        ctx.fillText("+1", rect.x + rect.w / 2, rect.y + rect.h / 2);
        ctx.beginPath();
        ctx.arc(rect.x + rect.w - rect.w * 0.2, rect.y + rect.h * 0.2, Math.max(2, rect.w * 0.05), 0, TAU);
        ctx.fillStyle = "#fff6d5";
        ctx.fill();
      } else {
        var label = String(blk.hp);
        var fs = Math.max(9, Math.round(rect.h * (label.length > 1 ? 0.36 : 0.44)));
        ctx.font = "700 " + fs + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
        ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
        /* 特效方块右上角挂对应图标 */
        if (blastMeta) {
          ctx.font = "700 " + Math.max(9, Math.round(rect.h * 0.3)) + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
          ctx.fillStyle = blastMeta.line;
          ctx.fillText(blastMeta.icon, rect.x + rect.w - rect.w * 0.22, rect.y + rect.h * 0.24);
        }
      }
      ctx.restore();
    }
  }

  function drawGuide() {
    if (!guide) return;
    var pulse = 0.55 + 0.45 * Math.abs(Math.sin(state.time * 5));
    var fade = Math.min(1, guide.life / 0.4);   /* 临消失前淡出 */
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = "rgba(142,240,198," + (0.4 * pulse).toFixed(3) + ")";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(guide.x, guide.y, guide.r + 4 + 2 * pulse, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = GUIDE_COLOR;
    ctx.shadowColor = GUIDE_COLOR;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(guide.x, guide.y, guide.r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawRings() {
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      var k = 1 - r.life / r.max;          // 0 → 1 扩散进度
      var ex = r.w * 0.3 * k;
      var alpha = Math.pow(1 - k, 1.6) * 0.85;
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255," + alpha.toFixed(3) + ")";
      ctx.lineWidth = Math.max(0.6, 2.2 * (1 - k));
      ctx.strokeRect(r.x - ex, r.y - ex, r.w + ex * 2, r.h + ex * 2);
      ctx.restore();
    }
  }

  /* --------------------------- 球拖尾效果 ---------------------------
     water 水流 / particle 粒子 / star 星星 / comet 霓虹彗星 / none 关闭；
     CFG.fx.trailMode 为 auto 时，每次打开页面随机抽一种（state.trailMode 存实际用的）。 */
  var TRAIL_PICK = ["water", "particle", "star", "comet"];

  function rollTrailMode() {
    return TRAIL_PICK[Math.floor(Math.random() * TRAIL_PICK.length)];
  }

  function refreshTrailMode() {
    var m = CFG.fx.trailMode;
    state.trailMode = (!m || m === "auto") ? rollTrailMode() : m;
    return state.trailMode;
  }

  function trailPoints(b) {
    var pts = [];
    for (var i = 0; i < b.trail.length; i++) pts.push(b.trail[i]);
    pts.push({ x: b.x, y: b.y });
    return pts;
  }

  /* 水流：越靠球越粗越亮的蓝色流线，带轻微横向摆动 */
  function drawTrailWater(b, pts) {
    var n = pts.length;
    if (n < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var i = 1; i < n; i++) {
      var k = i / (n - 1);
      var wob = Math.sin(i * 0.85 - state.time * 11) * b.r * 0.5 * (1 - k);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x + wob, pts[i - 1].y);
      ctx.lineTo(pts[i].x + wob * 0.55, pts[i].y);
      ctx.strokeStyle = "rgba(96,214,255," + (0.05 + 0.45 * k * k).toFixed(3) + ")";
      ctx.lineWidth = b.r * (0.35 + 1.45 * k);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(pts[n - 2].x, pts[n - 2].y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = "rgba(222,250,255,.65)";
    ctx.lineWidth = b.r * 0.7;
    ctx.stroke();
    ctx.restore();
  }

  /* 粒子：沿尾迹撒一串大小/透明度递增的小亮点，带固定伪随机抖动 */
  function drawTrailParticle(b, pts) {
    var n = pts.length;
    ctx.save();
    for (var i = 0; i < n; i++) {
      var k = (i + 1) / n;
      var jx = Math.sin(i * 7.13 + pts[i].x * 0.06) * b.r * 1.0;
      var jy = Math.cos(i * 5.71 + pts[i].y * 0.06) * b.r * 1.0;
      ctx.globalAlpha = 0.10 + 0.6 * k;
      ctx.fillStyle = i % 3 === 0 ? "#c6f4ff" : "#59d7ff";
      ctx.beginPath();
      ctx.arc(pts[i].x + jx, pts[i].y + jy, b.r * (0.16 + 0.5 * k), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* 星星：每个采样点画一个会旋转的十字星，越靠球越大越亮 */
  function drawTrailStar(b, pts) {
    var n = pts.length;
    ctx.save();
    ctx.lineCap = "round";
    for (var i = 0; i < n; i++) {
      var k = (i + 1) / n;
      var sz = b.r * (0.45 + 1.15 * k);
      var spin = state.time * 2.4 + i * 0.6;
      var ca = Math.cos(spin), sa = Math.sin(spin);
      ctx.globalAlpha = 0.12 + 0.72 * k;
      ctx.strokeStyle = i % 2 ? "#ffe9a8" : "#d9f7ff";
      ctx.lineWidth = Math.max(0.8, b.r * 0.24);
      ctx.beginPath();
      ctx.moveTo(pts[i].x - ca * sz, pts[i].y - sa * sz);
      ctx.lineTo(pts[i].x + ca * sz, pts[i].y + sa * sz);
      ctx.moveTo(pts[i].x + sa * sz, pts[i].y - ca * sz);
      ctx.lineTo(pts[i].x - sa * sz, pts[i].y + ca * sz);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* 霓虹彗星：一条由透明到高亮的粗渐变光带 */
  function drawTrailComet(b, pts) {
    var n = pts.length;
    if (n < 2) return;
    var hx = pts[0].x - b.x, hy = pts[0].y - b.y;
    if (hx * hx + hy * hy < 1) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var grd = ctx.createLinearGradient(pts[0].x, pts[0].y, b.x, b.y);
    grd.addColorStop(0, "rgba(99,230,255,0)");
    grd.addColorStop(0.55, "rgba(99,230,255,.38)");
    grd.addColorStop(1, "rgba(212,250,255,.88)");
    ctx.strokeStyle = grd;
    ctx.lineWidth = b.r * 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function drawBallTrail(b) {
    var mode = state.trailMode;
    if (mode === "none" || !(CFG.fx.trailLen > 0)) return;
    if (!b.trail.length) return;
    var pts = trailPoints(b);
    if (mode === "water") return drawTrailWater(b, pts);
    if (mode === "particle") return drawTrailParticle(b, pts);
    if (mode === "star") return drawTrailStar(b, pts);
    return drawTrailComet(b, pts);
  }

  function drawBalls() {
    var blur = balls.length > 14 ? 6 : 15;
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      drawBallTrail(b);
      ctx.save();
      ctx.shadowColor = BALL_GLOW;
      ctx.shadowBlur = blur;
      ctx.fillStyle = "#eaf7ff";
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = "rgba(255,255,255,.95)";
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.2, b.y - b.r * 0.2, b.r * 0.42, 0, TAU);
      ctx.fill();
    }
  }

  function drawSparks() {
    for (var i = 0; i < sparks.length; i++) {
      var p = sparks[i];
      var alpha = Math.max(0, p.life / p.max);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    for (var i = 0; i < floaters.length; i++) {
      var f = floaters[i];
      ctx.save();
      ctx.globalAlpha = Math.max(0, f.life / f.max);
      ctx.fillStyle = f.color;
      ctx.font = "700 15px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  }

  function drawLauncher() {
    var a = launcher.angle;
    var x = launcher.x;
    var tipX = x + Math.sin(a) * state.pointerLen;
    var tipY = state.baseY - Math.cos(a) * state.pointerLen;

    /* 瞄准辅助虚线 */
    ctx.save();
    ctx.setLineDash([5, 7]);
    ctx.strokeStyle = "rgba(110,231,255,.30)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(x + Math.sin(a) * (state.pointerLen + 96), state.baseY - Math.cos(a) * (state.pointerLen + 96));
    ctx.stroke();
    ctx.restore();

    /* 指针 */
    ctx.save();
    ctx.strokeStyle = POINTER_COLOR;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(110,231,255,.7)";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(x, state.baseY - 2);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tipX, tipY, 3.4, 0, TAU);
    ctx.fillStyle = "#eafcff";
    ctx.fill();
    ctx.restore();

    /* 底座 */
    ctx.save();
    ctx.fillStyle = "rgba(110,231,255,.14)";
    roundRect(ctx, x - 26, state.baseY - 5, 52, 12, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(110,231,255,.55)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();

    /* 待发球提示 */
    if (state.phase === "aiming") {
      ctx.save();
      ctx.fillStyle = "rgba(234,247,255,.9)";
      ctx.beginPath();
      ctx.arc(tipX, tipY, Math.max(2.4, state.r * 0.55), 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (state.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake);
    }
    drawBoard();
    drawBlocks();
    drawGuide();
    drawRings();
    drawBalls();
    drawSparks();
    drawFloaters();
    drawLauncher();
  }

  /* ------------------------------- 主循环 ------------------------------ */

  var lastTs = 0;
  function loop(ts) {
    if (!lastTs) lastTs = ts;
    var dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;
    if (dt > 0 && !cfgOpenFlag) update(dt);   /* 配置弹窗打开时暂停，改完再继续 */
    render();
    requestAnimationFrame(loop);
  }

  /* ------------------------------- 交互 ------------------------------- */

  function hideTip() {
    if (!ui.tip || ui.tip.classList.contains("is-hide")) return;
    ui.tip.classList.add("is-hide");
  }

  /* ------------------------------- 模式 ------------------------------- */

  var MODE_KEY = "gb-mode";
  var REFILL_KEY = "gb-refill";

  function modeLabel(m) { return m === "row" ? "逐行下降" : "持续下落"; }

  /* 节奏说明按配置实时拼，改了配置文案不会说谎 */
  function paceText() {
    var c = CFG.pace;
    var midRows = Math.max(0, c.midCount - c.earlyCount);
    var tail = midRows > 0
      ? "前 " + c.earlyCount + " 行每 " + c.roundsEarly + " 轮、接着 " + midRows + " 行每 " + c.roundsMid + " 轮、之后每 " + c.roundsLate + " 轮"
      : "每 " + c.roundsEarly + " 轮降一行";
    return tail;
  }

  function modeHintText() {
    if (state.mode === "drop") {
      return state.refill
        ? "方块随时间持续下落，撞到方块短暂暂停；顶部补行仅在逐行下降生效"
        : "方块随时间持续下落，撞到方块短暂暂停，球在阵内时下落放缓";
    }
    var pct = Math.round(CFG.board.rowFillMax * 100);
    return state.refill
      ? "每降一行顶部补一行（每行最多占 " + pct + "% 列位）｜" + paceText()
      : "按轮次下移：" + paceText();
  }

  /* 顶部提示条文案同样按配置生成 */
  function tipText() {
    var sc = CFG.special;
    var head = "拖动画面移动发射器 · 长按 ⟲ ⟳ 调角度 · 点「发射」开球 · 黄色 +1 块直接加球";
    if (!(sc.chance > 0)) return head;
    var cnt = sc.perRowMin === sc.perRowMax ? String(sc.perRowMax) : sc.perRowMin + "~" + sc.perRowMax;
    return head + " · 某行若有血量 ≥" + sc.minHp + " 的方块，该行有 " + Math.round(sc.chance * 100) +
      "% 概率随机刷 " + cnt + " 个消除特效块（十字 / 九宫 / 整行 / 整列 / 行列）";
  }

  function syncTipText() {
    if (ui.tip) ui.tip.textContent = tipText();
  }

  function syncMode() {
    var drop = state.mode === "drop";
    if (ui.modeDrop) {
      ui.modeDrop.classList.toggle("is-on", drop);
      ui.modeDrop.setAttribute("aria-pressed", drop ? "true" : "false");
    }
    if (ui.modeRow) {
      ui.modeRow.classList.toggle("is-on", !drop);
      ui.modeRow.setAttribute("aria-pressed", drop ? "false" : "true");
    }
    if (ui.refill) {
      ui.refill.classList.toggle("is-on", state.refill);
      ui.refill.classList.toggle("is-dim", drop);
      ui.refill.setAttribute("aria-pressed", state.refill ? "true" : "false");
      ui.refill.textContent = state.refill ? "补行 开" : "补行 关";
    }
    if (ui.modeHint) ui.modeHint.textContent = modeHintText();
  }

  function setMode(m) {
    if (m !== "drop" && m !== "row") return;
    if (state.mode === m) return;
    state.mode = m;
    state.rowRounds = 0;
    state.dropPause = 0;
    syncMode();
    try { window.localStorage.setItem(MODE_KEY, m); } catch (err) {}
    addFloater(W / 2, state.lineY - 34, modeLabel(m), POINTER_COLOR);
  }

  function setRefill(on) {
    var v = !!on;
    if (state.refill === v) return;
    state.refill = v;
    syncMode();
    try { window.localStorage.setItem(REFILL_KEY, v ? "1" : "0"); } catch (err) {}
    addFloater(W / 2, state.lineY - 34, v ? "补行：开" : "补行：关", POINTER_COLOR);
  }

  function loadMode() {
    var m = "drop";
    try {
      var v = window.localStorage.getItem(MODE_KEY);
      if (v === "row" || v === "drop") m = v;
    } catch (err) {}
    state.mode = m;
    try {
      var f = window.localStorage.getItem(REFILL_KEY);
      if (f === "0") state.refill = false;
      else if (f === "1") state.refill = true;
    } catch (err2) {}
    syncMode();
  }

  function bindHold(el, on, off) {
    if (!el) return;
    el.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      on();
    }, { passive: false });
    ["pointerup", "pointercancel", "pointerleave", "blur"].forEach(function (t) {
      el.addEventListener(t, function () { off(); });
    });
  }

  bindHold(document.getElementById("gb-left"), function () { input.left = true; }, function () { input.left = false; });
  bindHold(document.getElementById("gb-right"), function () { input.right = true; }, function () { input.right = false; });
  bindHold(document.getElementById("gb-rot-left"), function () { input.rotLeft = true; }, function () { input.rotLeft = false; });
  bindHold(document.getElementById("gb-rot-right"), function () { input.rotRight = true; }, function () { input.rotRight = false; });

  if (ui.fire) {
    ui.fire.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      fire();
    }, { passive: false });
  }
  if (ui.restart) ui.restart.addEventListener("click", reset);
  if (ui.cfgOpen) {
    ui.cfgOpen.addEventListener("click", function () {
      if (cfgOpenFlag) closeCfg(); else openCfg();
    });
  }
  if (ui.again) ui.again.addEventListener("click", reset);
  if (ui.modeDrop) ui.modeDrop.addEventListener("click", function () { setMode("drop"); });
  if (ui.modeRow) ui.modeRow.addEventListener("click", function () { setMode("row"); });
  if (ui.refill) ui.refill.addEventListener("click", function () { setRefill(!state.refill); });

  /* 画布拖动 → 移动发射器（移动端主操作） */
  var dragging = false;
  function pickX(clientX) {
    var rect = canvas.getBoundingClientRect();
    var x = ((clientX - rect.left) / rect.width) * W;
    launcher.x = clamp(x, state.r + 20, W - state.r - 20);
  }
  canvas.addEventListener("pointerdown", function (e) {
    dragging = true;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    pickX(e.clientX);
    hideTip();
  }, { passive: true });
  canvas.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    pickX(e.clientX);
  }, { passive: true });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) {
    canvas.addEventListener(t, function () { dragging = false; });
  });

  /* 键盘：← → 移动，A/D 旋转，空格发射，R 重开 */
  document.addEventListener("keydown", function (e) {
    if (cfgOpenFlag) {
      if (e.key === "Escape") closeCfg();
      return;
    }
    switch (e.key) {
      case "ArrowLeft": input.left = true; e.preventDefault(); break;
      case "ArrowRight": input.right = true; e.preventDefault(); break;
      case "a": case "A": input.rotLeft = true; break;
      case "d": case "D": input.rotRight = true; break;
      case " ": fire(); e.preventDefault(); break;
      case "r": case "R": reset(); break;
      case "1": setMode("drop"); break;
      case "2": setMode("row"); break;
      case "3": setRefill(!state.refill); break;
      default: break;
    }
  });
  document.addEventListener("keyup", function (e) {
    switch (e.key) {
      case "ArrowLeft": input.left = false; break;
      case "ArrowRight": input.right = false; break;
      case "a": case "A": input.rotLeft = false; break;
      case "d": case "D": input.rotRight = false; break;
      default: break;
    }
  });

  /* ------------------------------- 启动 ------------------------------- */

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", function () {
    setTimeout(resize, 220);
  });
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); }).observe(ui.stage);
  }

  cfgBuildForm();
  refreshTrailMode();   /* 打开页面随机一种拖尾（CFG.fx.trailMode 非 auto 时就用配置值） */
  resize();
  loadMode();
  reset();
  requestAnimationFrame(loop);

  /* 无头自测钩子：仅当外部显式设置 window.__gbTest 时暴露内部状态，正式页面不会挂载 */
  if (window.__gbTest) {
    window.__gbDebug = {
      state: state, grid: grid, blocks: blocks, balls: balls,
      get W() { return W; }, get H() { return H; },
      descRow: descRow, refillTopRow: refillTopRow,
      reset: reset, fire: fire,
      spawnWave: spawnWave, measure: measure, relocateBlocks: relocateBlocks,
      blocksBottom: blocksBottom, ballsInField: ballsInField,
      update: update, updateBlocks: updateBlocks, updateBalls: updateBalls,
      get guide() { return guide; }, get sparks() { return sparks; }, get rings() { return rings; }, placeGuide: placeGuide, deflect: deflect,
      get FLAT_RATIO() { return CFG.flat.ratio; },
      get FLAT_HOLD() { return CFG.flat.hold; },
      get FLAT_KICK() { return CFG.flat.kickDeg * Math.PI / 180; },
      get FLAT_DOT_DIST() { return CFG.flat.dotDist; },
      get FLAT_DOT_LIFE() { return CFG.flat.dotLife; },
      damage: damage, collideBlocks: collideBlocks,
      get HIT_PAUSE() { return CFG.feel.fallPause; },
      get HIT_PAUSE_MAX() { return CFG.feel.fallPauseMax; },
      get SLOW_FACTOR() { return CFG.feel.slowFactor; },
      difficultyLevel: difficultyLevel, hpCeiling: hpCeiling, rollHp: rollHp,
      rowBlockCap: rowBlockCap, rowBlockCount: rowBlockCount, pickRowCols: pickRowCols,
      get ROW_FILL_MAX() { return CFG.board.rowFillMax; },
      specialCfg: SPECIAL_CFG, blastKinds: BLAST_KINDS, blastMeta: BLAST_META,
      markSpecials: markSpecials, blastHit: blastHit, triggerBlast: triggerBlast,
      rollBlastKind: rollBlastKind, waveCfg: WAVE_CFG,
      build: BUILD, bootCfg: BOOT_CFG, cfg: CFG, defaultCfg: DEFAULT_CFG, cfgFields: CFG_FIELDS,
      cfgGet: cfgGet, cfgSet: cfgSet, applyCfg: applyCfg, resetCfg: resetCfg,
      cfgBuildForm: cfgBuildForm, openCfg: openCfg, closeCfg: closeCfg,
      get cfgOpen() { return cfgOpenFlag; }, get CFG() { return CFG; },
      get trailMode() { return state.trailMode; },
      get blocks() { return blocks; }, get grid() { return grid; }, get balls() { return balls; },
      get state() { return state; },
      refreshTrailMode: refreshTrailMode, rollTrailMode: rollTrailMode,
      drawBallTrail: drawBallTrail,
      hpStyle: hpStyle, hpTier: hpTier, hpRampColor: hpRampColor, hpPalette: HP_PALETTE, foldTopOffset: foldTopOffset,
      angleLimit: angleLimit, input: input, loop: loop, render: render, tipText: tipText, syncTipText: syncTipText, paceText: paceText,
      modeHintText: modeHintText
    };
  }

  syncTipText();
  setTimeout(hideTip, 6000);
})();

