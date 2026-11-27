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
    /* 每波战斗结束固定回复生命：通用续航兜底，避免缺少恢复手段的流派被磨死 */
    healPerWin: 11,

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
    enemyHpMul: 1.11,
    enemyAtkBase: 6,
    enemyAtkGrow: 0.9,
    enemyAtkMul: 1.03,
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
    startMends: 1,

    /* —— 构筑核心与跳过奖励（下一局生效） —— */
    coreMode: 'choose',
    coreCardWeight: 3,
    skipManaMin: 2,

    /* —— 流派系数（下一局生效，用于调平各流派可推进的最大轮数） —— */
    bulwarkKeep: 0.7,
    reflectMul: 0.15,
    coreThorns: 1,
    lifestealPct: 0.3,
    lifestealCap: 14,
    bloodFlat: 6,
    bloodHpDmg: 0.08,
    poisonBonus: 16,
    /* 控制流：中毒结算从「层数×4 + 上限 12%」下调，改为层数×3.2 + 上限 9%，并把削攻力度上调 */
    poisonTickMul: 3.2,
    poisonHpPct: 0.09,
    poisonWeakAtk: 0.55,
    /* 控制流续航：每回合开始按中毒层数换格挡，避免持续叠毒时被反打暴毙 */
    poisonBlockPct: 0.5,
    poisonBlockCap: 0.25,
    /* 格挡反击流：新增「格挡压制」把格挡直接转成伤害，并强化盾击倍率 */
    bulwarkTempoPct: 0.45,
    bulwarkBashMul: 1.1,
    bulwarkBashBonus: 6,
    bulwarkHpReflect: 0.1,
    /* 血量上限消耗流：整体削弱，压住中位轮数最短的强度 */
    sacHpDmg: 0.09,
    sacStrengthPerHp: 3,
    sacHealPerHp: 12,
    sacBlockPerHp: 4,
    sacWaveMaxHp: 4,
    weakBonus: 10,
    engineMana: 2,
    engineCards: 3,
    engineHeal: 7,
    /* 闪避反击流：闪避层数不设上限（供影刃系数成长），改为限制每回合可闪避次数；反击数值相应下调以维持强度 */
    dodgePerTurn: 1,
    dodgeEvery: 2,
    dodgePerRoundCap: 2,
    dodgeCounter: 8,
    dodgeCounterDex: 1,
    dodgeCounterHpPct: 0.05,
    dodgeStreakBonus: 3,
    dodgeStreakCap: 16,
    /* 多段攻击：一次攻击拆成多段逐段结算，闪避/格挡按段生效，避免一次闪避吞掉整次攻击 */
    multiHitStart: 2,
    multiHitChance: 0.45,
    multiHitMax: 3,
    multiHitTotalMul: 1.15
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
      group: '构筑核心与跳过（下一局生效）',
      items: [
        { key: 'coreMode', label: '开局核心', type: 'select', options: [{ value: 'choose', label: '手动选择' }, { value: 'random', label: '随机分配' }, { value: 'none', label: '不使用核心' }], hint: '核心决定本局流派走向，六套核心对应六种流派' },
        { key: 'coreCardWeight', label: '核心流派卡权重', type: 'number', min: 1, max: 8, step: 0.1, hint: '奖励中与核心同流派的卡牌出现权重' },
        { key: 'skipManaMin', label: '跳过奖励回费下限', type: 'number', min: 2, max: 8, step: 1, hint: '跳过奖励后下回合额外恢复费用 = 本轮最高费卡费用，且不低于此值（最低 2）' },
        { key: 'reflectMul', label: '磐石反震比例', type: 'number', min: 0, max: 2, step: 0.05, hint: '格挡反击流：受击时按实际受伤值反震的比例（可叠加卡牌反震）' },
        { key: 'poisonTickMul', label: '蚀骨中毒倍率', type: 'number', min: 0.5, max: 6, step: 0.1, hint: '控制流：敌人中毒每回合结算伤害 = 层数 × 此倍率' },
        { key: 'poisonWeakAtk', label: '蚀骨削减攻击/层', type: 'number', min: 0, max: 8, step: 0.5, hint: '控制流：每层中毒削减敌人攻击力' },
        { key: 'poisonHpPct', label: '蚀骨上限伤害比例', type: 'number', min: 0, max: 0.2, step: 0.005, hint: '控制流：中毒结算额外附带敌人生命上限的此比例伤害' },
        { key: 'bulwarkHpReflect', label: '磐石上限反震比例', type: 'number', min: 0, max: 0.2, step: 0.005, hint: '格挡反击流：每次受击反震额外附带敌人生命上限的此比例伤害' },
        { key: 'sacWaveMaxHp', label: '每波血契上限回补', type: 'number', min: 0, max: 40, step: 1, hint: '血量上限消耗流：每波开始回补的生命上限' },
        { key: 'sacBlockPerHp', label: '血盾格挡/上限', type: 'number', min: 0, max: 20, step: 1, hint: '血量上限消耗流：每消耗 1 点生命上限获得的格挡' },
        { key: 'sacHpDmg', label: '血祭上限伤害比例', type: 'number', min: 0, max: 0.3, step: 0.005, hint: '血量上限消耗流：攻击额外附带自身生命上限的此比例伤害' },
        { key: 'bloodHpDmg', label: '血怒上限伤害比例', type: 'number', min: 0, max: 0.3, step: 0.005, hint: '强攻吸血流：每次攻击额外附带敌人生命上限的此比例伤害' },
        { key: 'lifestealCap', label: '单次吸血上限', type: 'number', min: 1, max: 60, step: 1, hint: '强攻吸血流：单次伤害可回复的生命上限' },
        { key: 'sacStrengthPerHp', label: '血祭力量/上限', type: 'number', min: 0, max: 12, step: 0.5, hint: '血量上限消耗流：每消耗 1 点生命上限获得的力量' },
        { key: 'dodgeEvery', label: '闪避获取间隔（回合）', type: 'number', min: 1, max: 6, step: 1, hint: '闪避反击流：每多少回合获得一次闪避层' },
        { key: 'dodgePerRoundCap', label: '每回合最多闪避次数', type: 'number', min: 1, max: 6, step: 1, hint: '闪避反击流：每回合最多消耗几层闪避来抵挡伤害；闪避层数本身不设上限' },
        { key: 'dodgeCounter', label: '闪避反击基础伤害', type: 'number', min: 0, max: 40, step: 1, hint: '闪避反击流：闪避成功后反击伤害（另加敏捷×1）' },
        { key: 'dodgeCounterHpPct', label: '闪避反击上限比例', type: 'number', min: 0, max: 0.15, step: 0.005, hint: '闪避反击流：反击额外附带敌人生命上限的此比例伤害' },
        { key: 'dodgeStreakBonus', label: '闪避连击每层加成', type: 'number', min: 0, max: 20, step: 1, hint: '闪避反击流：本波内每次成功闪避后，反击伤害逐次增加的数值' },
        { key: 'bulwarkTempoPct', label: '磐石压制比例', type: 'number', min: 0, max: 1, step: 0.05, hint: '格挡反击流：回合开始按留存格挡的此比例对敌人造成直接伤害' },
        { key: 'bulwarkBashMul', label: '盾击格挡倍率', type: 'number', min: 0, max: 3, step: 0.1, hint: '格挡反击流：盾击伤害 = 当前格挡 × 此倍率 + 固定值' },
        { key: 'poisonBlockPct', label: '毒雾格挡/中毒层', type: 'number', min: 0, max: 2, step: 0.05, hint: '控制流：回合开始按敌人中毒层数换取格挡的比例' },
        { key: 'poisonBlockCap', label: '毒雾格挡上限比例', type: 'number', min: 0, max: 1, step: 0.05, hint: '控制流：毒雾格挡不超过敌人生命上限的此比例' }
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
        { key: 'enemyAtkMul', label: '攻击波次乘数', type: 'number', min: 1, max: 1.2, step: 0.005, hint: '每波攻击乘以此系数，用于压住后期数值膨胀' },
        { key: 'eliteEvery', label: '精英间隔波次', type: 'number', min: 0, max: 20, step: 1, hint: '0 表示不出现精英' },
        { key: 'bossEvery', label: '首领间隔波次', type: 'number', min: 0, max: 30, step: 1, hint: '0 表示不出现首领' },
        { key: 'eliteMul', label: '精英强度倍率', type: 'number', min: 1, max: 4, step: 0.05 },
        { key: 'bossMul', label: '首领强度倍率', type: 'number', min: 1, max: 6, step: 0.05 },
        { key: 'multiHitStart', label: '多段攻击起始波次', type: 'number', min: 1, max: 30, step: 1, hint: '从该波起敌人攻击有概率拆成多段' },
        { key: 'multiHitChance', label: '多段攻击概率', type: 'number', min: 0, max: 1, step: 0.05, hint: '0 表示敌人始终单段攻击' },
        { key: 'multiHitMax', label: '多段攻击最大段数', type: 'number', min: 2, max: 5, step: 1, hint: '首领可取满段数，精英最多 3 段，普通敌人最多 2 段' },
        { key: 'multiHitTotalMul', label: '多段总伤害倍率', type: 'number', min: 0.5, max: 2, step: 0.05, hint: '多段合计伤害相对单段的倍率，逐段递增分配' }
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

  /* 流派标签：bulwark 格挡反击 / blood 强攻吸血 / control 控制 / engine 回费循环 /
     sacrifice 血量上限消耗 / dodge 闪避反击 / temp 单轮临时突破 / grow 长期成长 */
  var ARCH_LABEL = {
    bulwark: '格挡反击', blood: '强攻吸血', control: '控制', engine: '回费循环',
    sacrifice: '血祭上限', dodge: '闪避反击', temp: '临时突破', grow: '长期成长'
  };

  var CARDS = {
    /* —— 初始与通用 —— */
    strike: { name: '打击', cost: 1, type: 'attack', rarity: 'basic', ai: 6, text: '造成 6 点伤害', play: function (x) { x.damage(6); } },
    guard: { name: '格挡', cost: 1, type: 'defense', rarity: 'basic', arch: 'bulwark', ai: 5, pureBlock: true, text: '获得 5 点格挡', play: function (x) { x.block(5); } },
    mend: { name: '疗愈', cost: 2, type: 'skill', rarity: 'common', ai: 8, heal: 9, text: '回复 9 点生命', play: function (x) { x.heal(9); } },

    /* —— 强攻吸血 —— */
    heavy: { name: '重击', cost: 2, type: 'attack', rarity: 'common', arch: 'blood', ai: 13, text: '造成 13 点伤害', play: function (x) { x.damage(13); } },
    twin: { name: '连斩', cost: 1, type: 'attack', rarity: 'common', arch: 'blood', ai: 8, text: '造成 4 点伤害两次', play: function (x) { x.damage(4); x.damage(4); } },
    execute: { name: '处决', cost: 2, type: 'attack', rarity: 'uncommon', arch: 'blood', ai: 12, text: '造成 11 点伤害；目标生命低于 30% 时改为 24 点', play: function (x) { x.damage(S.enemy.hp <= S.enemy.maxHp * 0.3 ? 24 : 11); } },
    siphon: { name: '汲血', cost: 2, type: 'attack', rarity: 'uncommon', arch: 'blood', ai: 9, heal: 4, text: '造成 8 点伤害，回复 4 点生命', play: function (x) { x.damage(8); x.heal(4); } },
    focus: { name: '蓄力', cost: 1, type: 'skill', rarity: 'uncommon', arch: 'blood', ai: 7, text: '获得 2 点力量（攻击牌永久增伤）', play: function (x) { x.strength(2); } },
    berserk: { name: '狂暴', cost: 2, type: 'skill', rarity: 'rare', arch: 'blood', ai: 11, text: '获得 4 点力量，失去 4 点生命', play: function (x) { x.strength(4); x.selfDamage(4); } },
    bloodstrike: { name: '血刃', cost: 1, type: 'attack', rarity: 'common', arch: 'blood', ai: 11, text: '造成 9 点伤害，失去 2 点生命', play: function (x) { x.damage(9); x.selfDamage(2); } },
    bloodlust: { name: '血之渴望', cost: 2, type: 'attack', rarity: 'uncommon', arch: 'blood', ai: 14, text: '造成 10 点伤害，回复 6 点生命', play: function (x) { x.damage(10); x.heal(6); } },
    leech: { name: '嗜血术', cost: 1, type: 'skill', rarity: 'uncommon', arch: 'blood', ai: 10, useLimit: 3, text: '本局获得 10% 吸血（造成伤害回复生命）', play: function (x) { x.lifesteal(0.1); } },
    rage: { name: '暴怒', cost: 2, type: 'skill', rarity: 'rare', arch: 'blood', ai: 16, text: '获得 3 点力量，抽 1 张牌', play: function (x) { x.strength(3); x.draw(1); } },
    bloodstorm: { name: '血风暴', cost: 3, type: 'attack', rarity: 'rare', arch: 'blood', ai: 24, text: '造成 9 点伤害三次，失去 4 点生命', play: function (x) { x.damage(9); x.damage(9); x.damage(9); x.selfDamage(4); } },

    /* —— 格挡反击 —— */
    riposte: { name: '反击', cost: 1, type: 'defense', rarity: 'common', arch: 'bulwark', ai: 6, text: '获得 4 点格挡并造成 3 点伤害', play: function (x) { x.block(4); x.damage(3); } },
    cleave: { name: '横扫', cost: 2, type: 'attack', rarity: 'uncommon', arch: 'bulwark', ai: 10, text: '造成 9 点伤害并获得 3 点格挡', play: function (x) { x.damage(9); x.block(3); } },
    ironwall: { name: '铁壁', cost: 2, type: 'defense', rarity: 'uncommon', arch: 'bulwark', ai: 13, pureBlock: true, text: '获得 13 点格挡', play: function (x) { x.block(13); } },
    dex: { name: '灵巧', cost: 1, type: 'skill', rarity: 'uncommon', arch: 'bulwark', ai: 7, text: '获得 2 点敏捷（格挡牌额外加成）', play: function (x) { x.dexterity(2); } },
    fortress: { name: '堡垒', cost: 3, type: 'defense', rarity: 'rare', arch: 'bulwark', ai: 20, text: '获得 20 点格挡并 +2 敏捷', play: function (x) { x.block(20); x.dexterity(2); } },
    barrier: { name: '铁壁护身', cost: 1, type: 'defense', rarity: 'common', arch: 'bulwark', ai: 10, pureBlock: true, text: '获得 8 点格挡', play: function (x) { x.block(8); } },
    thornmail: { name: '荆棘甲', cost: 1, type: 'skill', rarity: 'common', arch: 'bulwark', ai: 9, text: '获得 2 点荆棘（每次受击反伤）', play: function (x) { x.thorns(2); } },
    shieldbash: { name: '盾击', cost: 1, type: 'attack', rarity: 'uncommon', arch: 'bulwark', ai: 13, text: '造成「格挡 × 1.1 + 6」点伤害', play: function (x) { x.damage(Math.floor(S.player.block * CONFIG.bulwarkBashMul) + Math.round(CONFIG.bulwarkBashBonus)); } },
    bashwall: { name: '盾墙冲锋', cost: 2, type: 'defense', rarity: 'uncommon', arch: 'bulwark', ai: 15, text: '获得 8 点格挡，然后造成「格挡 × 0.6」点伤害', play: function (x) { x.block(8); x.damage(Math.floor(S.player.block * 0.6)); } },
    ramcrush: { name: '碎盾重锤', cost: 2, type: 'attack', rarity: 'rare', arch: 'bulwark', ai: 20, text: '造成「格挡 × 1.2 + 6」伤害，随后失去一半格挡', play: function (x) { var n = Math.floor(S.player.block * 1.2) + 6; S.player.block = Math.floor(S.player.block * 0.5); x.damage(n); } },
    reflect: { name: '反击姿态', cost: 2, type: 'skill', rarity: 'rare', arch: 'bulwark', ai: 15, useLimit: 4, text: '本场战斗反震比例 +30%，获得 8 点格挡', play: function (x) { x.reflect(0.3); x.block(8); } },
    unbreak: { name: '不坏之躯', cost: 3, type: 'defense', rarity: 'rare', arch: 'bulwark', ai: 20, text: '获得 20 点格挡，生命上限 +5', play: function (x) { x.block(20); x.maxHpUp(5); } },

    /* —— 控制 —— */
    bash: { name: '碎击', cost: 2, type: 'attack', rarity: 'common', arch: 'control', ai: 9, text: '造成 8 点伤害，施加 2 易伤', play: function (x) { x.damage(8); x.vulnerable(2); } },
    sunder: { name: '破防', cost: 1, type: 'attack', rarity: 'uncommon', arch: 'control', ai: 11, text: '造成 5 点伤害，施加 2 易伤', play: function (x) { x.damage(5); x.vulnerable(2); } },
    poisonblade: { name: '毒刃', cost: 1, type: 'attack', rarity: 'uncommon', arch: 'control', ai: 11, text: '造成 3 点伤害，施加 4 中毒', play: function (x) { x.damage(3); x.poison(4); } },
    lacerate: { name: '裂伤', cost: 2, type: 'skill', rarity: 'rare', arch: 'control', ai: 16, text: '施加 8 点中毒', play: function (x) { x.poison(8); } },
    weaken: { name: '削弱', cost: 1, type: 'skill', rarity: 'common', arch: 'control', ai: 9, text: '施加 2 层虚弱', play: function (x) { x.weak(2); } },
    enfeeble: { name: '凋零', cost: 1, type: 'skill', rarity: 'uncommon', arch: 'control', ai: 10, text: '施加 3 点中毒并 1 层虚弱', play: function (x) { x.poison(3); x.weak(1); } },
    toxicburst: { name: '剧毒爆发', cost: 2, type: 'attack', rarity: 'uncommon', arch: 'control', ai: 13, text: '造成 4 点伤害，施加 5 点中毒', play: function (x) { x.damage(4); x.poison(5); } },
    lockdown: { name: '封锁', cost: 2, type: 'skill', rarity: 'rare', arch: 'control', ai: 16, text: '施加 3 层虚弱，清空敌人格挡', play: function (x) { x.weak(3); x.stripBlock(); } },
    plague: { name: '瘟疫', cost: 3, type: 'skill', rarity: 'rare', arch: 'control', ai: 22, text: '施加 12 点中毒', play: function (x) { x.poison(12); } },
    miasma: { name: '毒雾护体', cost: 1, type: 'defense', rarity: 'common', arch: 'control', ai: 11, text: '获得「敌人中毒层数 × 0.6 + 4」点格挡', play: function (x) { x.block(Math.floor((S.enemy.poison || 0) * 0.6) + 4); } },

    /* —— 回费抽卡回血 —— */
    surge: { name: '能量涌动', cost: 0, type: 'skill', rarity: 'rare', arch: 'engine', ai: 5, text: '本回合获得 2 点费用', play: function (x) { x.mana(2); } },
    insight: { name: '洞察', cost: 0, type: 'skill', rarity: 'rare', arch: 'engine', ai: 6, text: '抽 2 张牌', play: function (x) { x.draw(2); } },
    recycle: { name: '回收', cost: 1, type: 'skill', rarity: 'common', arch: 'engine', ai: 8, text: '抽 2 张牌', play: function (x) { x.draw(2); } },
    bargain: { name: '精算', cost: 0, type: 'skill', rarity: 'uncommon', arch: 'engine', ai: 7, text: '本回合获得 1 点费用，抽 1 张牌', play: function (x) { x.mana(1); x.draw(1); } },
    flowstate: { name: '流动', cost: 1, type: 'skill', rarity: 'uncommon', arch: 'engine', ai: 10, text: '抽 1 张牌，回复 6 点生命', play: function (x) { x.draw(1); x.heal(6); } },
    wellspring: { name: '泉涌', cost: 2, type: 'skill', rarity: 'rare', arch: 'engine', ai: 14, text: '本回合获得 3 点费用，抽 3 张牌', play: function (x) { x.mana(3); x.draw(3); } },
    cyclelight: { name: '循环之光', cost: 0, type: 'skill', rarity: 'rare', arch: 'engine', ai: 12, text: '抽 3 张牌，本回合获得 1 点费用', play: function (x) { x.draw(3); x.mana(1); } },

    /* —— 闪避反击 —— */
    flurry: { name: '乱舞', cost: 0, type: 'attack', rarity: 'common', arch: 'dodge', ai: 3, text: '造成 3 点伤害', play: function (x) { x.damage(3); } },
    dodge: { name: '闪避', cost: 1, type: 'defense', rarity: 'uncommon', arch: 'dodge', ai: 8, text: '获得 6 点格挡并抽 1 张牌', play: function (x) { x.block(6); x.draw(1); } },
    shadowstep: { name: '影步', cost: 1, type: 'defense', rarity: 'common', arch: 'dodge', ai: 10, text: '获得 1 层闪避，6 点格挡', play: function (x) { x.dodge(1); x.block(6); } },
    evasion: { name: '虚影', cost: 1, type: 'skill', rarity: 'uncommon', arch: 'dodge', ai: 11, text: '获得 2 层闪避', play: function (x) { x.dodge(2); } },
    counterslash: { name: '影袭', cost: 1, type: 'attack', rarity: 'uncommon', arch: 'dodge', ai: 13, text: '造成 4 点伤害两次，获得 1 层闪避', play: function (x) { x.damage(4); x.damage(4); x.dodge(1); } },
    dance: { name: '风影之舞', cost: 2, type: 'skill', rarity: 'rare', arch: 'dodge', ai: 16, text: '获得 2 层闪避，抽 2 张牌', play: function (x) { x.dodge(2); x.draw(2); } },
    afterimage: { name: '残像', cost: 2, type: 'defense', rarity: 'rare', arch: 'dodge', ai: 18, text: '获得 2 层闪避，10 点格挡', play: function (x) { x.dodge(2); x.block(10); } },
    shadowfang: { name: '影刃', cost: 1, type: 'attack', rarity: 'uncommon', arch: 'dodge', ai: 13, text: '造成「2 + 闪避层数 × 3」点伤害', play: function (x) { x.damage(2 + (S.player.dodge || 0) * 3); } },
    phantomrush: { name: '幻影突袭', cost: 2, type: 'attack', rarity: 'rare', arch: 'dodge', ai: 20, text: '造成 4 点伤害（闪避层数 +1）次，并获得 1 层闪避', play: function (x) { var hits = Math.min(5, 1 + (S.player.dodge || 0)); for (var i = 0; i < hits; i++) x.damage(4); x.dodge(1); } },

    /* —— 血量上限消耗 —— */
    sacrifice: { name: '血祭', cost: 0, type: 'skill', rarity: 'common', arch: 'sacrifice', ai: 10, sac: 4, text: '消耗 4 点生命上限，获得 2 点力量并回复 8 点生命', play: function (x) { if (x.spendMaxHp(4) > 0) { x.strength(2); x.heal(8); } } },
    immolate: { name: '献身', cost: 1, type: 'attack', rarity: 'uncommon', arch: 'sacrifice', ai: 13, sac: 5, text: '消耗 5 点生命上限，造成 15 点伤害', play: function (x) { if (x.spendMaxHp(5) > 0) x.damage(15); } },
    coreburn: { name: '内核燃烧', cost: 0, type: 'skill', rarity: 'uncommon', arch: 'sacrifice', ai: 9, sac: 3, text: '消耗 3 点生命上限，本回合获得 2 点费用并抽 1 张牌', play: function (x) { if (x.spendMaxHp(3) > 0) { x.mana(2); x.draw(1); } } },
    bloodnova: { name: '血爆', cost: 2, type: 'attack', rarity: 'rare', arch: 'sacrifice', ai: 20, text: '造成「本局已消耗生命上限」点伤害，并获得等量格挡', play: function (x) { var n = Math.max(1, S.player.hpSpent); x.damage(n); x.block(n); } },
    overclock: { name: '超载核心', cost: 2, type: 'skill', rarity: 'rare', arch: 'sacrifice', ai: 18, sac: 6, useLimit: 3, text: '消耗 6 点生命上限，获得 4 点力量，永久 +1 费用上限', play: function (x) { if (x.spendMaxHp(6) > 0) { x.strength(4); x.manaCapUp(1); } } },

    /* —— 单轮临时突破（回合结束消失） —— */
    tempfury: { name: '战意爆发', cost: 1, type: 'skill', rarity: 'common', arch: 'temp', ai: 9, text: '本回合 +4 点力量，回合结束消失', play: function (x) { x.tempStrength(4); } },
    tempform: { name: '临时壁垒', cost: 1, type: 'defense', rarity: 'common', arch: 'temp', ai: 9, text: '本回合 +3 点敏捷，获得 12 点格挡', play: function (x) { x.tempDexterity(3); x.block(12); } },
    tempmana: { name: '能量透支', cost: 0, type: 'skill', rarity: 'uncommon', arch: 'temp', ai: 6, text: '本回合获得 3 点费用（可超出费用上限）', play: function (x) { x.manaBurst(3); } },
    tempflurry: { name: '疾风决', cost: 1, type: 'attack', rarity: 'rare', arch: 'temp', ai: 15, text: '本回合 +2 点敏捷，造成 4 点伤害三次', play: function (x) { x.tempDexterity(2); x.damage(4); x.damage(4); x.damage(4); } },
    temprice: { name: '血怒战吼', cost: 2, type: 'skill', rarity: 'rare', arch: 'temp', ai: 16, text: '本回合 +7 点力量，失去 3 点生命', play: function (x) { x.tempStrength(7); x.selfDamage(3); } },

    /* —— 长期成长（永久） —— */
    ironsoul: { name: '铁血锻体', cost: 2, type: 'skill', rarity: 'uncommon', arch: 'grow', ai: 10, useLimit: 4, text: '永久 +14 点生命上限，并回复 14 点生命', play: function (x) { x.maxHpUp(14); x.heal(14); } },
    growguard: { name: '血色誓约', cost: 1, type: 'skill', rarity: 'uncommon', arch: 'grow', ai: 12, useLimit: 5, text: '永久 +6 点生命上限，并回复 6 点生命', play: function (x) { x.maxHpUp(6); x.heal(6); } },
    manawell: { name: '魔力源泉', cost: 2, type: 'skill', rarity: 'rare', arch: 'grow', ai: 12, useLimit: 4, text: '永久 +1 点费用上限', play: function (x) { x.manaCapUp(1); } },
    arcaneeye: { name: '秘法之眼', cost: 2, type: 'skill', rarity: 'uncommon', arch: 'grow', ai: 12, useLimit: 4, text: '永久 +1 点费用上限，抽 1 张牌', play: function (x) { x.manaCapUp(1); x.draw(1); } },
    titanheart: { name: '泰坦之心', cost: 3, type: 'skill', rarity: 'rare', arch: 'grow', ai: 20, useLimit: 5, text: '永久 +10 点生命上限，+2 点力量', play: function (x) { x.maxHpUp(10); x.strength(2); } }
  };

  /* 构筑核心：六套流派各一个核心，决定本局走向（数值系数见 01 段 CONFIG） */
  var CORES = {
    bulwark: { name: '磐石反击', arch: 'bulwark', tag: '格挡反击流', desc: '回合开始保留七成格挡，并用留存格挡 20% 直接压制敌人；受击时按格挡反震并附带荆棘伤害' },
    blood: { name: '嗜血战意', arch: 'blood', tag: '强攻吸血流', desc: '造成伤害回复 30% 生命（至少 1 点）；攻击牌额外 +2 伤害' },
    control: { name: '蚀骨掌控', arch: 'control', tag: '控制流', desc: '敌人中毒不再逐回合递减；每回合开始按中毒层数换取格挡，叠毒期间不再一味挨打' },
    engine: { name: '涌动循环', arch: 'engine', tag: '回费抽卡回血流', desc: '每回合额外 +1 费用；每打出 3 张牌回复 3 点生命' },
    sacrifice: { name: '血契献祭', arch: 'sacrifice', tag: '血量上限消耗流', desc: '每消耗 1 点生命上限：按比例换取力量、生命与格挡；每波开始少量回补上限' },
    dodge: { name: '疾影残像', arch: 'dodge', tag: '闪避反击流', desc: '定时获得闪避层（层数不设上限）；每回合最多闪避固定次数伤害，闪避成功后反击按敏捷、敌人上限与连击次数成长' }
  };

  var CORE_ORDER = ['bulwark', 'blood', 'control', 'engine', 'sacrifice', 'dodge'];

  /* 每局随机抽取的流派核心数量：开局只展示这么多个，同局内不重复 */
  var CORE_PICK_COUNT = 3;
  /* 本局实际展示的候选核心（在 newRun 中重新抽取） */
  var corePool = [];

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
    player: {
      hp: 0, maxHp: 0, block: 0, mana: 0, strength: 0, dexterity: 0,
      poison: 0, weak: 0, vulnerable: 0,
      /* 流派扩展状态：临时突破（本回合）、闪避/反震/吸血、永久成长、血祭累计 */
      tempStrength: 0, tempDexterity: 0,
      dodge: 0, dodgeStreak: 0, dodgeUsedThisTurn: 0, thorns: 0, reflectPct: 0, lifesteal: 0,
      manaCapBonus: 0, hpSpent: 0
    },
    core: null,
    skipManaPending: 0,
    engineCounter: 0,
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

  /* 费用上限：配置项 maxMana + 本局长期成长累加（魔力源泉 / 秘法之眼 / 超载核心），最低 1 点 */
  function manaCap() {
    var bonus = (S.player && S.player.manaCapBonus) ? S.player.manaCapBonus : 0;
    return Math.max(1, Math.round(CONFIG.maxMana) + Math.round(bonus));
  }

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
    var coreEl = $('rg-core-name');
    if (coreEl) {
      var core = (S.core && CORES[S.core]) ? CORES[S.core] : null;
      coreEl.textContent = core ? core.name : '未选核心';
      coreEl.title = core ? (core.tag + '：' + core.desc) : '本局未启用构筑核心';
      coreEl.classList.toggle('is-on', !!core);
    }
    var skipEl = $('rg-skip');
    if (skipEl) skipEl.textContent = Math.max(0, Math.round(S.skipManaPending));
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
    if (p.tempStrength > 0) tags.push(tag('临时力量 ' + p.tempStrength, 'rg-tag--buff'));
    if (p.tempDexterity > 0) tags.push(tag('临时敏捷 ' + p.tempDexterity, 'rg-tag--buff'));
    if (p.dodge > 0) {
      var dodgeLeft = Math.max(1, Math.round(CONFIG.dodgePerRoundCap)) - (p.dodgeUsedThisTurn || 0);
      tags.push(tag('闪避 ' + p.dodge + '（本轮 ' + Math.max(0, dodgeLeft) + '）', 'rg-tag--block'));
    }
    if (p.thorns > 0 || p.reflectPct > 0) {
      tags.push(tag('反震 ' + Math.round(p.reflectPct * 100) + '%' + (p.thorns > 0 ? ' +' + p.thorns : ''), 'rg-tag--block'));
    }
    if (p.lifesteal > 0) tags.push(tag('吸血 ' + Math.round(p.lifesteal * 100) + '%', 'rg-tag--buff'));
    if (p.maxHp > Math.round(CONFIG.playerHp) || p.manaCapBonus > 0) {
      tags.push(tag('上限 ' + p.maxHp + 'HP / ' + manaCap() + '费', 'rg-tag--buff'));
    }
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
      var hits = intentHits(it);
      if (hits > 1) {
        var segs = intentSegmentDamage(it);
        iEl.classList.add('is-multi');
        iEl.textContent = '意图：攻击 ×' + hits + ' 段 · 每段约 ' + segs[0] +
          '（合计 ' + incomingDamage() + ' 伤害）';
      } else {
        iEl.textContent = '意图：攻击 · 约 ' + incomingDamage() + ' 伤害';
      }
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
    /* 签名纳入限量卡剩余次数：同名卡剩余次数变化时也要重绘 */
    var sig = S.hand.join(',') + '#' + S.hand.map(function (id) {
      return useLimitOf(CARDS[id]) > 0 ? useLeftOf(id) : '';
    }).join(',');
    if (sig !== handSig) {
      handSig = sig;
      handEl.innerHTML = '';
      S.hand.forEach(function (id) {
        var c = CARDS[id];
        if (!c) return;
        var div = document.createElement('div');
        var lim = useLimitOf(c);
        div.className = 'rg-card rg-card--' + c.type + (c.rarity === 'rare' ? ' rg-card--rare' : '') +
          (lim > 0 ? ' rg-card--limited' : '');
        div.innerHTML = '<div class="rg-cost">' + c.cost + '</div>' +
          (lim > 0 ? '<div class="rg-uses">剩 ' + useLeftOf(id) + ' 次</div>' : '') +
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
    if (S.phase === 'core') {
      hint.textContent = '先在弹窗里选一个构筑核心（决定本局流派），选完即开始第 1 波。';
    } else if (!playing) {
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

  /* 攻击段数：多段攻击按 segs 长度，单段攻击为 1 */
  function intentHits(it) {
    if (!it || it.kind !== 'attack') return 0;
    if (it.segs && it.segs.length) return it.segs.length;
    return Math.max(1, Math.round(it.hits || 1));
  }

  /* 第 i 段的基础伤害（未叠加力量与状态修正） */
  function intentSegmentBase(it, i) {
    if (it && it.segs && it.segs.length) return it.segs[Math.min(i, it.segs.length - 1)];
    return (it && it.value) || 0;
  }

  /* 逐段伤害：力量按段均分，虚弱/蚀骨/易伤逐段结算，多段总量与单段口径基本一致 */
  function intentSegmentDamage(it) {
    var out = [];
    var n = intentHits(it);
    if (!n) return out;
    var e = S.enemy || {};
    var stPer = (e.strength || 0) / n;
    for (var i = 0; i < n; i++) {
      var d = intentSegmentBase(it, i) + stPer;
      if (e.weak > 0) d = Math.floor(d * CONFIG.weakMul);
      /* 蚀骨核心：中毒使敌人虚弱，按层数削减攻击力（控制流的主要减伤来源） */
      if (S.core === 'control' && (e.poison || 0) > 0) {
        d = Math.max(1, d - Math.floor((e.poison || 0) * CONFIG.poisonWeakAtk));
      }
      if (S.player.vulnerable > 0) d = Math.floor(d * CONFIG.vulnerableMul);
      out.push(Math.max(0, Math.round(d)));
    }
    return out;
  }

  /* 本次攻击的合计伤害（HUD 意图与 AI 判定共用） */
  function incomingDamage() {
    var segs = intentSegmentDamage(S.enemy && S.enemy.intent);
    var sum = 0;
    for (var i = 0; i < segs.length; i++) sum += segs[i];
    return sum;
  }

  function calcPlayerDamage(base) {
    /* 力量（含临时突破）+ 核心加成 */
    var dmg = base + S.player.strength + (S.player.tempStrength || 0);
    if (S.core === 'blood') {
      dmg += CONFIG.bloodFlat + Math.round(S.enemy.maxHp * CONFIG.bloodHpDmg);
    }
    if (S.core === 'sacrifice') dmg += Math.round(S.player.maxHp * CONFIG.sacHpDmg);
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
    /* 吸血：按实际造成的伤害回复生命（嗜血战意核心 / 嗜血术叠加） */
    var ls = (S.player.lifesteal || 0) + (S.core === 'blood' ? CONFIG.lifestealPct : 0);
    if (ls > 0 && S.player.hp > 0) {
      var steal = Math.max(1, Math.floor(dmg * ls));
      steal = Math.min(steal, Math.max(1, Math.round(CONFIG.lifestealCap)));
      healPlayer(steal);
    }
    return dmg;
  }

  /* 统一的回复入口：卡牌 heal、血祭回报、吸血、核心循环都走这里 */
  function healPlayer(n) {
    n = Math.max(0, Math.round(n));
    if (n <= 0) return 0;
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
  }

  function dealToPlayer(dmg, segInfo) {
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
    /* 荆棘 + 反震：按受到的实际伤害回敬敌人（格挡反击流的主要输出） */
    var reflect = (S.player.reflectPct || 0) + (S.core === 'bulwark' ? CONFIG.reflectMul : 0);
    /* 多段攻击逐段结算：固定荆棘按段均分，避免总反伤被打段数放大 */
    var segN = (segInfo && segInfo.count > 1) ? segInfo.count : 1;
    var back = Math.max(0, Math.round((S.player.thorns || 0) / segN)) +
      Math.floor(dmg * reflect);
    /* 磐石核心：反震附带敌人生命上限比例伤害，避免反震流被敌人生命指数成长卡死 */
    if (S.core === 'bulwark') back += Math.round(S.enemy.maxHp * CONFIG.bulwarkHpReflect / segN);
    if (back > 0 && S.enemy.hp > 0) {
      log('荆棘反震：回敬 ' + back + ' 点伤害', 'block');
      directEnemyDamage(back);
    }
    return dmg;
  }

  /* 不经力量/易伤等修正的直接伤害（反击、荆棘、反震用） */
  function directEnemyDamage(n) {
    var dmg = Math.max(0, Math.round(n));
    if (dmg <= 0 || S.enemy.hp <= 0) return 0;
    var absorbed = Math.min(S.enemy.block || 0, dmg);
    if (absorbed > 0) {
      S.enemy.block -= absorbed;
      dmg -= absorbed;
    }
    if (dmg <= 0) return 0;
    S.enemy.hp = Math.max(0, S.enemy.hp - dmg);
    S.stats.damageDealt += dmg;
    log('敌人受到 ' + dmg + ' 点伤害（剩余 ' + S.enemy.hp + '）', 'dmg');
    floatText(enemyAvatar, '-' + dmg);
    shakeEnemy();
    return dmg;
  }

  function makeCtx() {
    return {
      damage: function (base) {
        return dealToEnemy(calcPlayerDamage(base));
      },
      block: function (n) {
        var b = Math.max(0, Math.round(n + S.player.dexterity + (S.player.tempDexterity || 0)));
        if (b <= 0) return 0;
        S.player.block += b;
        log('获得 ' + b + ' 点格挡', 'block');
        floatText(playerAvatar, '+' + b, 'is-block');
        return b;
      },
      heal: function (n) {
        return healPlayer(n);
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
        var add = n + (S.core === 'control' ? Math.round(CONFIG.poisonBonus) : 0);
        S.enemy.poison += add;
        log('敌人中毒 +' + add, 'buff');
        floatText(enemyAvatar, '中毒+' + add, 'is-buff');
        return add;
      },
      vulnerable: function (n) {
        S.enemy.vulnerable += n;
        log('敌人易伤 +' + n, 'buff');
      },
      weak: function (n) {
        var add = n + (S.core === 'control' ? Math.round(CONFIG.weakBonus) : 0);
        S.enemy.weak += add;
        log('敌人虚弱 +' + add, 'buff');
        return add;
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
      },
      /* —— 单轮临时突破：本回合有效，回合结束清零 —— */
      tempStrength: function (n) {
        S.player.tempStrength += n;
        log('本回合获得 ' + n + ' 点力量（回合结束消失）', 'buff');
        floatText(playerAvatar, '力量+' + n, 'is-buff');
        renderPlayer();
      },
      tempDexterity: function (n) {
        S.player.tempDexterity += n;
        log('本回合获得 ' + n + ' 点敏捷（回合结束消失）', 'buff');
        floatText(playerAvatar, '敏捷+' + n, 'is-buff');
        renderPlayer();
      },
      manaBurst: function (n) {
        /* 临时费用突破：可超出费用上限，仅本回合有效 */
        S.player.mana += Math.max(0, Math.round(n));
        log('本回合费用 +' + n + '（可超出上限 ' + manaCap() + '）', 'buff');
        renderHud();
      },
      /* —— 闪避 / 反震 / 吸血 —— */
      dodge: function (n) {
        S.player.dodge = Math.max(0, S.player.dodge + Math.max(0, Math.round(n)));
        log('获得 ' + n + ' 层闪避（当前 ' + S.player.dodge + ' 层）', 'block');
        floatText(playerAvatar, '闪避+' + n, 'is-block');
        renderPlayer();
      },
      thorns: function (n) {
        S.player.thorns += Math.max(0, Math.round(n));
        log('获得 ' + n + ' 点荆棘（当前 ' + S.player.thorns + '）', 'block');
        renderPlayer();
      },
      reflect: function (pct) {
        S.player.reflectPct += pct;
        log('反震比例 +' + Math.round(pct * 100) + '%（当前 ' + Math.round(S.player.reflectPct * 100) + '%）', 'block');
        renderPlayer();
      },
      lifesteal: function (pct) {
        S.player.lifesteal += pct;
        log('吸血 +' + Math.round(pct * 100) + '%（当前 ' + Math.round(S.player.lifesteal * 100) + '%）', 'buff');
        renderPlayer();
      },
      stripBlock: function () {
        var b = S.enemy.block || 0;
        S.enemy.block = 0;
        log('清空敌人 ' + b + ' 点格挡', 'block');
        renderEnemy();
      },
      /* —— 长期成长：永久提升上限 —— */
      maxHpUp: function (n) {
        var add = Math.max(0, Math.round(n));
        S.player.maxHp += add;
        log('生命上限 +' + add + '（当前 ' + S.player.maxHp + '）', 'win');
        floatText(playerAvatar, '上限+' + add, 'is-heal');
        renderPlayer();
      },
      manaCapUp: function (n) {
        S.player.manaCapBonus += Math.max(0, Math.round(n));
        log('费用上限 +' + n + '（当前 ' + manaCap() + '）', 'win');
        renderHud();
      },
      /* —— 血量上限消耗：返回实际消耗量，供卡牌判断是否继续结算 —— */
      spendMaxHp: function (n) {
        var want = Math.max(0, Math.round(n));
        var real = Math.min(want, Math.max(0, S.player.maxHp - 1));
        if (real <= 0) {
          log('生命上限已见底，无法献祭', 'mute');
          return 0;
        }
        S.player.maxHp -= real;
        if (S.player.hp > S.player.maxHp) S.player.hp = S.player.maxHp;
        S.player.hpSpent += real;
        log('消耗 ' + real + ' 点生命上限（剩余上限 ' + S.player.maxHp + '）', 'dmg');
        floatText(playerAvatar, '上限-' + real);
        if (S.core === 'sacrifice') {
          var gain = Math.max(0, Math.round(real * CONFIG.sacStrengthPerHp));
          if (gain > 0) {
            S.player.strength += gain;
            log('血契：力量 +' + gain, 'buff');
          }
          var back = Math.max(0, Math.round(real * CONFIG.sacHealPerHp));
          if (back > 0) healPlayer(back);
          var shield = Math.max(0, Math.round(real * CONFIG.sacBlockPerHp));
          if (shield > 0) {
            S.player.block += shield;
            log('血盾：格挡 +' + shield, 'buff');
          }
        }
        renderPlayer();
        return real;
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
    S.core = null;
    S.skipManaPending = 0;
    S.engineCounter = 0;
    S.player = {
      hp: Math.round(CONFIG.playerHp), maxHp: Math.round(CONFIG.playerHp), block: 0,
      mana: Math.min(manaCap(), manaBase()), strength: 0, dexterity: 0,
      poison: 0, weak: 0, vulnerable: 0,
      tempStrength: 0, tempDexterity: 0,
      dodge: 0, dodgeStreak: 0, dodgeUsedThisTurn: 0, thorns: 0, reflectPct: 0, lifesteal: 0,
      manaCapBonus: 0, hpSpent: 0
    };
    /* 限量卡剩余次数与本局已移除的限量卡，每局重置 */
    S.useLeft = {};
    S.exhausted = [];
    S.deck = buildStartDeck();
    S.deck.forEach(function (id) { initUses(id); });
    S.hand = [];
    S.drawPile = [];
    S.discard = [];
    S.priority = {};
    S.reward = [];
    S.stats = { cardsPlayed: 0, damageDealt: 0, damageTaken: 0, waves: 0, turns: 0, exhausted: 0 };
    handSig = '';
    $('rg-pausemask').hidden = true;
    hideModal('rg-reward');
    hideModal('rg-over');
    hideModal('rg-deck');
    hideModal('rg-core');
    clearLog();
    log('新的一局开始：初始卡组 ' + S.deck.length + ' 张，生命 ' + S.player.maxHp, 'win');
    /* 构筑核心：choose 手动选 / random 随机 / none 不启用（见 01 段配置） */
    /* 每局开局重新抽取候选核心，同一局内不重复；重开一局即重新随机 */
    corePool = shuffle(CORE_ORDER.slice()).slice(0, Math.min(CORE_PICK_COUNT, CORE_ORDER.length));
    if (CONFIG.coreMode === 'random') {
      setCore(pick(CORE_ORDER.slice()));
      startWave();
    } else if (CONFIG.coreMode === 'none') {
      log('未启用构筑核心，自由构筑', 'mute');
      startWave();
    } else {
      S.phase = 'core';
      renderAll();
      renderCorePick();
      showModal('rg-core');
    }
  }

  /* 设定本局构筑核心（null = 不使用核心） */
  function setCore(key) {
    S.core = (key && CORES[key]) ? key : null;
    var core = S.core ? CORES[S.core] : null;
    if (core) log('构筑核心：' + core.name + ' · ' + core.tag + '（' + core.desc + '）', 'win');
    renderHud();
  }

  function pickCore(key) {
    if (S.phase !== 'core') return;
    setCore(key);
    hideModal('rg-core');
    S.phase = 'battle';
    startWave();
  }

  function renderCorePick() {
    var grid = $('rg-core-grid');
    if (!grid) return;
    /* 兜底：若本局候选池尚未生成（异常路径），现抽一次并固定在本局 */
    if (!corePool.length) {
      corePool = shuffle(CORE_ORDER.slice()).slice(0, Math.min(CORE_PICK_COUNT, CORE_ORDER.length));
    }
    grid.innerHTML = '';
    corePool.forEach(function (key) {
      var c = CORES[key];
      if (!c) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rg-core-card';
      btn.setAttribute('data-core', key);
      btn.innerHTML = '<div class="rg-core-name">' + escapeHtml(c.name) + '</div>' +
        '<div class="rg-core-tag">' + escapeHtml(c.tag) + '</div>' +
        '<div class="rg-core-desc">' + escapeHtml(c.desc) + '</div>';
      btn.addEventListener('click', function () { pickCore(key); });
      grid.appendChild(btn);
    });
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
    /* 流派状态的战斗内部分每波清零；长期成长（生命上限/费用上限/吸血）跨波保留 */
    S.player.tempStrength = 0;
    S.player.tempDexterity = 0;
    S.player.dodge = 0;
    S.player.dodgeUsedThisTurn = 0;
    S.player.dodgeStreak = 0;
    S.player.thorns = 0;
    S.player.reflectPct = 0;
    /* 磐石核心：每波开局自带基础荆棘，格挡反击流不依赖起手摸到荆棘牌 */
    if (S.core === 'bulwark') S.player.thorns += Math.round(CONFIG.coreThorns);
    /* 血祭核心：每波开始回补一部分被献祭的生命上限，避免上限被抽干后整局失能 */
    if (S.core === 'sacrifice' && CONFIG.sacWaveMaxHp > 0) {
      var rebate = Math.max(0, Math.round(CONFIG.sacWaveMaxHp));
      if (rebate > 0) {
        S.player.maxHp += rebate;
        S.player.hp = Math.min(S.player.maxHp, S.player.hp + rebate);
        log('血契回补：生命上限 +' + rebate + '（当前 ' + S.player.maxHp + '）', 'win');
      }
    }
    S.engineCounter = 0;
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
    var atk = Math.round((CONFIG.enemyAtkBase + CONFIG.enemyAtkGrow * (wave - 1)) *
      Math.pow(CONFIG.enemyAtkMul, wave - 1) * mul * 0.82);
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

  /* 多段攻击段数：达到起始波次后按概率拆分，首领可满段、精英最多 3 段、普通敌人最多 2 段 */
  function rollAttackHits() {
    var maxHits = Math.max(1, Math.round(CONFIG.multiHitMax));
    var startWave = Math.max(1, Math.round(CONFIG.multiHitStart));
    var chance = Number(CONFIG.multiHitChance);
    if (maxHits < 2 || !(chance > 0) || !(S.wave >= startWave)) return 1;
    if (Math.random() >= chance) return 1;
    var e = S.enemy || {};
    var cap = maxHits;
    if (!e.isBoss) cap = Math.min(cap, e.isElite ? 3 : 2);
    return Math.max(2, cap);
  }

  /* 生成攻击意图：多段时按总量逐段递增分配，每段略低于原单段伤害 */
  function makeAttackIntent(base) {
    var hits = rollAttackHits();
    if (hits <= 1) return { kind: 'attack', value: base, hits: 1 };
    var mul = Number(CONFIG.multiHitTotalMul);
    if (!(mul > 0)) mul = 1;
    var total = Math.max(hits, Math.round(base * mul));
    var per = Math.floor(total / hits);
    var rest = total - per * hits;
    var segs = [];
    for (var i = 0; i < hits; i++) segs.push(per + (i >= hits - rest ? 1 : 0));
    return { kind: 'attack', value: segs[0], hits: hits, segs: segs };
  }

  function rollIntent() {
    var e = S.enemy;
    var base = Math.max(1, Math.round(e.atk * (0.85 + Math.random() * 0.35)));
    var r = Math.random();
    if (e.isBoss) {
      if (r < 0.66) return makeAttackIntent(base);
      if (r < 0.84) return { kind: 'charge', value: 2 };
      return { kind: 'defend', value: Math.max(4, Math.round(e.maxHp * 0.08)) };
    }
    if (r < 0.7) return makeAttackIntent(base);
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
    /* 格挡衰减：磐石反击流保留一半格挡，其余流派清零 */
    if (CONFIG.blockDecay) {
      S.player.block = (S.core === 'bulwark') ? Math.floor(S.player.block * CONFIG.bulwarkKeep) : 0;
    }
    /* 磐石压制：回合开始用留存格挡直接冲击敌人，把格挡转成实伤（格挡反击流的主动输出手段） */
    if (S.core === 'bulwark' && CONFIG.bulwarkTempoPct > 0 && S.player.block > 0 && S.enemy.hp > 0) {
      var tempo = Math.round(S.player.block * CONFIG.bulwarkTempoPct);
      if (tempo > 0) {
        log('磐石压制：以 ' + tempo + ' 点格挡化作冲击', 'block');
        directEnemyDamage(tempo);
      }
    }
    /* 蚀骨掌控：回合开始按敌人中毒层数换取格挡，缓解叠毒期间的暴毙风险 */
    if (S.core === 'control' && CONFIG.poisonBlockPct > 0 && S.enemy.poison > 0) {
      var pshield = Math.round(S.enemy.poison * CONFIG.poisonBlockPct);
      var pcap = Math.round(S.enemy.maxHp * CONFIG.poisonBlockCap);
      if (pcap > 0) pshield = Math.min(pshield, pcap);
      if (pshield > 0) {
        S.player.block += pshield;
        log('毒雾护体：中毒层数换取 ' + pshield + ' 点格挡', 'block');
      }
    }
    /* 疾影残像：每回合开始自动获得闪避层（层数不设上限，仅限制每回合可闪避次数） */
    S.player.dodgeUsedThisTurn = 0;
    if (S.core === 'dodge' && CONFIG.dodgePerTurn > 0) {
      var every = Math.max(1, Math.round(CONFIG.dodgeEvery));
      if ((Math.max(1, S.turn) - 1) % every === 0) {
        var gainD = Math.round(CONFIG.dodgePerTurn);
        var roundCapD = Math.max(1, Math.round(CONFIG.dodgePerRoundCap));
        S.player.dodge += gainD;
        log('疾影：闪避 +' + gainD + '（当前 ' + S.player.dodge + ' 层，本回合可闪避 ' + roundCapD + ' 次）', 'block');
      }
    }
    /* 回合开始费用 = 本回合基础费用 + 上回合结束时的剩余费用，累加后不超过费用上限（溢出上限部分丢弃） */
    var cap = manaCap();
    var base = manaBase();
    if (S.core === 'engine') base += Math.round(CONFIG.engineMana);
    var carry = Math.max(0, Math.round(S.carryMana));
    S.player.mana = Math.min(cap, base + carry);
    var carried = Math.min(carry, Math.max(0, S.player.mana - manaBase()));
    S.carryMana = 0;
    /* 跳过奖励的补偿：额外恢复费用，可突破费用上限 */
    var skipBonus = Math.max(0, Math.round(S.skipManaPending));
    if (skipBonus > 0) {
      S.player.mana += skipBonus;
      S.skipManaPending = 0;
      log('跳过奖励补偿：本回合额外 +' + skipBonus + ' 费用', 'win');
    }
    S.playedThisTurn = 0;
    var got = drawCards(Math.round(CONFIG.handSize));
    S.stats.turns++;
    log('—— 第 ' + S.turn + ' 回合 · 费用 ' + S.player.mana + ' / ' + cap + (carried > 0 ? ' · 结转 +' + carried : '') + (skipBonus > 0 ? ' · 跳过补偿 +' + skipBonus : '') + ' · 抽 ' + got + ' 张 ——', 'turn');
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
    /* 血祭类卡：生命上限见底时停止自伤，血契核心下优先打出 */
    if (c.sac) {
      if (S.player.maxHp <= c.sac + 3) v = 0.5;
      else if (S.player.maxHp <= 24) v -= 10;
      if (S.core === 'sacrifice') v += 6;
    }
    /* 血爆：伤害与格挡都取决于本局已消耗的生命上限 */
    if (id === 'bloodnova' && S.player.hpSpent <= 0) v = 0.5;
    if (id === 'bloodnova') v = Math.min(30, Math.max(v, 4 + S.player.hpSpent));
    if (S.core === 'engine' && c.cost === 0) v += 4;
    if (c.type === 'attack') {
      var predict = v + S.player.strength + (S.player.tempStrength || 0);
      if (predict >= e.hp + (e.block || 0)) v += 140;
    } else if (c.type === 'defense') {
      var need = incomingDamage() - S.player.block;
      /* 格挡能留存（磐石反击）或血量告急时仍值得堆，否则纯堆盾价值大幅缩水 */
      var keepWorth = (S.core === 'bulwark') || (S.player.hp < S.player.maxHp * 0.35);
      if (need > 0) {
        v += Math.min(v, need) * 0.7 + 6;
      } else if (c.pureBlock) {
        /* 已有格挡已覆盖敌方本次攻击总伤害：纯格挡卡默认不出。
           唯一例外：磐石反击流的格挡可跨回合留存，在血量健康（≥60%）且出牌后仍富余 1 费时保留少量价值 */
        var surplus = S.player.mana - c.cost >= 1;
        var healthy = S.player.hp >= S.player.maxHp * 0.6;
        var attackNow = !!(e.intent && e.intent.kind === 'attack');
        v = (S.core === 'bulwark' && healthy && surplus && attackNow) ? 1.5 : -1;
      } else {
        /* 附带其它效果（伤害/抽牌/回血/敏捷/闪避/生命上限等）的格挡卡仍有价值，仅小幅下调 */
        v = keepWorth ? v : v * 0.7;
      }
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
      /* 评分不为正说明当前打出没有实际收益（格挡已溢出、满血治疗等），宁可留着 */
      if (sc <= 0) continue;
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    return best;
  }

  /* 限量卡：useLimit 为空表示可无限循环使用，有值时从本局开局按满次数计 */
  function useLimitOf(card) {
    var lim = card ? Math.round(card.useLimit || 0) : 0;
    return lim > 0 ? lim : 0;
  }

  function useLeftOf(id) {
    var lim = useLimitOf(CARDS[id]);
    if (!lim) return Infinity;
    var left = S.useLeft ? S.useLeft[id] : undefined;
    if (typeof left !== 'number' || left > lim) return lim;
    return left;
  }

  function initUses(id) {
    var lim = useLimitOf(CARDS[id]);
    if (!lim) return;
    if (!S.useLeft) S.useLeft = {};
    if (typeof S.useLeft[id] !== 'number' || S.useLeft[id] > lim) S.useLeft[id] = lim;
  }

  /* 次数用尽：把该卡从本局卡组（牌库/手牌/弃牌堆/卡组）全部永久移除 */
  function exhaustCard(id) {
    var name = (CARDS[id] && CARDS[id].name) || id;
    var removed = 0;
    function strip(arr) {
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] === id) removed++;
        else out.push(arr[i]);
      }
      return out;
    }
    S.deck = strip(S.deck || []);
    S.drawPile = strip(S.drawPile || []);
    S.discard = strip(S.discard || []);
    S.hand = strip(S.hand || []);
    if (S.useLeft) delete S.useLeft[id];
    S.stats.exhausted = (S.stats.exhausted || 0) + 1;
    if (S.exhausted && S.exhausted.indexOf(id) < 0) S.exhausted.push(id);
    handSig = '';
    log('「' + name + '」使用次数已用尽，从本局卡组永久移除' +
      (removed > 0 ? '（同名牌 ' + removed + ' 张）' : ''), 'bad');
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
    /* 限量卡：扣一次使用次数，用满即永久移出本局卡组；普通卡照旧回弃牌堆 */
    var lim = useLimitOf(card);
    if (lim > 0) {
      initUses(id);
      S.useLeft[id] = Math.max(0, useLeftOf(id) - 1);
      if (S.useLeft[id] > 0) {
        log('「' + card.name + '」剩余使用次数 ' + S.useLeft[id] + ' / ' + lim);
      }
    }
    if (lim > 0 && (S.useLeft[id] || 0) <= 0) exhaustCard(id);
    else S.discard.push(id);
    /* 涌动循环核心：每打出 N 张牌回复生命（回费抽卡回血流的续航来源） */
    if (S.core === 'engine') {
      S.engineCounter++;
      var every = Math.max(1, Math.round(CONFIG.engineCards));
      if (S.engineCounter % every === 0) {
        var eh = Math.max(0, Math.round(CONFIG.engineHeal));
        if (eh > 0 && S.player.hp > 0) healPlayer(eh);
      }
    }
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
      var segs = intentSegmentDamage(it);
      var total = 0;
      var si;
      for (si = 0; si < segs.length; si++) total += segs[si];
      if (segs.length > 1) {
        log('「' + e.name + '」发动 ' + segs.length + ' 段攻击：每段约 ' + segs[0] +
          ' 点（合计 ' + total + ' 伤害）', 'enemy');
      } else {
        log('「' + e.name + '」发动攻击：' + total + ' 点伤害', 'enemy');
      }
      /* 逐段结算：每回合最多闪避 roundCap 次，每段消耗一层；超过次数则本回合剩余段数无法闪避 */
      var roundDodgeCap = Math.max(1, Math.round(CONFIG.dodgePerRoundCap));
      for (si = 0; si < segs.length; si++) {
        if (S.player.hp <= 0) break;
        if (S.player.dodge > 0 && (S.player.dodgeUsedThisTurn || 0) < roundDodgeCap) {
          S.player.dodge--;
          S.player.dodgeUsedThisTurn = (S.player.dodgeUsedThisTurn || 0) + 1;
          log('闪避成功！躲开第 ' + (si + 1) + '/' + segs.length +
            ' 段攻击（剩余 ' + S.player.dodge + ' 层，本回合第 ' + S.player.dodgeUsedThisTurn + '/' + roundDodgeCap + ' 次）', 'win');
          floatText(playerAvatar, '闪避', 'is-block');
          if (S.core === 'dodge') {
            /* 疾影反击：闪避成功可连续累加，越闪越痛（本波内累计，换波重置） */
            S.player.dodgeStreak = (S.player.dodgeStreak || 0) + 1;
            var streakAdd = Math.min(CONFIG.dodgeStreakCap, Math.max(0, S.player.dodgeStreak - 1) * CONFIG.dodgeStreakBonus);
            var counter = Math.round(CONFIG.dodgeCounter + CONFIG.dodgeCounterDex * S.player.dexterity +
              e.maxHp * CONFIG.dodgeCounterHpPct + streakAdd);
            if (counter > 0) {
              log('疾影反击：对「' + e.name + '」造成 ' + counter + ' 点伤害（连击 ' + S.player.dodgeStreak + '）', 'dmg');
              directEnemyDamage(counter);
            }
          }
        } else {
          dealToPlayer(segs[si], { index: si, count: segs.length });
        }
      }
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
      if (S.core === 'control') {
        ep = Math.round(ep * CONFIG.poisonTickMul) + Math.round(S.enemy.maxHp * CONFIG.poisonHpPct);
      }
      S.enemy.hp = Math.max(0, S.enemy.hp - ep);
      log('敌人中毒发作：受到 ' + ep + ' 点伤害（剩余 ' + S.enemy.hp + '）', 'dmg');
      floatText(enemyAvatar, '-' + ep);
      /* 蚀骨控制流：中毒层数不衰减，持续堆积 */
      if (CONFIG.poisonDecay && S.core !== 'control') S.enemy.poison = Math.max(0, ep - 1);
    }
    if (S.hand.length) {
      S.discard = S.discard.concat(S.hand);
      S.hand = [];
    }
    if (S.player.weak > 0) S.player.weak--;
    if (S.player.vulnerable > 0) S.player.vulnerable--;
    if (S.enemy.weak > 0) S.enemy.weak--;
    if (S.enemy.vulnerable > 0) S.enemy.vulnerable--;
    /* 单轮临时突破到期：临时力量/敏捷清零（费用突破本身随费用清零自然失效） */
    if (S.player.tempStrength || S.player.tempDexterity) {
      log('临时突破结束：力量 -' + S.player.tempStrength + '、敏捷 -' + S.player.tempDexterity, 'mute');
      S.player.tempStrength = 0;
      S.player.tempDexterity = 0;
    }
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
      '最终卡组 <b>' + S.deck.length + '</b> 张' +
      ((S.exhausted || []).length > 0
        ? '<br>次数用尽移除 <b>' + S.exhausted.length + '</b> 张（' +
          S.exhausted.map(function (k) { return (CARDS[k] && CARDS[k].name) || k; }).join('、') + '）'
        : '');
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

  /* 本局核心对应的流派标签（未选核心时为 null） */
  function coreArch() {
    return (S.core && CORES[S.core]) ? CORES[S.core].arch : null;
  }

  /* 流派契合卡池：核心流派 + 通用成长 + 单轮临时突破 */
  function rollCoreCard(arch) {
    var pool = Object.keys(CARDS).filter(function (k) {
      var a = CARDS[k].arch;
      return a === arch || a === 'grow' || a === 'temp';
    });
    return pool.length ? pick(pool) : null;
  }

  function buildReward() {
    var picks = [];
    var need = clamp(Math.round(CONFIG.rewardChoices), 1, 6);
    var arch = coreArch();
    var w = clamp(Number(CONFIG.coreCardWeight) || 0, 0, 10) / 10;
    var guard = 0;
    /* 核心契合卡先固定占一席，保证流派能成型 */
    if (arch && w > 0) {
      var first = rollCoreCard(arch);
      if (first) picks.push(first);
    }
    while (picks.length < need && guard++ < 300) {
      var id = null;
      if (arch && w > 0 && Math.random() < w) id = rollCoreCard(arch);
      else id = rollRewardCard();
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
        '<div class="rg-rarity">' + (RARITY_LABEL[c.rarity] || '') +
        (ARCH_LABEL[c.arch] ? ' · ' + ARCH_LABEL[c.arch] : '') + '</div>' +
        '<div class="rg-cname">' + escapeHtml(c.name) + '</div>' +
        '<div class="rg-ctext">' + escapeHtml(c.text) + '</div>' +
        (useLimitOf(c) > 0 ? '<div class="rg-uses-note">限 ' + useLimitOf(c) + ' 次</div>' : '');
      btn.addEventListener('click', function () { pickReward(id); });
      grid.appendChild(btn);
    });
    var skipBtn = $('rg-reward-skip');
    if (skipBtn) {
      skipBtn.style.display = CONFIG.allowSkip ? '' : 'none';
      skipBtn.textContent = '跳过（下回合 +' + describeSkipBonus() + ' 费用）';
    }
  }

  /* 跳过奖励时可获得的费用补偿：取本轮可选卡中的最高费用，下限 skipManaMin */
  function skipBonusValue() {
    var top = 0;
    (S.reward || []).forEach(function (id) {
      var c = CARDS[id];
      if (c && c.cost > top) top = c.cost;
    });
    return Math.max(Math.round(CONFIG.skipManaMin), top);
  }

  function describeSkipBonus() {
    return skipBonusValue();
  }

  function pickReward(id) {
    if (S.phase !== 'reward') return;
    var card = CARDS[id];
    if (!card) return;
    S.deck.push(id);
    /* 若该卡此前次数用尽被移除，重新获得时视为一张新卡，恢复满次数 */
    if (S.exhausted && S.exhausted.indexOf(id) >= 0) {
      S.exhausted = S.exhausted.filter(function (k) { return k !== id; });
    }
    initUses(id);
    log('获得卡牌「' + card.name + '」加入卡组（当前 ' + S.deck.length + ' 张）', 'win');
    hideModal('rg-reward');
    S.phase = 'battle';
    startWave();
  }

  function skipReward() {
    if (S.phase !== 'reward') return;
    var bonus = skipBonusValue();
    S.skipManaPending = bonus;
    log('跳过本次战利品：下回合额外获得 ' + bonus + ' 点费用（可超出费用上限）', 'win');
    S.reward = [];
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
        '<span class="rg-di-name">' + escapeHtml(c.name) + ' ×' + count[id] +
          (useLimitOf(c) > 0 ? ' · 剩 ' + useLeftOf(id) + ' 次' : '') + '</span>' +
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

    var coreNone = $('rg-core-none');
    if (coreNone) coreNone.addEventListener('click', function () { pickCore(null); });

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

  /* 离线对局模拟钩子：仅当页面显式声明 __RG_TEST 时挂载，不影响正常运行 */
  if (window.__RG_TEST || window.__rgTest) {
    window.__rgDebug = {
      S: S,
      CONFIG: CONFIG,
      CARDS: CARDS,
      CORES: CORES,
      CORE_ORDER: CORE_ORDER,
      CORE_PICK_COUNT: CORE_PICK_COUNT,
      getCorePool: function () { return corePool.slice(); },
      ARCH_LABEL: ARCH_LABEL,
      setCore: setCore,
      pickCore: pickCore,
      newRun: newRun,
      startWave: startWave,
      pickReward: pickReward,
      skipReward: skipReward,
      skipBonusValue: skipBonusValue,
      useLeftOf: useLeftOf,
      incomingDamage: incomingDamage,
      intentHits: intentHits,
      intentSegmentDamage: intentSegmentDamage,
      rollIntent: rollIntent,
      playCardAt: playCardAt,
      scoreCard: scoreCard,
      pickBestCard: pickBestCard,
      doEnemyTurn: doEnemyTurn,
      doTurnStart: doTurnStart,
      renderAll: renderAll,
      dealToPlayer: dealToPlayer,
      /* 选定核心后进入首波（供模拟器使用） */
      beginAfterCore: function () {
        if (S.phase !== 'core') return;
        hideModal('rg-core');
        S.phase = 'battle';
        startWave();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
