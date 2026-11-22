/* ==========================================================================
   站点主题引擎 · theme.js
   --------------------------------------------------------------------------
   · 手动模式：用户在切换器里选定某个时段，长期固定使用该配色
   · 自动模式（默认）：按「浏览器本地时间」判断当前落在哪个时段，套用对应配色，
     并在跨时段（如 08:59 → 09:00）时自动切换，无需刷新页面
   · 与样式解耦：本文件只往 <html> 上写 data-theme 属性，
     具体配色由 theme.css 的 --t-* 令牌提供
   · 引入方式：放在 <head> 里，且要早于首次绘制，避免主题闪一下再切
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'marvis.site.theme';
  var ATTR = 'data-theme';

  /* 六时段划分：起点含、终点不含，首尾相接覆盖 0-24 点 */
  var PERIODS = [
    { id: 'dawn',      name: '凌晨', start: 0,  end: 5,  range: '00:00-05:00' },
    { id: 'morning',   name: '早上', start: 5,  end: 9,  range: '05:00-09:00' },
    { id: 'noon',      name: '中午', start: 9,  end: 13, range: '09:00-13:00' },
    { id: 'afternoon', name: '下午', start: 13, end: 17, range: '13:00-17:00' },
    { id: 'dusk',      name: '傍晚', start: 17, end: 20, range: '17:00-20:00' },
    { id: 'night',     name: '晚上', start: 20, end: 24, range: '20:00-24:00' }
  ];
  var AUTO = 'auto';
  var DEFAULT_MODE = AUTO;

  /* ------------------------------- 状态 ---------------------------------- */
  var state = {
    mode: DEFAULT_MODE,   /* auto | dawn | morning | noon | afternoon | dusk | night */
    theme: 'noon',        /* 当前实际生效的主题 id（自动模式下随时间变化） */
    timer: null,
    mounted: false,
    memoryStore: null     /* localStorage 不可用时的兜底 */
  };

  var hasStorage = (function () {
    try {
      var k = '__marvis_theme_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function readStored() {
    var raw = null;
    try {
      raw = hasStorage ? window.localStorage.getItem(STORAGE_KEY) : state.memoryStore;
    } catch (e) {
      raw = state.memoryStore;
    }
    return isMode(raw) ? raw : DEFAULT_MODE;
  }

  function writeStored(mode) {
    state.memoryStore = mode;
    if (!hasStorage) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) { /* 隐私模式/配额满：忽略，仅本页生效 */ }
  }

  function isMode(value) {
    if (value === AUTO) return true;
    for (var i = 0; i < PERIODS.length; i++) {
      if (PERIODS[i].id === value) return true;
    }
    return false;
  }

  /* ------------------------------ 时间判定 -------------------------------- */
  function periodAt(date) {
    var d = date || new Date();
    var minutes = d.getHours() * 60 + d.getMinutes();
    for (var i = 0; i < PERIODS.length; i++) {
      var p = PERIODS[i];
      if (minutes >= p.start * 60 && minutes < p.end * 60) return p;
    }
    return PERIODS[PERIODS.length - 1];
  }

  function resolveTheme(mode) {
    return mode === AUTO ? periodAt().id : mode;
  }

  function periodById(id) {
    for (var i = 0; i < PERIODS.length; i++) {
      if (PERIODS[i].id === id) return PERIODS[i];
    }
    return PERIODS[0];
  }

  /* ------------------------------ 应用主题 -------------------------------- */
  function syncMetaColor(themeId) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    var probe = document.getElementById('tm-color-probe');
    if (probe) {
      var val = window.getComputedStyle(probe).getPropertyValue('--t-meta').trim();
      if (val) meta.setAttribute('content', val);
    } else if (themeId === 'dawn' || themeId === 'night' || themeId === 'dusk') {
      meta.setAttribute('content', '#0a0e1c');
    } else {
      meta.setAttribute('content', '#f2f7ff');
    }
  }

  function apply(mode, reason) {
    var nextMode = isMode(mode) ? mode : DEFAULT_MODE;
    var nextTheme = resolveTheme(nextMode);
    var root = document.documentElement;
    var changed = state.theme !== nextTheme || state.mode !== nextMode;

    state.mode = nextMode;
    state.theme = nextTheme;

    root.setAttribute(ATTR, nextTheme);
    root.setAttribute('data-theme-mode', nextMode);
    root.setAttribute('data-theme-period', periodAt().id);
    try { root.style.colorScheme = (['dawn', 'dusk', 'night'].indexOf(nextTheme) >= 0) ? 'dark' : 'only light'; } catch (e) {}

    syncMetaColor(nextTheme);
    syncUI();
    feedProbe();

    if (changed || reason === 'init') {
      try {
        window.dispatchEvent(new CustomEvent('marvis:themechange', {
          detail: { mode: nextMode, theme: nextTheme, reason: reason || 'api' }
        }));
      } catch (e) { /* 老浏览器不支持 CustomEvent 构造：忽略 */ }
    }
  }

  /* 供 syncMetaColor 读取令牌值用的隐藏探针 */
  function feedProbe() {
    if (document.getElementById('tm-color-probe')) return;
    if (!document.body) return;
    var probe = document.createElement('span');
    probe.id = 'tm-color-probe';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;background:var(--t-meta,#ffffff);';
    document.body.appendChild(probe);
  }

  /* -------------------------------- 接口 ---------------------------------- */
  function setMode(mode) {
    if (!isMode(mode)) return;
    writeStored(mode);
    apply(mode, 'user');
  }

  /* 自动模式下的到点检查：只在时段真的变了才写 DOM */
  function tick() {
    if (state.mode !== AUTO) return;
    var nowTheme = periodAt().id;
    if (nowTheme !== state.theme) {
      apply(AUTO, 'auto-tick');
    } else {
      document.documentElement.setAttribute('data-theme-period', nowTheme);
    }
  }

  /* ------------------------------ 切换器 UI ------------------------------- */
  function buildOption(modeId, name, range, isAuto) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tm-opt';
    btn.setAttribute('role', 'option');
    btn.setAttribute('data-mode', modeId);

    var dot = document.createElement('span');
    dot.className = 'tm-dot';
    dot.setAttribute('data-mode', modeId);
    btn.appendChild(dot);

    var label = document.createElement('span');
    label.className = 'tm-name';
    label.textContent = name;
    btn.appendChild(label);

    if (isAuto) {
      var tag = document.createElement('span');
      tag.className = 'tm-cur';
      tag.textContent = '跟随时间';
      btn.appendChild(tag);
    } else {
      var rg = document.createElement('span');
      rg.className = 'tm-range';
      rg.textContent = range;
      btn.appendChild(rg);
    }

    btn.addEventListener('click', function () {
      setMode(modeId);
      closeAll();
    });
    return btn;
  }

  function buildSwitcher() {
    var wrap = document.createElement('div');
    wrap.className = 'tm-switch';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tm-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('title', '切换站点主题');

    var dot = document.createElement('span');
    dot.className = 'tm-dot';
    dot.setAttribute('data-mode', AUTO);
    btn.appendChild(dot);

    var label = document.createElement('span');
    label.className = 'tm-label';
    label.textContent = '主题';
    btn.appendChild(label);

    var caret = document.createElement('span');
    caret.className = 'tm-caret';
    caret.textContent = '▲';
    btn.appendChild(caret);

    var menu = document.createElement('div');
    menu.className = 'tm-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', '站点主题');
    menu.hidden = true;

    var head = document.createElement('p');
    head.className = 'tm-menu-head';
    head.textContent = '主题模式';
    menu.appendChild(head);

    menu.appendChild(buildOption(AUTO, '自动', '', true));
    var sep = document.createElement('div');
    sep.className = 'tm-sep';
    menu.appendChild(sep);
    for (var i = 0; i < PERIODS.length; i++) {
      menu.appendChild(buildOption(PERIODS[i].id, PERIODS[i].name, PERIODS[i].range, false));
    }

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleMenu(wrap);
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  function toggleMenu(wrap) {
    var menu = wrap.querySelector('.tm-menu');
    var btn = wrap.querySelector('.tm-btn');
    var willOpen = menu.hidden;
    closeAll();
    if (willOpen) {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      syncUI();
    }
  }

  function closeAll() {
    var menus = document.querySelectorAll('.tm-menu');
    for (var i = 0; i < menus.length; i++) {
      if (menus[i].hidden) continue;
      menus[i].hidden = true;
      var b = menus[i].parentNode.querySelector('.tm-btn');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  }

  /* 让所有已挂载的切换器跟上当前状态 */
  function syncUI() {
    var wraps = document.querySelectorAll('.theme-slot .tm-switch');
    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      var btn = wrap.querySelector('.tm-btn');
      var dot = btn.querySelector('.tm-dot');
      var label = btn.querySelector('.tm-label');
      var isAuto = state.mode === AUTO;

      dot.setAttribute('data-mode', isAuto ? AUTO : state.theme);
      if (label) {
        label.textContent = isAuto
          ? '自动 · ' + periodById(state.theme).name
          : periodById(state.theme).name;
      }
      btn.setAttribute('aria-label',
        '站点主题：' + (isAuto ? '自动（当前' + periodById(state.theme).name + '）' : periodById(state.theme).name));

      var opts = wrap.querySelectorAll('.tm-opt');
      for (var k = 0; k < opts.length; k++) {
        var om = opts[k].getAttribute('data-mode');
        opts[k].setAttribute('aria-selected', om === state.mode ? 'true' : 'false');
      }
    }
  }

  function mount() {
    var slots = document.querySelectorAll('[data-theme-slot]');
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.getAttribute('data-theme-ready') === '1') continue;
      slot.appendChild(buildSwitcher());
      slot.setAttribute('data-theme-ready', '1');
    }
    state.mounted = slots.length > 0;
    syncUI();
  }

  /* ------------------------------ 事件绑定 -------------------------------- */
  function onGlobalEvents() {
    document.addEventListener('click', function (ev) {
      if (!ev.target.closest || !ev.target.closest('.tm-switch')) closeAll();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc') closeAll();
    });
    /* 页面回到前台 / 重新获得焦点时立刻校正一次（后台标签页定时器可能被节流） */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick();
    });
    window.addEventListener('focus', tick);
    /* 多标签页同步：别的标签改了模式，这边跟着变 */
    window.addEventListener('storage', function (ev) {
      if (ev.key !== STORAGE_KEY) return;
      var next = isMode(ev.newValue) ? ev.newValue : DEFAULT_MODE;
      apply(next, 'storage');
    });
  }

  /* ------------------------------- 启动 ----------------------------------- */
  function boot() {
    var mode = readStored();
    apply(mode, 'init');

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        mount();
        feedProbe();
        syncMetaColor(state.theme);
      });
    } else {
      mount();
      feedProbe();
      syncMetaColor(state.theme);
    }

    /* 每 30 秒查一次是否跨时段；跨时段自动切换 */
    if (state.timer) window.clearInterval(state.timer);
    state.timer = window.setInterval(tick, 30000);

    onGlobalEvents();
  }

  /* 对外接口：给其他脚本（如需要跟着换色的图表）留个口子 */
  window.MarvisTheme = {
    get mode() { return state.mode; },
    get theme() { return state.theme; },
    get period() { return periodAt(); },
    periods: PERIODS,
    setMode: setMode,
    refresh: tick,
    resolve: resolveTheme
  };

  boot();
})();
