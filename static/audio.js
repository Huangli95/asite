/* 音频素材板块前端：选项渲染 → 提交任务 → 轮询进度 → 试听下载 → 列表分页卡片 */
(function () {
  'use strict';

  var state = {
    options: null,
    sel: null,
    submitting: false,
    job: null,
    timer: 0,
    listTimer: 0,
    page: 1
  };

  /* ---------- 播放互斥：同一时刻只让一个音频出声 ---------- */

  /* 当前正在出声的播放器；页面里所有 <audio> 都由下面的捕获监听统一收口 */
  var soloAudio = null;

  function quiet(el) {
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
    } catch (e) { /* 媒体尚未就绪时忽略 */ }
  }

  /* 播放器节点被整块 innerHTML 重建或翻页替换后，声音不该继续飘着 */
  function stopDetachedAudio() {
    if (soloAudio && !document.documentElement.contains(soloAudio)) {
      quiet(soloAudio);
      soloAudio = null;
    }
  }

  function onAnyPlay(ev) {
    var el = ev.target;
    if (!el || el.tagName !== 'AUDIO') return;
    if (soloAudio && soloAudio !== el) quiet(soloAudio);
    soloAudio = el;
  }

  function onAnyStop(ev) {
    if (ev.target === soloAudio) soloAudio = null;
  }

  /* play/pause/ended 都不冒泡，只能走捕获阶段在 document 上统一拦截 */
  document.addEventListener('play', onAnyPlay, true);
  document.addEventListener('pause', onAnyStop, true);
  document.addEventListener('ended', onAnyStop, true);

  function $(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function api(path, opts) {
    return fetch(path, opts || {}).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: '服务返回内容无法解析（HTTP ' + res.status + '）' };
      }).then(function (body) {
        if (!res.ok || body.ok === false) {
          var err = new Error(body.error || ('请求失败（HTTP ' + res.status + '）'));
          err.code = body.code || '';
          throw err;
        }
        return body;
      });
    });
  }

  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n <= 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtSec(sec) {
    var n = Math.round(Number(sec) || 0);
    if (n < 60) return n + ' 秒';
    var m = Math.floor(n / 60);
    var s = n % 60;
    return s ? m + ' 分 ' + s + ' 秒' : m + ' 分钟';
  }

  function fmtLeft(sec) {
    var n = Math.max(0, Math.round(Number(sec) || 0));
    if (n <= 0) return '已过期';
    if (n < 60) return '还剩 ' + n + ' 秒';
    if (n < 3600) return '还剩 ' + Math.floor(n / 60) + ' 分钟';
    var h = Math.floor(n / 3600);
    var m = Math.floor((n % 3600) / 60);
    return '还剩 ' + h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }

  function fmtClock(ts) {
    var n = Number(ts);
    if (!n) return '—';
    var d = new Date(n * 1000);
    function two(v) { return v < 10 ? '0' + v : '' + v; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  /* ---------- 选项渲染 ---------- */

  var GROUPS = [
    { key: 'length', title: '要多长', hint: '越长等得越久', from: 'lengths' },
    { key: 'mood', title: '什么感觉', hint: '决定听起来是高兴还是安静', from: 'moods' },
    { key: 'instrument', title: '用什么乐器', hint: '主旋律的声音', from: 'instruments', wide: true },
    { key: 'speed', title: '快还是慢', hint: '节奏的松紧', from: 'speeds' },
    { key: 'complexity', title: '热闹还是干净', hint: '音多不多、伴奏满不满', from: 'complexities' }
  ];

  function renderFields() {
    var box = $('au-fields');
    var html = GROUPS.map(function (group) {
      var items = state.options[group.from] || [];
      var chips = items.map(function (item) {
        var on = state.sel[group.key] === item.key ? ' is-on' : '';
        return '<button type="button" class="au-chip' + on + '" data-group="' + group.key +
          '" data-value="' + esc(item.key) + '">' + esc(item.label) +
          '<small>' + esc(item.hint || '') + '</small></button>';
      }).join('');
      return '<div class="au-field' + (group.wide ? ' is-wide' : '') + '"><div class="au-group-title">' + esc(group.title) +
        '<em>' + esc(group.hint) + '</em></div><div class="au-chips">' + chips + '</div></div>';
    }).join('');
    box.innerHTML = html;
  }

  function renderToggles() {
    var box = $('au-toggles');
    var items = state.options.toggles || [];
    box.innerHTML = items.map(function (item) {
      var on = state.sel[item.key] ? ' is-on' : '';
      return '<button type="button" class="au-toggle' + on + '" data-toggle="' + esc(item.key) +
        '" title="' + esc(item.hint || '') + '"><i></i>' + esc(item.label) + '</button>';
    }).join('');
  }

  /* 与后端 audio.py 的 estimate_seconds 保持同一套模型：
     时长不超过 60 秒按线性（时长 × 0.45 + 2.5），超过 60 秒按幂律 12 × (sec/30)^1.8，取较大值 */
  function estimateFor(sec) {
    var opts = state.options || {};
    var m = opts.estimate || {};
    var ratio = m.ratio != null ? m.ratio : (opts.estimate_ratio || 0.45);
    var base = m.base != null ? m.base : 2.5;
    var knee = m.knee != null ? m.knee : 60;
    var coef = m.coef != null ? m.coef : 12;
    var ref = m.ref != null ? m.ref : 30;
    var pw = m.pow != null ? m.pow : 1.8;
    var linear = sec * ratio + base;
    if (sec <= knee) return Math.round(linear);
    var power = coef * Math.pow(sec / ref, pw);
    return Math.round(Math.max(linear, power));
  }

  function updateCap() {
    var cap = $('au-cap');
    var cfg = (state.options && state.options.config) || {};
    var length = (state.options.lengths || []).filter(function (x) {
      return x.key === state.sel.length;
    })[0];
    var sec = 0;
    if (length) {
      sec = parseInt(length.key, 10) || 0;
    }
    var est = sec ? estimateFor(sec) : 0;
    var parts = [];
    if (est) parts.push('预计 ' + est + ' 秒左右做好');
    if (cfg.ttl_hours) parts.push('做好后保留 ' + (Math.round(cfg.ttl_hours * 10) / 10) + ' 小时');
    cap.textContent = parts.join(' · ');
  }

  /* ---------- 随便来一段 ---------- */
  function randomize() {
    if (!state.options) return;
    // 抽的时候避开上一次的档位：连点几次也能看出变化
    function pick(list, prevKey) {
      if (!list || !list.length) return '';
      var pool = list;
      if (prevKey && list.length > 1) {
        var rest = list.filter(function (x) { return x.key !== prevKey; });
        if (rest.length) pool = rest;
      }
      return pool[Math.floor(Math.random() * pool.length)].key;
    }
    var prev = state.sel || {};
    var nextSel = {
      length: pick(state.options.lengths, prev.length),
      mood: pick(state.options.moods, prev.mood),
      instrument: pick(state.options.instruments, prev.instrument),
      speed: pick(state.options.speeds, prev.speed),
      complexity: pick(state.options.complexities, prev.complexity)
    };
    (state.options.toggles || []).forEach(function (item) {
      nextSel[item.key] = typeof prev[item.key] === 'boolean' ? prev[item.key] : true;
    });
    state.sel = nextSel;
    renderFields();
    renderToggles();
    updateCap();
    var btn = $('au-lucky');
    if (btn) {
      btn.classList.add('is-hit');
      setTimeout(function () { btn.classList.remove('is-hit'); }, 500);
    }
  }

  /* ---------- 任务状态展示 ---------- */

  function setBadge(text, cls) {
    var badge = $('au-jobstate');
    badge.textContent = text;
    badge.className = 'au-badge' + (cls ? ' ' + cls : '');
  }

  function renderJob(job) {
    state.job = job;
    stopDetachedAudio();
    var box = $('au-jobbox');
    if (!job) {
      box.innerHTML = '<p class="au-empty">上面选好以后点「生成这段音乐」，这里会显示进度。</p>';
      setBadge('等待提交', '');
      return;
    }

    if (job.status === 'queued' || job.status === 'running') {
      var ratio = 0;
      if (job.status === 'running' && job.estimate) {
        ratio = Math.min(95, Math.max(6, (job.elapsed / job.estimate) * 100));
      }
      var line = job.status === 'queued'
        ? '排队中' + (job.queue_position ? '（第 ' + job.queue_position + ' 个）' : '') + '，马上轮到'
        : '正在后台合成，已经做了 ' + job.elapsed + ' 秒' + (job.estimate ? '，预计总共约 ' + job.estimate + ' 秒' : '');
      var bar = job.status === 'queued'
        ? '<div class="au-bar is-wait"><span></span></div>'
        : '<div class="au-bar"><span style="width:' + ratio.toFixed(0) + '%"></span></div>';
      box.innerHTML =
        '<div class="au-job-title">' + esc(job.title) + '</div>' +
        bar +
        '<div class="au-statusline">' + esc(line) + '</div>' +
        '<div class="au-statusline">可以先去做别的，这个页面会自己刷新；同一时间后台最多同时做 ' +
        esc((state.options.config || {}).concurrency || 5) + ' 段。</div>';
      setBadge(job.status === 'queued' ? '排队中' : '生成中', 'is-run');
      return;
    }

    if (job.status === 'done') {
      box.innerHTML =
        '<div class="au-job-title">' + esc(job.title) + '<span class="au-tagline">' +
        esc(fmtSec(job.seconds)) + ' · ' + esc(fmtSize(job.size)) + '</span></div>' +
        '<div class="au-playrow">' +
        '<audio controls preload="none" src="' + esc(job.url) + '"></audio>' +
        '<a class="au-dl" href="' + esc(job.download_url) + '">下载 WAV</a>' +
        '<button type="button" class="au-again" id="au-again">再来一段</button>' +
        '</div>' +
        '<div class="au-statusline">' + esc(fmtLeft(job.expires_in)) + '（' +
        esc(fmtClock(job.expires_at)) + ' 自动删除），想留就先下载。</div>';
      setBadge('做好了', 'is-ok');
      var again = $('au-again');
      if (again) {
        again.addEventListener('click', function () { submit(); });
      }
      return;
    }

    box.innerHTML =
      '<div class="au-job-title">' + esc(job.title) + '</div>' +
      '<div class="au-failmsg">没做成：' + esc(job.error || '原因不明，请换个组合再试') + '</div>' +
      '<div class="au-statusline">换一下心情或时长再点一次就行。</div>';
    setBadge('失败了', 'is-bad');
  }

  function stopPolling() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = 0;
    }
    $('au-submit').disabled = Boolean(state.submitting);
  }

  function pollOnce() {
    var job = state.job;
    if (!job || !job.id) return;
    api('/api/audio/jobs/' + encodeURIComponent(job.id)).then(function (body) {
      var next = body.job;
      renderJob(next);
      if (next.status === 'done' || next.status === 'failed') {
        stopPolling();
        loadList();
        loadStats();
      }
    }).catch(function (err) {
      stopPolling();
      setBadge('查询失败', 'is-bad');
      $('au-jobbox').innerHTML = '<div class="au-failmsg">' + esc(err.message) + '</div>';
    });
  }

  function startPolling() {
    stopPolling();
    state.timer = setInterval(pollOnce, 1000);
  }

  /* ---------- 提交 ---------- */

  function submit() {
    if (state.submitting) return;
    state.submitting = true;
    $('au-submit').disabled = true;
    $('au-submit').textContent = '提交中…';
    var payload = {
      length: state.sel.length,
      mood: state.sel.mood,
      instrument: state.sel.instrument,
      speed: state.sel.speed,
      complexity: state.sel.complexity,
      harmony: !!state.sel.harmony,
      bass: !!state.sel.bass,
      drums: !!state.sel.drums
    };
    api('/api/audio/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (body) {
      state.submitting = false;
      $('au-submit').disabled = false;
      $('au-submit').textContent = '生成这段音乐';
      state.page = 1;
      renderJob(body.job);
      startPolling();
      loadStats();
      focusJob();
    }).catch(function (err) {
      state.submitting = false;
      $('au-submit').disabled = false;
      $('au-submit').textContent = '生成这段音乐';
      setBadge('提交失败', 'is-bad');
      $('au-jobbox').innerHTML = '<div class="au-failmsg">' + esc(err.message) + '</div>';
    });
  }

  /* 提交后把进度区带进视口：本来就在可见范围内就不滚，避免无谓跳动 */
  function focusJob() {
    var card = document.querySelector('.au-jobcard');
    if (!card || !card.getBoundingClientRect) return;
    var rect = card.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (rect.top < 0 || rect.top > vh - 140) {
      if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ---------- 列表（卡片 + 前端分页） ---------- */

  /* 每页固定条数：6 条一行三列排满两行，窄屏自动落成单列 */
  var PAGE_SIZE = 6;
  /* 列表增量刷新：只重建内容真的变了的条目，避免整块 innerHTML 打断正在试听的音频 */
  var listCache = {};
  /* 当前全量（已在渲染前过滤掉未完成的） */
  var listAll = [];

  function paramTags(job) {
    var p = job.params || {};
    var tags = [];
    function add(label, value) {
      if (!value) return;
      tags.push('<span class="au-tag"><i>' + esc(label) + '</i>' + esc(value) + '</span>');
    }
    add('时长', p.length);
    add('乐器', p.instrument);
    add('感觉', p.mood);
    add('快慢', p.speed);
    add('繁简', p.complexity);
    var flags = [];
    if (p.harmony) flags.push('和声');
    if (p.bass) flags.push('低音');
    if (p.drums) flags.push('鼓点');
    tags.push('<span class="au-tag"><i>伴奏</i>' + esc(flags.length ? flags.join(' / ') : '纯净单层') + '</span>');
    return tags.join('');
  }

  function buildItem(job) {
    var wrap = document.createElement('article');
    wrap.className = 'au-item';
    wrap.setAttribute('data-id', job.id);
    wrap.innerHTML =
      '<div class="au-item-top">' +
      '<div class="au-item-title">' + esc(job.title) + '</div>' +
      '<span class="au-left"></span>' +
      '</div>' +
      '<div class="au-item-tags">' + paramTags(job) + '</div>' +
      '<div class="au-item-meta">' + esc(fmtSec(job.seconds)) + ' · ' + esc(fmtSize(job.size)) +
      ' · ' + esc(fmtClock(job.created_at)) + ' 生成' +
      (job.seed == null ? '' : ' · 种子 ' + esc(job.seed)) + '</div>' +
      '<audio controls preload="none" src="' + esc(job.url) + '"></audio>' +
      '<div class="au-item-foot">' +
      '<a class="au-dl" href="' + esc(job.download_url) + '">下载 WAV</a>' +
      '<span class="au-item-tip">试听直接点上面的播放键</span>' +
      '</div>';
    return wrap;
  }

  function touchItem(node, job) {
    var left = node.querySelector('.au-left');
    if (!left) return;
    left.textContent = fmtLeft(job.expires_in);
    left.className = 'au-left' + (job.expires_in < 3600 ? ' is-soon' : '');
  }

  function renderPager(totalPages) {
    var pager = $('au-pager');
    if (!pager) return;
    if (totalPages <= 1) {
      pager.innerHTML = '';
      pager.hidden = true;
      return;
    }
    pager.hidden = false;
    var page = state.page;
    var nums = [];
    if (totalPages <= 7) {
      for (var i = 1; i <= totalPages; i += 1) nums.push(i);
    } else {
      nums.push(1);
      if (page > 3) nums.push('gap');
      var from = Math.max(2, page - 1);
      var to = Math.min(totalPages - 1, page + 1);
      for (var j = from; j <= to; j += 1) nums.push(j);
      if (page < totalPages - 2) nums.push('gap');
      nums.push(totalPages);
    }
    var html = '<button type="button" class="au-pg" data-page="' + (page - 1) + '"' +
      (page <= 1 ? ' disabled' : '') + '>上一页</button>';
    nums.forEach(function (n) {
      if (n === 'gap') {
        html += '<span class="au-pg-gap">…</span>';
        return;
      }
      html += '<button type="button" class="au-pg' + (n === page ? ' is-on' : '') +
        '" data-page="' + n + '">' + n + '</button>';
    });
    html += '<button type="button" class="au-pg" data-page="' + (page + 1) + '"' +
      (page >= totalPages ? ' disabled' : '') + '>下一页</button>';
    pager.innerHTML = html;
  }

  function renderList(jobs) {
    var box = $('au-list');
    var countBox = $('au-count');
    listAll = (jobs || []).filter(function (job) {
      return job.status === 'done';
    });
    if (!listAll.length) {
      listCache = {};
      box.innerHTML = '<p class="au-empty">现在还没有能听的音频素材，上面生成一段试试。</p>';
      countBox.textContent = '一段都没有';
      renderPager(0);
      stopDetachedAudio();
      return;
    }

    var totalPages = Math.max(1, Math.ceil(listAll.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    var start = (state.page - 1) * PAGE_SIZE;
    var slice = listAll.slice(start, start + PAGE_SIZE);
    countBox.textContent = '共 ' + listAll.length + ' 段素材 · 第 ' + state.page + '/' + totalPages + ' 页';

    var next = {};
    var order = slice.map(function (job) {
      var sig = [job.url, job.title, job.seconds, job.size, job.created_at,
        JSON.stringify(job.params || {})].join('|');
      var hit = listCache[job.id];
      var node;
      if (hit && hit.sig === sig && hit.node.parentNode === box) {
        node = hit.node;
      } else {
        node = buildItem(job);
        if (hit && hit.node.parentNode === box) box.replaceChild(node, hit.node);
      }
      touchItem(node, job);
      next[job.id] = { node: node, sig: sig };
      return node;
    });

    /* 顺序变化时才搬节点，位置本来就对的节点不碰，正在播放的 audio 就不会被重置 */
    var cursor = box.firstChild;
    while (cursor && cursor.nodeType !== 1) cursor = cursor.nextSibling;
    order.forEach(function (node) {
      if (node === cursor) {
        cursor = cursor.nextSibling;
        while (cursor && cursor.nodeType !== 1) cursor = cursor.nextSibling;
      } else {
        box.insertBefore(node, cursor);
      }
    });
    while (cursor) {
      var kill = cursor;
      cursor = cursor.nextSibling;
      if (kill.parentNode === box) box.removeChild(kill);
    }
    listCache = next;
    renderPager(totalPages);
    stopDetachedAudio();
  }

  function goPage(page) {
    var totalPages = Math.max(1, Math.ceil(listAll.length / PAGE_SIZE));
    if (page < 1 || page > totalPages || page === state.page) return;
    state.page = page;
    renderList(listAll);
    var card = document.querySelector('.au-listcard');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function loadList() {
    return api('/api/audio/jobs?limit=100').then(function (body) {
      renderList(body.jobs);
      renderStats(body.stats);
    }).catch(function (err) {
      $('au-list').innerHTML = '<div class="au-failmsg">' + esc(err.message) + '</div>';
    });
  }

  function renderStats(cfg) {
    if (!cfg) return;
    var usage = $('au-usage');
    usage.innerHTML =
      '后台同时最多做 ' + esc(cfg.concurrency) + ' 段，其中正在做 ' + esc(cfg.active || 0) +
      ' 段，排队 ' + esc(cfg.queued || 0) + ' 段。<br>' +
      '本地最多存 ' + esc(cfg.max_files) + ' 段，现在有 ' + esc(cfg.available) +
      ' 段；超过上限会先删最早做的那几段。<br>' +
      '每段保留 ' + esc(Math.round((cfg.ttl_hours || 0) * 10) / 10) + ' 小时，到期自动删除。';
    $('au-headmeta').textContent = '后台同时最多 ' + cfg.concurrency + ' 段 · 每段保留 ' +
      (Math.round((cfg.ttl_hours || 0) * 10) / 10) + ' 小时';
    $('au-lifenote').textContent = '每段做好后保留 ' + (Math.round((cfg.ttl_hours || 0) * 10) / 10) +
      ' 小时，本地最多同时存 ' + cfg.max_files + ' 段（超出先删最早的）。';
  }

  function loadStats() {
    return api('/api/audio/options').then(function (body) {
      renderStats(body.config);
    }).catch(function () { /* 统计失败不打扰用户 */ });
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    $('au-fields').addEventListener('click', function (ev) {
      var chip = ev.target.closest ? ev.target.closest('.au-chip') : null;
      if (!chip) return;
      state.sel[chip.getAttribute('data-group')] = chip.getAttribute('data-value');
      renderFields();
      updateCap();
    });

    $('au-toggles').addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.au-toggle') : null;
      if (!btn) return;
      var key = btn.getAttribute('data-toggle');
      state.sel[key] = !state.sel[key];
      renderToggles();
    });

    $('au-submit').addEventListener('click', submit);

    var luckyBtn = $('au-lucky');
    if (luckyBtn) luckyBtn.addEventListener('click', randomize);

    $('au-refresh').addEventListener('click', function () {
      loadList();
      loadStats();
    });

    var pager = $('au-pager');
    if (pager) {
      pager.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.au-pg') : null;
        if (!btn || btn.disabled) return;
        goPage(parseInt(btn.getAttribute('data-page'), 10) || 1);
      });
    }

    $('au-reset').addEventListener('click', function () {
      state.sel = Object.assign({}, state.options.defaults);
      renderFields();
      renderToggles();
      updateCap();
    });
  }

  function init() {
    api('/api/audio/options').then(function (body) {
      state.options = body;
      state.sel = Object.assign({}, body.defaults);
      renderFields();
      renderToggles();
      updateCap();
      renderStats(body.config);
      if (body.config && body.config.script_ok === false) {
        $('au-submit').disabled = true;
        $('au-cap').textContent = '生成脚本没找到，暂时不能提交，请联系管理员检查 assets 目录';
      }
      bind();
      loadList();
      state.listTimer = setInterval(loadList, 15000);
    }).catch(function (err) {
      $('au-fields').innerHTML = '<div class="au-failmsg">选项加载失败：' + esc(err.message) + '</div>';
      $('au-submit').disabled = true;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
