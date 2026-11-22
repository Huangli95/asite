/* ==========================================================================
   肉鸽卡牌 · 手动出牌 / AI 挂机双模式（纯前端，无依赖）
   --------------------------------------------------------------------------
   结构：
     01 参数配置（唯一真源 CONFIG / DEFAULT_CONFIG / SCHEMA）
     02 卡池与稀有度
     03 DOM 与状态
     04 通用工具
     05 战报与浮层动画
     06 渲染
     07 伤害与效果结算
     08 战斗引擎（回合状态机 + 手动等待 / AI 定时连播）
     09 奖励三选一 / 结算
     10 参数面板 / 卡组面板 / 导出
     11 事件绑定与启动
   约定：所有可调数值只在 01 段出现，其余逻辑一律读 CONFIG
   ========================================================================== */

(function () {
  'use strict';

  /* ======================== 01 参数配置（唯一真源） ======================== */

  var CFG_STORE_KEY = 'gm-rogue-config-v1';

  var DEFAULT_CONFIG = {
    /* —— 节奏与动画（即时生效） —— */
    speed: 1,
    stepDelay: 620,
    cardAnimMs: 240,
    damageFloat: true,
    logAutoScroll: true,

    /* —— 玩家数值（下一局生效） —— */
    playerHp: 70,
    manaPerTurn: 4,
    maxMana: 8,
    handSize: 5,
    maxPlaysPerTurn: 6,
    healPerWin: 3,

    /* —— 战斗规则（即时生效） —— */
    playMode: 'manual',
    blockDecay: true,
    vulnerableMul: 1.5,
    weakMul: 0.75,
    poisonDecay: true,
    enemyArmor: 0,

    /* —— 敌人成长（下一波生效） —— */
    enemyHpBase: 34,
    enemyHpGrow: 8,
    enemyHpMul: 1.05,
    enemyAtkBase: 6,
    enemyAtkGrow: 0.9,
    eliteEvery: 4,
    bossEvery: 6,
    eliteMul: 1.3,
    bossMul: 1.6,

    /* —— 奖励与初始卡组（下一局/下一波生效） —— */
    rewardChoices: 3,
    allowSkip: true,
    rarityBoost: 0.06,
    startStrikes: 5,
    startGuards: 4,
    startMends: 1
  };

  var SCHEMA = [
    {
      group: '节奏与动画（即时生效）',
      items: [
        { key: 'speed', label: '播放倍速', type: 'number', min: 0.25, max: 4, step: 0.25, hint: '1 为正常速度，越大推进越快' },
        { key: 'stepDelay', label: '每步间隔 ms', type: 'number', min: 120, max: 3000, step: 20, hint: '战斗每一步的基础停顿' },
        { key: 'cardAnimMs', label: '卡牌动画 ms', type: 'number', min: 0, max: 1200, step: 20, hint: '出牌飞行与卡面动效时长' },
        { key: 'damageFloat', label: '伤害飘字', type: 'bool' },
        { key: 'logAutoScroll', label: '战报自动滚动', type: 'bool' }
      ]
    },
    {
      group: '玩家数值（下一局生效）',
      items: [
        { key: 'playerHp', label: '初始生命', type: 'number', min: 10, max: 400, step: 5 },
        { key: 'manaPerTurn', label: '每回合费用', type: 'number', min: 1, max: 10, step: 1 },
        { key: 'maxMana', label: '费用上限', type: 'number', min: 1, max: 20, step: 1 },
        { key: 'handSize', label: '每回合抽牌', type: 'number', min: 1, max: 10, step: 1 },
        { key: 'maxPlaysPerTurn', label: '每回合最多出牌', type: 'number', min: 1, max: 15, step: 1 },
        { key: 'healPerWin', label: '每胜回复生命', type: 'number', min: 0, max: 40, step: 1 }
      ]
    },
    {
      group: '战斗规则（即时生效）',
      items: [
        { key: 'playMode', label: '出牌模式', type: 'select', options: [{ value: 'manual', label: '手动出牌' }, { value: 'ai', label: 'AI 挂机' }], hint: '手动：自己点手牌打出；AI：自动挂机出牌。战斗中可随时切换' },
        { key: 'blockDecay', label: '格挡回合清零', type: 'bool', hint: '关闭则格挡整局累积' },
        { key: 'vulnerableMul', label: '易伤倍率', type: 'number', min: 1, max: 3, step: 0.05 },
        { key: 'weakMul', label: '虚弱倍率', type: 'number', min: 0.2, max: 1, step: 0.05 },
        { key: 'poisonDecay', label: '中毒每回合递减', type: 'bool' },
        { key: 'enemyArmor', label: '敌人固定护甲', type: 'number', min: 0, max: 20, step: 1, hint: '每次受击直接减免的固定值' }
      ]
    },
    {
      group: '敌人成长（下一波生效）',
      items: [
        { key: 'enemyHpBase', label: '首波敌人生命', type: 'number', min: 5, max: 500, step: 1 },
        { key: 'enemyHpGrow', label: '每波生命增量', type: 'number', min: 0, max: 200, step: 1 },
        { key: 'enemyHpMul', label: '生命波次乘数', type: 'number', min: 1, max: 1.6, step: 0.01 },
        { key: 'enemyAtkBase', label: '首波敌人攻击', type: 'number', min: 1, max: 100, step: 1 },
        { key: 'enemyAtkGrow', label: '每波攻击增量', type: 'number', min: 0, max: 50, step: 0.1 },
        { key: 'eliteEvery', label: '精英间隔波次', type: 'number', min: 0, max: 20, step: 1, hint: '0 表示不出现精英' },
        { key: 'bossEvery', label: '首领间隔波次', type: 'number', min: 0, max: 30, step: 1, hint: '0 表示不出现首领' },
        { key: 'eliteMul', label: '精英强度倍率', type: 'number', min: 1, max: 4, step: 0.05 },
        { key: 'bossMul', label: '首领强度倍率', type: 'number', min: 1, max: 6, step: 0.05 }
      ]
    },
    {
      group: '奖励与初始卡组（下一局/下一波生效）',
      items: [
        { key: 'rewardChoices', label: '奖励可选张数', type: 'number', min: 1, max: 6, step: 1 },
        { key: 'allowSkip', label: '允许跳过奖励', type: 'bool' },
        { key: 'rarityBoost', label: '稀有度权重成长', type: 'number', min: 0, max: 1, step: 0.01, hint: '每波提升稀有卡出现概率' },
        { key: 'startStrikes', label: '初始「打击」张数', type: 'number', min: 0, max: 20, step: 1 },
        { key: 'startGuards', label: '初始「格挡」张数', type: 'number', min: 0, max: 20, step: 1 },
        { key: 'startMends', label: '初始「疗愈」张数', type: 'number', min: 0, max: 10, step: 1 }
      ]
    }
  ];

  var CONFIG = Object.assign({}, DEFAULT_CONFIG);

  function loadConfig() {
    try {
      var raw = window.localStorage.getItem(CFG_STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      Object.keys(DEFAULT_CONFIG).forEach(function (k) {
        if (typeof saved[k] === typeof DEFAULT_CONFIG[k] && saved[k] !== null) CONFIG[k] = saved[k];
      });
      if (CONFIG.playMode !== 'manual' && CONFIG.playMode !== 'ai') CONFIG.playMode = DEFAULT_CONFIG.playMode;
    } catch (e) { /* 无 localStorage 时静默降级 */ }
  }

  function saveConfig() {
    try { window.localStorage.setItem(CFG_STORE_KEY, JSON.stringify(CONFIG)); } catch (e) { /* 忽略 */ }
  }

  /* ============================ 02 卡池 ============================ */

  var TYPE_LABEL = { attack: '攻击', defense: '防御', skill: '技能' };
  var RARITY_LABEL = { basic: '初始', common: '普通', uncommon: '精良', rare: '稀有' };

  var CARDS = {
    strike: { name: '打击', cost: 1, type: 'attack', rarity: 'basic', ai: 6, text: '造成 6 点伤害', play: function (x) { x.damage(6); } },
    guard: { name: '格挡', cost: 1, type: 'defense', rarity: 'basic', ai: 5, text: '获得 5 点格挡', play: function (x) { x.block(5); } },
    mend: { name: '疗愈', cost: 2, type: 'skill', rarity: 'common', ai: 8, heal: 9, text: '回复 9 点生命', play: function (x) { x.heal(9); } },
    heavy: { name: '重击', cost: 2, type: 'attack', rarity: 'common', ai: 13, text: '造成 13 点伤害', play: function (x) { x.damage(13); } },
    twin: { name: '连斩', cost: 1, type: 'attack', rarity: 'common', ai: 8, text: '造成 4 点伤害两次', play: function (x) { x.damage(4); x.damage(4); } },
    flurry: { name: '乱舞', cost: 0, type: 'attack', rarity: 'common', ai: 3, text: '造成 3 点伤害', play: function (x) { x.damage(3); } },
    bash: { name: '碎击', cost: 2, type: 'attack', rarity: 'common', ai: 9, text: '造成 8 点伤害，施加 2 易伤', play: function (x) { x.damage(8); x.vulnerable(2); } },
    riposte: { name: '反击', cost: 1, type: 'defense', rarity: 'common', ai: 6, text: '获得 4 点格挡并造成 3 点伤害', play: function (x) { x.block(4); x.damage(3); } },
    sunder: { name: '破防', cost: 1, type: 'attack', rarity: 'uncommon', ai: 11, text: '造成 5 点伤害，施加 2 易伤', play: function (x) { x.damage(5); x.vulnerable(2); } },
    poisonblade: { name: '毒刃', cost: 1, type: 'attack', rarity: 'uncommon', ai: 11, text: '造成 3 点伤害，施加 4 中毒', play: function (x) { x.damage(3); x.poison(4); } },
    execute: { name: '处决', cost: 2, type: 'attack', rarity: 'uncommon', ai: 12, text: '造成 11 点伤害；目标生命低于 30% 时改为 24 点', play: function (x) { x.damage(S.enemy.hp <= S.enemy.maxHp * 0.3 ? 24 : 11); } },
    cleave: { name: '横扫', cost: 2, type: 'attack', rarity: 'uncommon', ai: 10, text: '造成 9 点伤害并获得 3 点格挡', play: function (x) { x.damage(9); x.block(3); } },
    siphon: { name: '汲血', cost: 2, type: 'attack', rarity: 'uncommon', ai: 9, heal: 4, text: '造成 8 点伤害，回复 4 点生命', play: function (x) { x.damage(8); x.heal(4); } },
    ironwall: { name: '铁壁', cost: 2, type: 'defense', rarity: 'uncommon', ai: 13, text: '获得 13 点格挡', play: function (x) { x.block(13); } },
    dodge: { name: '闪避', cost: 1, type: 'defense', rarity: 'uncommon', ai: 8, text: '获得 6 点格挡并抽 1 张', play: function (x) { x.block(6); x.draw(1); } },
    focus: { name: '蓄力', cost: 1, type: 'skill', rarity: 'uncommon', ai: 7, text: '获得 2 点力量（攻击牌永久增伤）', play: function (x) { x.strength(2); } },
    dex: { name: '灵巧', cost: 1, type: 'skill', rarity: 'uncommon', ai: 7, text: '获得 2 点敏捷（格挡牌额外加成）', play: function (x) { x.dexterity(2); } },
    surge: { name: '能量涌动', cost: 0, type: 'skill', rarity: 'rare', ai: 5, text: '本回合获得 2 点费用', play: function (x) { x.mana(2); } },
    insight: { name: '洞察', cost: 0, type: 'skill', rarity: 'rare', ai: 6, text: '抽 2 张牌', play: function (x) { x.draw(2); } },
    lacerate: { name: '裂伤', cost: 2, type: 'skill', rarity: 'rare', ai: 16, text: '施加 8 点中毒', play: function (x) { x.poison(8); } },
    berserk: { name: '狂暴', cost: 2, type: 'skill', rarity: 'rare', ai: 11, text: '获得 4 点力量，失去 4 点生命', play: function (x) { x.strength(4); x.selfDamage(4); } },
    fortress: { name: '堡垒', cost: 3, type: 'defense', rarity: 'rare', ai: 20, text: '获得 20 点格挡并 +2 敏捷', play: function (x) { x.block(20); x.dexterity(2); } }
  };

  var ENEMY_NAMES = {
    normal: ['腐化游魂', '锈蚀守卫', '拾荒者', '磷火蛾', '碎骨犬', '灰烬行者', '空洞回响'],
    elite: ['猩红执刑者', '双首石像', '锈甲骑士', '暗影织者'],
    boss: ['无光之眼', '骸骨王座', '熔渣巨像', '终末回廊']
  };

  /* ============================ 03 DOM 与状态 ============================ */

  function $(id) { return document.getElementById(id); }

  var handEl = null;
  var logEl = null;
  var enemyAvatar = null;
  var playerAvatar = null;

  var S = {
    running: false,
    paused: false,
    phase: 'battle',
    sub: 'turnStart',
    wave: 1,
    turn: 1,
    playedThisTurn: 0,
    carryMana: 0,
    player: { hp: 0, maxHp: 0, block: 0, mana: 0, strength: 0, dexterity: 0, poison: 0, weak: 0, vulnerable: 0 },
    enemy: null,
    deck: [],
    hand: [],
    drawPile: [],
    discard: [],
    priority: {},
    reward: [],
    stats: { cardsPlayed: 0, damageDealt: 0, damageTaken: 0, waves: 0, turns: 0 }
  };

  var handSig = '';
  var timer = null;

  /* ============================ 04 通用工具 ============================ */

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* 费用上限：配置项 maxMana，最低 1 点 */
  function manaCap() { return Math.max(1, Math.round(CONFIG.maxMana)); }

  /* 本回合基础费用：配置项 manaPerTurn，最低 0 点 */
  function manaBase() { return Math.max(0, Math.round(CONFIG.manaPerTurn)); }

  function rnd(n) { return Math.floor(Math.random() * n); }

  function pick(arr) { return arr[rnd(arr.length)]; }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = rnd(i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ============================ 05 战报与动画 ============================ */

  function log(text, kind) {
    if (!logEl) return;
    var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 42;
    var line = document.createElement('div');
    line.className = 'rg-line' + (kind ? ' rg-line--' + kind : '');
    line.textContent = text;
    logEl.appendChild(line);
    while (logEl.children.length > 400) logEl.removeChild(logEl.firstChild);
    if (CONFIG.logAutoScroll && atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  function clearLog() {
    if (logEl) logEl.innerHTML = '';
  }

  function floatText(target, text, cls) {
    if (!CONFIG.damageFloat || !target) return;
    var r = target.getBoundingClientRect();
    var span = document.createElement('span');
    span.className = 'rg-float' + (cls ? ' ' + cls : '');
    span.textContent = text;
    span.style.left = (r.left + r.width / 2 - 14 + (Math.random() * 24 - 12)) + 'px';
    span.style.top = (r.top + 14) + 'px';
    document.body.appendChild(span);
    window.setTimeout(function () { if (span.parentNode) span.parentNode.removeChild(span); }, 920);
  }

  function shakeEnemy() {
    if (!enemyAvatar) return;
    enemyAvatar.classList.remove('is-hit');
    /* 触发重排以便动画可重复播放 */
    void enemyAvatar.offsetWidth;
    enemyAvatar.classList.add('is-hit');
    window.setTimeout(function () { enemyAvatar.classList.remove('is-hit'); }, 360);
  }

  function flyCard(srcEl, id) {
    if (!srcEl || !enemyAvatar) return;
    var card = CARDS[id];
    if (!card) return;
    var a = srcEl.getBoundingClientRect();
    var b = enemyAvatar.getBoundingClientRect();
    var ghost = document.createElement('div');
    ghost.className = 'rg-fly rg-fly--' + card.type;
    ghost.textContent = card.name;
    ghost.style.left = a.left + 'px';
    ghost.style.top = a.top + 'px';
    ghost.style.width = a.width + 'px';
    ghost.style.height = a.height + 'px';
    ghost.style.opacity = '1';
    document.body.appendChild(ghost);
    var dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    var dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    void ghost.offsetWidth;
    ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.45) rotate(10deg)';
    ghost.style.opacity = '0.12';
    window.setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, Math.max(140, CONFIG.cardAnimMs) + 140);
  }

  /* ============================ 06 渲染 ============================ */

  function tag(text, cls) {
    return '<span class="rg-tag ' + (cls || '') + '">' + escapeHtml(text) + '</span>';
  }

  function renderAll() {
    renderHud();
    renderPlayer();
    renderEnemy();
    renderHand();
    renderPauseBtn();
    renderModeUI();
    renderActionBar();
  }

  function renderHud() {
    $('rg-wave').textContent = S.wave;
    $('rg-turn').textContent = S.turn;
    $('rg-mana').textContent = S.player.mana + ' / ' + manaCap();
    $('rg-block').textContent = S.player.block;
    $('rg-draw').textContent = S.drawPile.length;
    $('rg-discard').textContent = S.discard.length;
    $('rg-decksize').textContent = S.deck.length;
  }

  function renderPlayer() {
    var p = S.player;
    var pct = p.maxHp > 0 ? clamp(p.hp / p.maxHp * 100, 0, 100) : 0;
    $('rg-player-hpbar').style.width = pct + '%';
    $('rg-player-hp').textContent = p.hp + ' / ' + p.maxHp;
    var tags = [];
    if (p.block > 0) tags.push(tag('格挡 ' + p.block, 'rg-tag--block'));
    if (p.strength > 0) tags.push(tag('力量 ' + p.strength, 'rg-tag--buff'));
    if (p.dexterity > 0) tags.push(tag('敏捷 ' + p.dexterity, 'rg-tag--buff'));
    if (p.vulnerable > 0) tags.push(tag('易伤 ' + p.vulnerable, 'rg-tag--debuff'));
    if (p.weak > 0) tags.push(tag('虚弱 ' + p.weak, 'rg-tag--debuff'));
    if (p.poison > 0) tags.push(tag('中毒 ' + p.poison, 'rg-tag--buff'));
    $('rg-player-tags').innerHTML = tags.join('');
  }

  function renderEnemy() {
    var e = S.enemy;
    if (!e) return;
    $('rg-enemy-name').textContent = (e.isBoss ? '首领 · ' : (e.isElite ? '精英 · ' : '')) + e.name;
    var pct = e.maxHp > 0 ? clamp(e.hp / e.maxHp * 100, 0, 100) : 0;
    $('rg-enemy-hpbar').style.width = pct + '%';
    $('rg-enemy-hp').textContent = e.hp + ' / ' + e.maxHp;
    enemyAvatar.textContent = e.isBoss ? '王' : (e.isElite ? '精' : '敌');
    enemyAvatar.classList.toggle('is-boss', !!e.isBoss);
    enemyAvatar.classList.toggle('is-elite', !!e.isElite);
    var tags = [];
    if (e.block > 0) tags.push(tag('格挡 ' + e.block, 'rg-tag--block'));
    if (e.strength > 0) tags.push(tag('力量 ' + e.strength, 'rg-tag--buff'));
    if (e.vulnerable > 0) tags.push(tag('易伤 ' + e.vulnerable, 'rg-tag--debuff'));
    if (e.weak > 0) tags.push(tag('虚弱 ' + e.weak, 'rg-tag--debuff'));
    if (e.poison > 0) tags.push(tag('中毒 ' + e.poison, 'rg-tag--buff'));
    if (e.armor > 0) tags.push(tag('护甲 ' + e.armor));
    $('rg-enemy-tags').innerHTML = tags.join('');

    var iEl = $('rg-intent');
    var it = e.intent;
    iEl.className = 'rg-intent';
    if (!it) {
      iEl.textContent = '意图：待定';
    } else if (it.kind === 'attack') {
      iEl.textContent = '意图：攻击 · 约 ' + incomingDamage() + ' 伤害';
    } else if (it.kind === 'defend') {
      iEl.classList.add('is-defend');
      iEl.textContent = '意图：防御 · +' + it.value + ' 格挡';
    } else {
      iEl.classList.add('is-charge');
      iEl.textContent = '意图：蓄力 · 力量 +' + it.value;
    }
  }

  function renderHand() {
    if (!handEl) return;
    var sig = S.hand.join(',');
    if (sig !== handSig) {
      handSig = sig;
      handEl.innerHTML = '';
      S.hand.forEach(function (id) {
        var c = CARDS[id];
        if (!c) return;
        var div = document.createElement('div');
        div.className = 'rg-card rg-card--' + c.type + (c.rarity === 'rare' ? ' rg-card--rare' : '');
        div.innerHTML = '<div class="rg-cost">' + c.cost + '</div>' +
          '<div class="rg-cname">' + escapeHtml(c.name) + '</div>' +
          '<div class="rg-ctype">' + (TYPE_LABEL[c.type] || '') +
          (c.rarity !== 'basic' ? ' · ' + (RARITY_LABEL[c.rarity] || '') : '') + '</div>' +
          '<div class="rg-ctext">' + escapeHtml(c.text) + '</div>';
        handEl.appendChild(div);
      });
    }
    var canAct = canPlayManually();
    var children = handEl.children;
    for (var i = 0; i < children.length; i++) {
      var id = S.hand[i];
      if (!id) continue;
      var card = CARDS[id];
      var affordable = card.cost <= S.player.mana;
      children[i].classList.toggle('is-dim', !affordable);
      children[i].classList.toggle('is-playable', canAct && affordable);
    }
  }

  function renderPauseBtn() {
    var btn = $('rg-pause');
    if (!btn) return;
    btn.textContent = S.paused ? '继续' : '暂停';
    btn.classList.toggle('is-on', S.paused);
  }

  function renderModeUI() {
    var wrap = $('rg-mode');
    if (!wrap) return;
    wrap.classList.toggle('is-ai', !isManual());
    var btns = wrap.querySelectorAll('[data-mode]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-mode') === CONFIG.playMode;
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function renderActionBar() {
    var btn = $('rg-endturn');
    var hint = $('rg-hint');
    var manual = isManual();
    var playing = S.running && S.phase === 'battle';
    var waiting = canPlayManually();
    if (btn) {
      btn.hidden = !(playing && manual);
      btn.disabled = !waiting;
    }
    if (!hint) return;
    if (!playing) {
      hint.textContent = '本局已结束。点「重开」或「重新开局」开始新的一局；出牌模式可在上方切换。';
    } else if (!manual) {
      hint.textContent = 'AI 挂机中：系统按费用自动出牌，你只需看战报。点上方的「手动出牌」可随时接管。';
    } else if (waiting) {
      var left = Math.max(0, Math.round(CONFIG.maxPlaysPerTurn) - S.playedThisTurn);
      hint.textContent = '手动出牌：点击手牌打出（费用不足的牌会变暗），本回合还能打 ' + left + ' 张；点右侧「结束回合」交给对手。';
    } else if (S.paused) {
      hint.textContent = '已暂停，点「继续」后可以接着出牌。';
    } else {
      hint.textContent = '手动出牌：当前为敌方行动 / 结算阶段，等待回合开始后出牌。';
    }
  }

  /* ======================== 07 伤害与效果结算 ======================== */

  function incomingDamage() {
    var it = S.enemy && S.enemy.intent;
    if (!it || it.kind !== 'attack') return 0;
    var d = it.value + (S.enemy.strength || 0);
    if (S.enemy.weak > 0) d = Math.floor(d * CONFIG.weakMul);
    if (S.player.vulnerable > 0) d = Math.floor(d * CONFIG.vulnerableMul);
    return Math.max(0, Math.round(d));
  }

  function calcPlayerDamage(base) {
    var dmg = base + S.player.strength;
    if (S.player.weak > 0) dmg = Math.floor(dmg * CONFIG.weakMul);
    if (S.enemy.vulnerable > 0) dmg = Math.floor(dmg * CONFIG.vulnerableMul);
    dmg = dmg - (S.enemy.armor || 0);
    return Math.max(0, Math.round(dmg));
  }

  function dealToEnemy(dmg) {
    if (dmg <= 0) return 0;
    var absorbed = Math.min(S.enemy.block || 0, dmg);
    if (absorbed > 0) {
      S.enemy.block -= absorbed;
      dmg -= absorbed;
      log('敌人格挡吸收 ' + absorbed, 'mute');
    }
    if (dmg <= 0) return 0;
    S.enemy.hp = Math.max(0, S.enemy.hp - dmg);
    S.stats.damageDealt += dmg;
    log('敌人受到 ' + dmg + ' 点伤害（剩余 ' + S.enemy.hp + '）', 'dmg');
    floatText(enemyAvatar, '-' + dmg);
    shakeEnemy();
    return dmg;
  }

  function dealToPlayer(dmg) {
    if (dmg <= 0) return 0;
    var absorbed = Math.min(S.player.block || 0, dmg);
    if (absorbed > 0) {
      S.player.block -= absorbed;
      dmg -= absorbed;
      log('你的格挡吸收 ' + absorbed + ' 点', 'block');
      floatText(playerAvatar, '-' + absorbed + ' 格挡', 'is-block');
    }
    if (dmg <= 0) return 0;
    S.player.hp = Math.max(0, S.player.hp - dmg);
    S.stats.damageTaken += dmg;
    log('你受到 ' + dmg + ' 点伤害（剩余 ' + S.player.hp + '）', 'dmg');
    floatText(playerAvatar, '-' + dmg);
    return dmg;
  }

  function makeCtx() {
    return {
      damage: function (base) {
        return dealToEnemy(calcPlayerDamage(base));
      },
      block: function (n) {
        var b = Math.max(0, Math.round(n + S.player.dexterity));
        if (b <= 0) return 0;
        S.player.block += b;
        log('获得 ' + b + ' 点格挡', 'block');
        floatText(playerAvatar, '+' + b, 'is-block');
        return b;
      },
      heal: function (n) {
        var before = S.player.hp;
        S.player.hp = Math.min(S.player.maxHp, S.player.hp + n);
        var real = S.player.hp - before;
        if (real > 0) {
          log('回复 ' + real + ' 点生命（当前 ' + S.player.hp + '）', 'win');
          floatText(playerAvatar, '+' + real, 'is-heal');
        } else {
          log('生命已满，回复无效', 'mute');
        }
        return real;
      },
      strength: function (n) {
        S.player.strength += n;
        log('获得 ' + n + ' 点力量', 'buff');
        floatText(playerAvatar, '力量+' + n, 'is-buff');
      },
      dexterity: function (n) {
        S.player.dexterity += n;
        log('获得 ' + n + ' 点敏捷', 'buff');
        floatText(playerAvatar, '敏捷+' + n, 'is-buff');
      },
      poison: function (n) {
        S.enemy.poison += n;
        log('敌人中毒 +' + n, 'buff');
        floatText(enemyAvatar, '中毒+' + n, 'is-buff');
      },
      vulnerable: function (n) {
        S.enemy.vulnerable += n;
        log('敌人易伤 +' + n, 'buff');
      },
      weak: function (n) {
        S.enemy.weak += n;
        log('敌人虚弱 +' + n, 'buff');
      },
      draw: function (n) {
        var got = drawCards(n);
        log('抽 ' + got + ' 张牌', 'mute');
      },
      mana: function (n) {
        /* 回合内加费同样受费用上限约束 */
        var before = S.player.mana;
        S.player.mana = Math.min(manaCap(), S.player.mana + n);
        var real = S.player.mana - before;
        log('本回合费用 +' + real + (real < n ? '（已达上限 ' + manaCap() + '）' : ''), 'buff');
      },
      selfDamage: function (n) {
        S.player.hp = Math.max(0, S.player.hp - n);
        log('自损 ' + n + ' 点生命', 'dmg');
        floatText(playerAvatar, '-' + n);
      }
    };
  }

  /* ======================== 08 战斗引擎 ======================== */

  function clearTimer() {
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  /* 出牌模式：manual = 玩家自己点牌打出，ai = 系统挂机自动出牌 */
  function isManual() {
    return CONFIG.playMode !== 'ai';
  }

  /* 是否处于「等待玩家出牌」的手动输入状态 */
  function canPlayManually() {
    return S.running && !S.paused && S.phase === 'battle' && S.sub === 'play' && isManual();
  }

  function speedFactor() {
    var s = Number(CONFIG.speed);
    if (!isFinite(s) || s <= 0) s = 1;
    return Math.max(0.25, s);
  }

  function schedule(delay) {
    clearTimer();
    if (!S.running || S.paused || S.phase !== 'battle') return;
    /* 手动模式下进入出牌阶段即停住，等待玩家点牌或点「结束回合」 */
    if (S.sub === 'play' && isManual()) return;
    var base = (typeof delay === 'number') ? delay : CONFIG.stepDelay;
    timer = window.setTimeout(function () {
      timer = null;
      nextStep();
    }, Math.max(30, base / speedFactor()));
  }

  function nextStep() {
    if (!S.running || S.paused || S.phase !== 'battle') return;
    if (S.sub === 'turnStart') doTurnStart();
    else if (S.sub === 'play') doPlayOne();
    else if (S.sub === 'enemy') doEnemyTurn();
    else if (S.sub === 'turnEnd') doTurnEnd();
  }

  function buildStartDeck() {
    var deck = [];
    var i;
    for (i = 0; i < Math.round(CONFIG.startStrikes); i++) deck.push('strike');
    for (i = 0; i < Math.round(CONFIG.startGuards); i++) deck.push('guard');
    for (i = 0; i < Math.round(CONFIG.startMends); i++) deck.push('mend');
    if (!deck.length) deck.push('strike');
    return deck;
  }

  function newRun() {
    clearTimer();
    S.running = true;
    S.paused = false;
    S.phase = 'battle';
    S.wave = 1;
    S.turn = 1;
    S.playedThisTurn = 0;
    S.carryMana = 0;
    S.player = {
      hp: Math.round(CONFIG.playerHp), maxHp: Math.round(CONFIG.playerHp), block: 0,
      mana: Math.min(manaCap(), manaBase()), strength: 0, dexterity: 0,
      poison: 0, weak: 0, vulnerable: 0
    };
    S.deck = buildStartDeck();
    S.hand = [];
    S.drawPile = [];
    S.discard = [];
    S.priority = {};
    S.reward = [];
    S.stats = { cardsPlayed: 0, damageDealt: 0, damageTaken: 0, waves: 0, turns: 0 };
    handSig = '';
    $('rg-pausemask').hidden = true;
    hideModal('rg-reward');
    hideModal('rg-over');
    hideModal('rg-deck');
    clearLog();
    log('新的一局开始：初始卡组 ' + S.deck.length + ' 张，生命 ' + S.player.maxHp, 'win');
    startWave();
  }

  function startWave() {
    S.phase = 'battle';
    S.enemy = makeEnemy(S.wave);
    S.turn = 1;
    S.playedThisTurn = 0;
    S.hand = [];
    S.discard = [];
    S.drawPile = shuffle(S.deck.slice());
    S.player.block = 0;
    S.player.strength = 0;
    S.player.dexterity = 0;
    S.player.poison = 0;
    S.player.weak = 0;
    S.player.vulnerable = 0;
    /* 新一波战斗：上回合结转费用清零，首回合费用 = 基础费用（不超过上限） */
    S.carryMana = 0;
    S.player.mana = Math.min(manaCap(), manaBase());
    S.enemy.intent = rollIntent();
    var kind = S.enemy.isBoss ? '首领' : (S.enemy.isElite ? '精英' : '普通');
    log('第 ' + S.wave + ' 波 · ' + kind + '「' + S.enemy.name + '」出现，生命 ' + S.enemy.maxHp + ' · 攻击 ' + S.enemy.atk, 'enemy');
    S.sub = 'turnStart';
    renderAll();
    schedule(CONFIG.stepDelay);
  }

  function makeEnemy(wave) {
    var isBoss = CONFIG.bossEvery > 0 && wave % Math.round(CONFIG.bossEvery) === 0;
    var isElite = !isBoss && CONFIG.eliteEvery > 0 && wave % Math.round(CONFIG.eliteEvery) === 0;
    var mul = isBoss ? CONFIG.bossMul : (isElite ? CONFIG.eliteMul : 1);
    var hp = Math.round((CONFIG.enemyHpBase + CONFIG.enemyHpGrow * (wave - 1)) *
      Math.pow(CONFIG.enemyHpMul, wave - 1) * mul);
    hp = Math.max(5, hp);
    var atk = Math.round((CONFIG.enemyAtkBase + CONFIG.enemyAtkGrow * (wave - 1)) * mul * 0.82);
    atk = Math.max(1, atk);
    var pool = isBoss ? ENEMY_NAMES.boss : (isElite ? ENEMY_NAMES.elite : ENEMY_NAMES.normal);
    return {
      name: pick(pool),
      hp: hp,
      maxHp: hp,
      atk: atk,
      block: 0,
      strength: 0,
      vulnerable: 0,
      weak: 0,
      poison: 0,
      armor: Math.max(0, Math.round(CONFIG.enemyArmor)),
      isBoss: isBoss,
      isElite: isElite,
      intent: null
    };
  }

  function rollIntent() {
    var e = S.enemy;
    var base = Math.max(1, Math.round(e.atk * (0.85 + Math.random() * 0.35)));
    var r = Math.random();
    if (e.isBoss) {
      if (r < 0.66) return { kind: 'attack', value: base };
      if (r < 0.84) return { kind: 'charge', value: 2 };
      return { kind: 'defend', value: Math.max(4, Math.round(e.maxHp * 0.08)) };
    }
    if (r < 0.7) return { kind: 'attack', value: base };
    if (r < 0.86) return { kind: 'defend', value: Math.max(3, Math.round(e.atk * 0.9)) };
    return { kind: 'charge', value: 1 };
  }

  function drawCards(n) {
    var drawn = 0;
    for (var i = 0; i < n; i++) {
      if (S.hand.length >= Math.round(CONFIG.handSize) + 4) break;
      if (S.drawPile.length === 0) {
        if (S.discard.length === 0) break;
        S.drawPile = shuffle(S.discard.slice());
        S.discard = [];
        log('牌库耗尽，弃牌堆洗回牌库', 'mute');
      }
      S.hand.push(S.drawPile.pop());
      drawn++;
    }
    return drawn;
  }

  function doTurnStart() {
    if (CONFIG.blockDecay) S.player.block = 0;
    /* 回合开始费用 = 本回合基础费用 + 上回合结束时的剩余费用，累加后不超过费用上限（溢出上限部分丢弃） */
    var cap = manaCap();
    var base = manaBase();
    var carry = Math.max(0, Math.round(S.carryMana));
    S.player.mana = Math.min(cap, base + carry);
    var carried = Math.min(carry, Math.max(0, S.player.mana - base));
    S.carryMana = 0;
    S.playedThisTurn = 0;
    var got = drawCards(Math.round(CONFIG.handSize));
    S.stats.turns++;
    log('—— 第 ' + S.turn + ' 回合 · 费用 ' + S.player.mana + ' / ' + cap + (carried > 0 ? ' · 结转 +' + carried : '') + ' · 抽 ' + got + ' 张 ——', 'turn');
    if (S.enemy.hp <= 0) { renderAll(); victory(); return; }
    /* 先切到出牌阶段再渲染，保证手动模式下 UI 立即进入「等待玩家出牌」状态 */
    S.sub = 'play';
    renderAll();
    schedule(CONFIG.stepDelay);
  }

  function doPlayOne() {
    if (S.enemy.hp <= 0) { victory(); return; }
    if (S.player.hp <= 0) { gameOver(); return; }
    if (S.playedThisTurn >= Math.round(CONFIG.maxPlaysPerTurn)) {
      log('本回合出牌次数用尽，交给对手', 'mute');
      S.sub = 'enemy';
      schedule(CONFIG.stepDelay * 0.7);
      return;
    }
    var idx = pickBestCard();
    if (idx < 0) {
      log('费用不足或无可用牌，结束出牌', 'mute');
      S.sub = 'enemy';
      schedule(CONFIG.stepDelay * 0.7);
      return;
    }
    playCardAt(idx);
    if (S.enemy.hp <= 0) { victory(); return; }
    if (S.player.hp <= 0) { gameOver(); return; }
    schedule(CONFIG.stepDelay * 0.85);
  }

  function scoreCard(id) {
    var c = CARDS[id];
    var e = S.enemy;
    var v = c.ai || 6;
    if (c.type === 'attack') {
      var predict = v + S.player.strength;
      if (predict >= e.hp + (e.block || 0)) v += 140;
    } else if (c.type === 'defense') {
      var need = incomingDamage() - S.player.block;
      if (need > 0) v += Math.min(v, need) * 0.7 + 6;
      else v -= 8;
    } else if (c.heal) {
      var missing = S.player.maxHp - S.player.hp;
      if (missing <= 0) v = 0.5;
      else if (missing < c.heal) v = v * 0.6;
      if (S.player.hp < S.player.maxHp * 0.35) v += 16;
    }
    v += (S.priority[id] || 0) * 14;
    if (c.cost === 0) v += 12;
    v -= c.cost * 0.5;
    return v;
  }

  function pickBestCard() {
    var best = -1;
    var bestScore = -1e9;
    for (var i = 0; i < S.hand.length; i++) {
      var id = S.hand[i];
      var c = CARDS[id];
      if (!c || c.cost > S.player.mana) continue;
      var sc = scoreCard(id);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    return best;
  }

  function playCardAt(idx) {
    var id = S.hand[idx];
    var card = CARDS[id];
    if (!card) return;
    var cardEl = handEl ? handEl.children[idx] : null;
    S.player.mana -= card.cost;
    S.hand.splice(idx, 1);
    S.playedThisTurn++;
    S.stats.cardsPlayed++;
    if (cardEl) {
      cardEl.classList.remove('is-dim');
      cardEl.classList.add('is-playing');
    }
    flyCard(cardEl, id);
    log('打出「' + card.name + '」（' + card.cost + ' 费）', 'play');
    card.play(makeCtx());
    S.discard.push(id);
    renderAll();
  }

  /* 手动模式：玩家点击手牌打出 */
  function onHandCardClick(idx) {
    if (!S.running || S.paused || S.phase !== 'battle') return;
    if (!isManual()) {
      log('当前为 AI 挂机模式，切到「手动出牌」即可自行出牌', 'mute');
      return;
    }
    if (S.sub !== 'play') return;
    var id = S.hand[idx];
    var card = CARDS[id];
    if (!card) return;
    if (S.playedThisTurn >= Math.round(CONFIG.maxPlaysPerTurn)) {
      log('本回合出牌次数已用尽，点「结束回合」交给对手', 'mute');
      return;
    }
    if (card.cost > S.player.mana) {
      log('费用不足，无法打出「' + card.name + '」', 'mute');
      return;
    }
    playCardAt(idx);
    if (S.enemy.hp <= 0) { victory(); return; }
    if (S.player.hp <= 0) { gameOver(); return; }
    renderAll();
  }

  /* 手动模式：结束出牌，交给对手 */
  function endTurnManually() {
    if (!canPlayManually()) return;
    clearTimer();
    log('结束本回合出牌，交给对手', 'mute');
    S.sub = 'enemy';
    renderAll();
    schedule(CONFIG.stepDelay * 0.7);
  }

  /* 切换出牌模式：手牌自动接管 / 玩家接管 */
  function setPlayMode(mode) {
    var next = (mode === 'ai') ? 'ai' : 'manual';
    var prev = CONFIG.playMode;
    if (prev === next) return;
    CONFIG.playMode = next;
    afterConfigChange();
    syncPlayModeRuntime(prev);
    renderAll();
  }

  function syncPlayModeRuntime(prev) {
    if (prev === CONFIG.playMode) return;
    if (CONFIG.playMode === 'ai') {
      log('已切换为 AI 挂机：系统自动出牌接管', 'mute');
      if (S.running && !S.paused && S.phase === 'battle' && S.sub === 'play') {
        schedule(CONFIG.stepDelay * 0.5);
      }
    } else {
      log('已切换为手动出牌：可以自己点牌打出，点「结束回合」交给对手', 'mute');
      if (S.running && !S.paused && S.phase === 'battle') {
        if (S.sub === 'play') clearTimer();
        else schedule(CONFIG.stepDelay * 0.5);
      }
    }
  }

  function doEnemyTurn() {
    if (S.player.hp <= 0) { gameOver(); return; }
    var e = S.enemy;
    e.block = 0;
    var it = e.intent || rollIntent();
    if (it.kind === 'attack') {
      var dmg = it.value + (e.strength || 0);
      if (e.weak > 0) dmg = Math.floor(dmg * CONFIG.weakMul);
      if (S.player.vulnerable > 0) dmg = Math.floor(dmg * CONFIG.vulnerableMul);
      dmg = Math.max(0, Math.round(dmg));
      log('「' + e.name + '」发动攻击：' + dmg + ' 点伤害', 'enemy');
      dealToPlayer(dmg);
      if (Math.random() < 0.12 && S.player.hp > 0) {
        S.player.vulnerable += 1;
        log('你被施加 1 层易伤', 'enemy');
      }
    } else if (it.kind === 'defend') {
      e.block += it.value;
      log('「' + e.name + '」架起防御：格挡 +' + it.value, 'enemy');
      floatText(enemyAvatar, '+' + it.value, 'is-block');
    } else {
      e.strength += it.value;
      log('「' + e.name + '」蓄力：力量 +' + it.value, 'enemy');
      floatText(enemyAvatar, '力量+' + it.value, 'is-buff');
    }
    e.intent = rollIntent();
    renderAll();
    if (S.player.hp <= 0) { gameOver(); return; }
    S.sub = 'turnEnd';
    schedule(CONFIG.stepDelay);
  }

  function doTurnEnd() {
    if (S.player.poison > 0) {
      var pp = S.player.poison;
      S.player.hp = Math.max(0, S.player.hp - pp);
      log('中毒发作：你受到 ' + pp + ' 点伤害（剩余 ' + S.player.hp + '）', 'dmg');
      floatText(playerAvatar, '-' + pp);
      if (CONFIG.poisonDecay) S.player.poison = Math.max(0, pp - 1);
    }
    if (S.enemy.hp > 0 && S.enemy.poison > 0) {
      var ep = S.enemy.poison;
      S.enemy.hp = Math.max(0, S.enemy.hp - ep);
      log('敌人中毒发作：受到 ' + ep + ' 点伤害（剩余 ' + S.enemy.hp + '）', 'dmg');
      floatText(enemyAvatar, '-' + ep);
      if (CONFIG.poisonDecay) S.enemy.poison = Math.max(0, ep - 1);
    }
    if (S.hand.length) {
      S.discard = S.discard.concat(S.hand);
      S.hand = [];
    }
    if (S.player.weak > 0) S.player.weak--;
    if (S.player.vulnerable > 0) S.player.vulnerable--;
    if (S.enemy.weak > 0) S.enemy.weak--;
    if (S.enemy.vulnerable > 0) S.enemy.vulnerable--;
    /* 回合结束：剩余费用结转到下一回合（手动点「结束回合」与 AI 出牌结束都走这里，逻辑统一） */
    var leftMana = Math.max(0, Math.round(S.player.mana));
    S.carryMana = Math.min(manaCap(), leftMana);
    if (leftMana > 0) log('本回合剩余 ' + leftMana + ' 点费用，结转到下回合（上限 ' + manaCap() + '）', 'mute');
    S.turn++;
    renderAll();
    if (S.player.hp <= 0) { gameOver(); return; }
    if (S.enemy.hp <= 0) { victory(); return; }
    S.sub = 'turnStart';
    schedule(CONFIG.stepDelay);
  }

  /* ======================== 09 奖励与结算 ======================== */

  function victory() {
    clearTimer();
    S.stats.waves++;
    log('★ 击败「' + S.enemy.name + '」，第 ' + S.wave + ' 波通过', 'win');
    if (CONFIG.healPerWin > 0) {
      var before = S.player.hp;
      S.player.hp = Math.min(S.player.maxHp, S.player.hp + Math.round(CONFIG.healPerWin));
      if (S.player.hp > before) log('战斗结束恢复 ' + (S.player.hp - before) + ' 点生命', 'win');
    }
    S.wave++;
    S.phase = 'reward';
    renderAll();
    buildReward();
    showModal('rg-reward');
  }

  function gameOver() {
    clearTimer();
    S.phase = 'over';
    S.running = false;
    log('你倒下了，本局结束（止步第 ' + S.wave + ' 波）', 'bad');
    renderAll();
    var st = S.stats;
    $('rg-over-body').innerHTML =
      '到达波次 <b>' + S.wave + '</b><br>' +
      '通过波次 <b>' + st.waves + '</b><br>' +
      '打出卡牌 <b>' + st.cardsPlayed + '</b> 张 · 经历回合 <b>' + st.turns + '</b><br>' +
      '累计造成伤害 <b>' + st.damageDealt + '</b> · 承受伤害 <b>' + st.damageTaken + '</b><br>' +
      '最终卡组 <b>' + S.deck.length + '</b> 张';
    showModal('rg-over');
  }

  function rollRewardCard() {
    var wave = Math.max(1, S.wave);
    var wCommon = 60;
    var wUncommon = 30;
    var wRare = Math.max(6, 10 + (wave - 1) * CONFIG.rarityBoost * 10);
    var total = wCommon + wUncommon + wRare;
    var r = Math.random() * total;
    var rarity = r < wCommon ? 'common' : (r < wCommon + wUncommon ? 'uncommon' : 'rare');
    var pool = Object.keys(CARDS).filter(function (k) { return CARDS[k].rarity === rarity; });
    if (!pool.length) return null;
    return pick(pool);
  }

  function buildReward() {
    var picks = [];
    var need = clamp(Math.round(CONFIG.rewardChoices), 1, 6);
    var guard = 0;
    while (picks.length < need && guard++ < 300) {
      var id = rollRewardCard();
      if (!id || picks.indexOf(id) >= 0) continue;
      picks.push(id);
    }
    S.reward = picks;
    renderReward();
  }

  function renderReward() {
    var grid = $('rg-reward-grid');
    grid.innerHTML = '';
    S.reward.forEach(function (id, i) {
      var c = CARDS[id];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rg-reward-card rg-card--' + c.type;
      btn.style.animationDelay = (i * 45) + 'ms';
      btn.innerHTML = '<div class="rg-cost">' + c.cost + '</div>' +
        '<div class="rg-rarity">' + (RARITY_LABEL[c.rarity] || '') + '</div>' +
        '<div class="rg-cname">' + escapeHtml(c.name) + '</div>' +
        '<div class="rg-ctext">' + escapeHtml(c.text) + '</div>';
      btn.addEventListener('click', function () { pickReward(id); });
      grid.appendChild(btn);
    });
    $('rg-reward-skip').style.display = CONFIG.allowSkip ? '' : 'none';
  }

  function pickReward(id) {
    if (S.phase !== 'reward') return;
    var card = CARDS[id];
    if (!card) return;
    S.deck.push(id);
    log('获得卡牌「' + card.name + '」加入卡组（当前 ' + S.deck.length + ' 张）', 'win');
    hideModal('rg-reward');
    S.phase = 'battle';
    startWave();
  }

  function skipReward() {
    if (S.phase !== 'reward') return;
    log('跳过本次战利品', 'mute');
    hideModal('rg-reward');
    S.phase = 'battle';
    startWave();
  }

  /* ======================== 10 面板与导出 ======================== */

  function showModal(id) { var el = $(id); if (el) el.hidden = false; }
  function hideModal(id) { var el = $(id); if (el) el.hidden = true; }

  function applyLiveConfig() {
    document.body.style.setProperty('--rg-anim', Math.max(0, Math.round(CONFIG.cardAnimMs)) + 'ms');
    var btn = $('rg-speed');
    if (btn) btn.textContent = Number(CONFIG.speed).toFixed(CONFIG.speed % 1 === 0 ? 0 : 1) + '×';
    renderModeUI();
  }

  function afterConfigChange() {
    saveConfig();
    applyLiveConfig();
    /* 费用上限被调小后，当前费用与未使用的结转值同步收敛到新上限，并刷新费用 UI */
    S.player.mana = Math.min(manaCap(), Math.max(0, Math.round(S.player.mana || 0)));
    S.carryMana = Math.min(manaCap(), Math.max(0, Math.round(S.carryMana || 0)));
    if ($('rg-mana')) renderHud();
  }

  function cfgRow(item) {
    var row = document.createElement('div');
    row.className = 'rg-cfg-row';
    var label = document.createElement('label');
    label.textContent = item.label;
    if (item.hint) {
      var small = document.createElement('small');
      small.textContent = item.hint;
      label.appendChild(small);
    }
    row.appendChild(label);

    if (item.type === 'bool') {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rg-switch' + (CONFIG[item.key] ? ' is-on' : '');
      btn.textContent = CONFIG[item.key] ? '开' : '关';
      btn.addEventListener('click', function () {
        CONFIG[item.key] = !CONFIG[item.key];
        btn.classList.toggle('is-on', !!CONFIG[item.key]);
        btn.textContent = CONFIG[item.key] ? '开' : '关';
        afterConfigChange();
      });
      row.appendChild(btn);
    } else if (item.type === 'select') {
      var sel = document.createElement('select');
      (item.options || []).forEach(function (opt) {
        var op = document.createElement('option');
        op.value = opt.value;
        op.textContent = opt.label;
        sel.appendChild(op);
      });
      sel.value = CONFIG[item.key];
      sel.addEventListener('change', function () {
        if (item.key === 'playMode') {
          setPlayMode(sel.value);
        } else {
          CONFIG[item.key] = sel.value;
          afterConfigChange();
        }
      });
      row.appendChild(sel);
    } else {
      var input = document.createElement('input');
      input.type = 'number';
      if (item.min !== undefined) input.min = item.min;
      if (item.max !== undefined) input.max = item.max;
      input.step = item.step || 1;
      input.value = CONFIG[item.key];
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        if (!isFinite(v)) return;
        if (item.min !== undefined) v = Math.max(item.min, v);
        if (item.max !== undefined) v = Math.min(item.max, v);
        CONFIG[item.key] = v;
        afterConfigChange();
      });
      input.addEventListener('blur', function () { input.value = CONFIG[item.key]; });
      row.appendChild(input);
    }
    return row;
  }

  function buildCfgPanel() {
    var body = $('rg-cfg-body');
    body.innerHTML = '';
    SCHEMA.forEach(function (group) {
      var wrap = document.createElement('div');
      wrap.className = 'rg-cfg-group';
      var h = document.createElement('h4');
      h.textContent = group.group;
      wrap.appendChild(h);
      group.items.forEach(function (item) { wrap.appendChild(cfgRow(item)); });
      body.appendChild(wrap);
    });
    var note = document.createElement('p');
    note.className = 'rg-cfg-note';
    note.textContent = '说明：倍速、间隔、动画、飘字、战报滚动与战斗规则即时生效；费用上限调整后当前费用立即收敛，生命、每回合基础费用、敌人成长、初始卡组等数值在下一次开局或下一波生效。回合结束未用完的费用会结转到下一回合（不超过费用上限）。参数保存在本机浏览器（localStorage），不写入服务器。';
    body.appendChild(note);
  }

  function resetConfig() {
    var prevMode = CONFIG.playMode;
    Object.keys(DEFAULT_CONFIG).forEach(function (k) { CONFIG[k] = DEFAULT_CONFIG[k]; });
    afterConfigChange();
    buildCfgPanel();
    syncPlayModeRuntime(prevMode);
    renderAll();
    log('参数已恢复默认值', 'mute');
  }

  function exportConfig() {
    var text = JSON.stringify(CONFIG, null, 2);
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'game-rogue-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      log('参数已导出为 game-rogue-config.json', 'mute');
    } catch (e) {
      log('导出失败：' + e.message, 'bad');
    }
  }

  function renderDeck() {
    var body = $('rg-deck-body');
    body.innerHTML = '';
    var count = {};
    S.deck.forEach(function (id) { count[id] = (count[id] || 0) + 1; });
    var ids = Object.keys(count).sort(function (a, b) {
      var pa = CARDS[a], pb = CARDS[b];
      if (pa.cost !== pb.cost) return pa.cost - pb.cost;
      return pa.name < pb.name ? -1 : 1;
    });
    var list = document.createElement('div');
    list.className = 'rg-deck-list';
    ids.forEach(function (id) {
      var c = CARDS[id];
      var pr = S.priority[id] || 0;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rg-deck-item';
      btn.innerHTML = '<span class="rg-di-cost">' + c.cost + '</span>' +
        '<span class="rg-di-name">' + escapeHtml(c.name) + ' ×' + count[id] + '</span>' +
        '<span class="rg-di-text">' + escapeHtml(c.text) + '</span>' +
        '<span class="rg-di-pri">' + (pr > 0 ? new Array(pr + 1).join('★') : '默认') + '</span>';
      btn.addEventListener('click', function () {
        var next = ((S.priority[id] || 0) + 1) % 4;
        if (next === 0) delete S.priority[id];
        else S.priority[id] = next;
        renderDeck();
      });
      list.appendChild(btn);
    });
    body.appendChild(list);
    var note = document.createElement('p');
    note.className = 'rg-cfg-note';
    note.textContent = '共 ' + S.deck.length + ' 张卡。点击条目循环切换优先级（默认 → ★ → ★★ → ★★★），优先级越高，自动战斗时越会抢先打出。';
    body.appendChild(note);
  }

  function togglePause() {
    if (S.phase !== 'battle') return;
    S.paused = !S.paused;
    $('rg-pausemask').hidden = !S.paused;
    if (S.paused) {
      clearTimer();
      log('已暂停', 'mute');
    } else {
      log(isManual() && S.sub === 'play' ? '继续战斗，等待你出牌' : '继续战斗', 'mute');
      schedule(180);
    }
    renderAll();
  }

  function cycleSpeed() {
    var list = [0.5, 1, 1.5, 2, 3];
    var cur = Number(CONFIG.speed) || 1;
    var idx = list.indexOf(cur);
    var next = list[(idx + 1) % list.length];
    if (idx < 0) next = list[1];
    CONFIG.speed = next;
    afterConfigChange();
  }

  /* ======================== 11 事件绑定与启动 ======================== */

  function bind() {
    handEl = $('rg-hand');
    logEl = $('rg-log');
    enemyAvatar = $('rg-enemy-avatar');
    playerAvatar = $('rg-player-avatar');

    $('rg-pause').addEventListener('click', togglePause);
    $('rg-pause-resume').addEventListener('click', togglePause);
    $('rg-speed').addEventListener('click', cycleSpeed);

    var modeWrap = $('rg-mode');
    if (modeWrap) {
      modeWrap.addEventListener('click', function (ev) {
        var node = ev.target;
        while (node && node !== modeWrap && !(node.getAttribute && node.getAttribute('data-mode'))) {
          node = node.parentNode;
        }
        if (!node || node === modeWrap) return;
        setPlayMode(node.getAttribute('data-mode'));
      });
    }

    var endBtn = $('rg-endturn');
    if (endBtn) endBtn.addEventListener('click', endTurnManually);

    if (handEl) {
      handEl.addEventListener('click', function (ev) {
        var node = ev.target;
        while (node && node !== handEl && !(node.classList && node.classList.contains('rg-card'))) {
          node = node.parentNode;
        }
        if (!node || node === handEl) return;
        var idx = Array.prototype.indexOf.call(handEl.children, node);
        if (idx >= 0) onHandCardClick(idx);
      });
    }

    $('rg-restart').addEventListener('click', function () {
      if (!window.confirm('重开会立即清空当前局进度与卡组，确定要重开吗？')) return;
      newRun();
    });

    $('rg-cfg-open').addEventListener('click', function () {
      buildCfgPanel();
      showModal('rg-cfg');
    });
    $('rg-cfg-reset').addEventListener('click', resetConfig);
    $('rg-cfg-export').addEventListener('click', exportConfig);

    $('rg-deck-open').addEventListener('click', function () {
      renderDeck();
      showModal('rg-deck');
    });

    $('rg-reward-skip').addEventListener('click', skipReward);
    $('rg-over-again').addEventListener('click', newRun);

    $('rg-log-top').addEventListener('click', function () {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (el) {
      el.addEventListener('click', function () { hideModal(el.getAttribute('data-close')); });
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        hideModal('rg-cfg');
        hideModal('rg-deck');
      } else if (ev.code === 'Space') {
        var tag = (ev.target && ev.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        ev.preventDefault();
        togglePause();
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && S.phase === 'battle' && !S.paused) togglePause();
    });
  }

  function init() {
    loadConfig();
    bind();
    applyLiveConfig();
    newRun();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
