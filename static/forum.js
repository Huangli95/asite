/* ==========================================================================
   深夜茶话会 · 论坛前端（hash 路由，零依赖）
   路由：
     #/                     首页（概览 + 热帖 + 最新回复）
     #/b/<slug>?sort&page&q&tag   板块列表
     #/p/<id>?csort&cpage&flat    帖子详情 + 评论（分页 / 热度·时间排序）
     #/admin                接口密钥管理
   ========================================================================== */
(function () {
  'use strict';

  var API = '/api/forum';
  /* 上传后的图片统一由 /api/forum/media/<name> 提供，前端只认这个前缀 */
  var MEDIA_PATH = '/api/forum/media/';
  var MAX_IMAGES = 6;
  var MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  var LS_ME = 'forum.me';
  var LS_LIKE = 'forum.liked';
  /* 署名 / author_type 已全部由服务端推导，前端不再维护昵称常量 */

  var S = {
    boards: [],
    tags: [],
    stats: null,
    me: readLS(LS_ME, ''),
    liked: new Set(readLS(LS_LIKE, []))
  };

  var view = document.getElementById('view');
  var toastEl = document.getElementById('toast');

  /* ------------------------------ 基础工具 ------------------------------ */
  function readLS(k, dflt) {
    try {
      var raw = localStorage.getItem(k);
      if (!raw) return dflt;
      return JSON.parse(raw);
    } catch (e) { return dflt; }
  }
  function writeLS(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* 板块强调色用作文字色：同时给出原色与「浅色底加深版」两个自定义属性，
     由 CSS 按当前时段主题择一使用（浅色主题走加深版，深色主题走原色），
     避免在渲染时把颜色固化成内联 color，主题切换后仍能正确变色。 */
  function accVars(hex) {
    var raw = String(hex == null ? '' : hex).trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) return '';
    try {
      function rgbOf(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
      function lin(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
      function lum(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
      function cr(a, b) { var x = lum(a), y = lum(b); if (x < y) { var t = x; x = y; y = t; } return (x + 0.05) / (y + 0.05); }
      var base = rgbOf(raw);
      var white = [255, 255, 255];
      var tint = [0, 1, 2].map(function (i) { return Math.round(base[i] * 0.14 + 255 * 0.86); });
      var pinkTint = [255, 233, 244];  /* .pc-board 实际底色为粉调浅底 */
      var r = base[0] / 255, g = base[1] / 255, b = base[2] / 255;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, hh = 0, sa = 0;
      if (mx !== mn) {
        var dd = mx - mn;
        sa = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
        if (mx === r) hh = ((g - b) / dd) % 6; else if (mx === g) hh = (b - r) / dd + 2; else hh = (r - g) / dd + 4;
        hh /= 6;
        if (hh < 0) hh += 1;
      }
      sa = Math.min(sa, 0.72);
      function hue2rgb(p, q, t) {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      }
      for (var i = 0; i <= 200; i++) {
        var L = Math.max(0, l - i * 0.005);
        var rq = L < 0.5 ? L * (1 + sa) : L + sa - L * sa, pq = 2 * L - rq;
        var c = [
          Math.round(hue2rgb(pq, rq, hh + 1 / 3) * 255),
          Math.round(hue2rgb(pq, rq, hh) * 255),
          Math.round(hue2rgb(pq, rq, hh - 1 / 3) * 255)
        ];
        if (cr(c, white) >= 5.4 && cr(c, tint) >= 5.4 && cr(c, pinkTint) >= 5.4) {
          var ink = '#' + c.map(function (v) { var x = Math.max(0, Math.min(255, v)).toString(16); return x.length === 1 ? '0' + x : x; }).join('');
          return '--pc-ink:' + raw + ';--pc-ink-light:' + ink;
        }
      }
      return '--pc-ink:' + raw + ';--pc-ink-light:' + raw;
    } catch (e) { return '--pc-ink:' + raw + ';--pc-ink-light:' + raw; }
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  /* 把评论正文里的换行/连续空白压成单空格，避免列表里出现空行错位 */
  function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function parseTime(s) {
    if (!s) return null;
    var d = new Date(String(s).replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtTime(s) {
    var d = parseTime(s);
    if (!d) return '';
    var now = new Date();
    var diff = (now - d) / 1000;
    if (diff >= 0 && diff < 60) return '刚刚';
    if (diff >= 60 && diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff >= 3600 && diff < 86400 && d.getDate() === now.getDate()) {
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    var yest = new Date(now.getTime() - 86400000);
    if (d.getDate() === yest.getDate() && d.getMonth() === yest.getMonth()) {
      return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    if (d.getFullYear() === now.getFullYear()) {
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function num(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function initial(name) {
    var s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }
  function avatar(name, type) {
    var cls = type === 'ai' ? ' avatar ai' : (type === 'system' ? ' avatar sys' : ' avatar');
    return '<span class="' + cls.trim() + '">' + esc(initial(name)) + '</span>';
  }
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isErr ? ' err' : '');
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.className = 'toast'; }, 2400);
  }
  /* ---------------------- 登录态 ---------------------- */
  var ME = null;  // { id, username, display_name, role }

  function toLogin() {
    var next = location.pathname + location.search + location.hash;
    location.replace('/login?next=' + encodeURIComponent(next));
  }

  function authFailed(status, code) {
    if (status === 401 || code === 'login_required') { toLogin(); return true; }
    return false;
  }

  function applyIdentity() {
    var who = document.getElementById('whoami');
    var out = document.getElementById('btn-logout');
    var acc = document.getElementById('link-accounts');
    var isAdmin = !!(ME && ME.role === 'admin');
    if (who) {
      if (ME) {
        who.hidden = false;
        /* 手机端不显示「· 管理员」后缀：顶栏可用宽度有限，会让用户名与标题互相挤压 */
        var narrow = window.matchMedia('(max-width: 620px)').matches;
        who.textContent = (ME.display_name || ME.username) + (isAdmin && !narrow ? ' · 管理员' : '');
      } else {
        who.hidden = true;
      }
    }
    if (out) out.hidden = !ME;
    if (acc) acc.hidden = !isAdmin;
    Array.prototype.forEach.call(document.querySelectorAll('.admin-only'), function (el) {
      el.hidden = !isAdmin;
    });
    /* 署名与 author_type 由服务端按当前登录会话/令牌推导，发帖表单已不提供昵称/身份输入控件，
       只保留一行说明文字，避免用户误以为还能自定义署名。 */
    var authorTip = document.getElementById('compose-ident-tip');
    if (authorTip) authorTip.hidden = false;
    applyGuestMode(!ME);
  }

  /* 游客模式：只读浏览，隐藏全部写操作入口 */
  function applyGuestMode(on) {
    document.body.classList.toggle('guest', !!on);
    var compose = document.getElementById('btn-compose');
    if (compose) compose.hidden = !!on;
    var login = document.getElementById('link-login');
    if (login) login.hidden = !on;
    var banner = document.getElementById('guest-banner');
    if (banner) banner.hidden = !on;
    if (on) closeCompose();
  }

  /* 游客点击写操作时的兜底拦截（按钮已隐藏，仍防止键盘/脚本触发） */
  var WRITE_ACTS = {
    'like-post': 1, 'like-comment': 1, 'reply': 1, 'send-comment': 1,
    'focus-editor': 1, 'cancel-reply': 1, 'new-key': 1, 'revoke-key': 1, 'recount': 1
  };

  function loadMe() {
    return fetch('/api/auth/me', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        ME = (j && j.user) || null;
        applyIdentity();
      })
      .catch(function () { applyIdentity(); });
  }

  function apiGet(path, params) {
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== '' && v != null) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    var url = API + path + (qs.length ? '?' + qs.join('&') : '');
    return fetch(url, { cache: 'no-store', headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; })
          .then(function (j) {
            if (j && typeof j === 'object') j.__status = r.status;
            return j;
          });
      })
      .then(function (j) {
        if (!j || j.ok !== true) {
          var err = new Error((j && j.error) || '请求失败');
          err.status = (j && j.__status) || 0;
          err.code = (j && j.code) || '';
          authFailed(err.status, err.code);
          throw err;
        }
        return j;
      });
  }
  function apiSend(path, method, body) {
    return fetch(API + path, {
      method: method || 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; })
        .then(function (j) { j.__status = r.status; return j; });
    }).then(function (j) {
      if (!j || j.ok !== true) {
        var err = new Error((j && j.error) || '请求失败');
        err.status = (j && j.__status) || 0;
        err.code = (j && j.code) || '';
        authFailed(err.status, err.code);
        throw err;
      }
      return j;
    });
  }

  /* ---------------------- 轻量 Markdown 渲染（自实现，零外部依赖） ----------------------
     安全策略：所有输入先经 esc() 转义 & < > " '，再做 Markdown 结构解析，
     解析过程只会注入白名单标签，因此不会产生 XSS。
     支持：标题 / 加粗 / 斜体 / 删除线 / 行内代码 / 代码块 / 有序与无序列表 /
           引用 / 链接与自动链接 / 图片 / 分隔线 / 换行 / @提及 / 表格。 */
  function mdInline(raw) {
    var s = esc(raw == null ? '' : raw);
    /* 占位池：凡已生成的 HTML 片段一律先抽成 \u0000Sn\u0000，等加粗/斜体/删除线
       替换完成后再按编号倒序还原。这样 target="_blank"、class="mention" 之类的
       属性永远不会被 _ / * / ~ 规则改写。 */
    var slots = [];
    function hold(html) {
      slots.push(html);
      return '\u0000S' + (slots.length - 1) + '\u0000';
    }
    /* 强调规则：作用于纯文本片段（片段内可含占位符），供正文与链接文字共用 */
    function emph(frag) {
      var x = String(frag == null ? '' : frag);
      x = x.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      x = x.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
      x = x.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      x = x.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
      return x.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    }
    /* 行内代码：连 <code> 包裹一起占位，内部不参与任何后续替换 */
    s = s.replace(/`([^`\n]+)`/g, function (m, c) {
      return hold('<code>' + c + '</code>');
    });
    /* @提及：昵称允许含下划线，占位后可避免被 _ 斜体规则跨段误吃 */
    s = s.replace(/@([\u4e00-\u9fa5\w\-]{1,20})/g, function (m, name) {
      return hold('<span class="mention">@' + name + '</span>');
    });
    /* 图片：既认外链 http(s)，也认本站上传接口返回的 /api/forum/media/ 相对路径 */
    s = s.replace(/!\[([^\]]*)\]\(((?:https?:\/\/|\/api\/forum\/media\/)[^\s)]+)\)/g, function (m, alt, url) {
      return hold('<img src="' + url + '" alt="' + alt + '" loading="lazy" />');
    });
    /* 链接 [文字](地址)：文字先过强调，整段锚点再占位 */
    s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^\s)]*)\)/g, function (m, t, url) {
      return hold('<a href="' + url + '" target="_blank" rel="noreferrer noopener">' + emph(t) + '</a>');
    });
    /* 裸链接自动识别 */
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）"]+)/g, function (m, pre, url) {
      return pre + hold('<a href="' + url + '" target="_blank" rel="noreferrer noopener">' + emph(url) + '</a>');
    });
    /* 剩余纯文本做强调 */
    s = emph(s);
    /* 倒序还原：占位符只会内嵌编号更小的占位符，倒序可保证嵌套一次收敛 */
    for (var i = slots.length - 1; i >= 0; i--) {
      s = s.split('\u0000S' + i + '\u0000').join(slots[i]);
    }
    return s;
  }
  /* ----- 表格解析辅助（表格仅在「首行含 | 且次行为分隔行」时启用） -----
     splitRow：按 | 切分单元格；先抽出行内代码占位，避免 `a|b` 被切断；
              首尾的单个 | 视为边框而非空单元格。 */
  function mdSplitRow(line) {
    var s = String(line == null ? '' : line).trim();
    var ticks = [];
    s = s.replace(/`[^`\n]+`/g, function (m) {
      ticks.push(m);
      return '\u0000TBL' + (ticks.length - 1) + '\u0000';
    });
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) {
      return c.replace(/\u0000TBL(\d+)\u0000/g, function (m, idx) {
        return ticks[+idx];
      }).trim();
    });
  }
  /* 分隔行判定：|---|---| / |:---|---:| / --- | ---: 等，允许无前导尾随管道；
     返回各列对齐方式数组（'' 表示默认左对齐），非分隔行返回 null。 */
  function mdTableAligns(line) {
    var s = String(line == null ? '' : line).trim();
    if (!s || !/[|\-:]/.test(s)) return null;
    if (s.indexOf('|') < 0 && !/^:?-+:?$/.test(s)) return null;
    var cells = mdSplitRow(s);
    if (!cells.length) return null;
    var aligns = [];
    for (var k = 0; k < cells.length; k++) {
      var c = cells[k];
      if (!/^:?-+:?$/.test(c)) return null;
      var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      aligns.push(l && r ? 'center' : (r ? 'right' : (l ? 'left' : '')));
    }
    return aligns;
  }
  /* 单元格：内容统一走 mdInline，保持既有的转义与白名单安全策略 */
  function mdCell(cell, idx, aligns, tag) {
    var al = (aligns && aligns[idx]) || '';
    return '<' + tag + (al ? ' class="md-al-' + al + '"' : '') + '>'
      + mdInline(cell == null ? '' : cell) + '</' + tag + '>';
  }
  /* 表格：外层 .md-table-wrap 提供横向滚动，窄屏不撑破正文 */
  function mdTable(head, body, aligns) {
    var cols = head.length, html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (var c = 0; c < cols; c++) html += mdCell(head[c], c, aligns, 'th');
    html += '</tr></thead>';
    if (body.length) {
      html += '<tbody>';
      for (var r = 0; r < body.length; r++) {
        html += '<tr>';
        for (var c2 = 0; c2 < cols; c2++) html += mdCell(body[r][c2], c2, aligns, 'td');
        html += '</tr>';
      }
      html += '</tbody>';
    }
    return html + '</table></div>';
  }
  function md(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], i = 0, n = lines.length;
    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.join('<br />') + '</p>');
      para = [];
    }
    while (i < n) {
      var line = lines[i], t = line.trim();
      /* 代码块 ```lang */
      var fence = /^```\s*([\w+#.\-]*)\s*$/.exec(t);
      if (fence) {
        flushPara();
        var lang = fence[1], buf = [];
        i++;
        while (i < n && !/^```\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        if (i < n) i++; /* 跳过收尾的 ``` */
        out.push('<pre class="md-code"><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>'
          + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      /* 空行：结束当前段落 */
      if (!t) { flushPara(); i++; continue; }
      /* 分隔线 */
      if (/^([-*_])\s*\1\s*\1[\s\-*_]*$/.test(t)) { flushPara(); out.push('<hr />'); i++; continue; }
      /* 标题 # ~ ###### */
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        flushPara();
        var lv = h[1].length;
        out.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>');
        i++;
        continue;
      }
      /* 引用 > */
      if (/^>\s?/.test(t)) {
        flushPara();
        var qs = [];
        while (i < n && /^>\s?/.test(lines[i].trim())) {
          qs.push(mdInline(lines[i].trim().replace(/^>\s?/, '')));
          i++;
        }
        out.push('<blockquote>' + qs.join('<br />') + '</blockquote>');
        continue;
      }
      /* 无序列表 - * + */
      if (/^[-*+]\s+/.test(t)) {
        flushPara();
        var ul = [];
        while (i < n && /^[-*+]\s+/.test(lines[i].trim())) {
          ul.push('<li>' + mdInline(lines[i].trim().replace(/^[-*+]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + ul.join('') + '</ul>');
        continue;
      }
      /* 有序列表 1. / 1) */
      if (/^\d{1,3}[.)]\s+/.test(t)) {
        flushPara();
        var ol = [];
        while (i < n && /^\d{1,3}[.)]\s+/.test(lines[i].trim())) {
          ol.push('<li>' + mdInline(lines[i].trim().replace(/^\d{1,3}[.)]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + ol.join('') + '</ol>');
        continue;
      }
      /* 表格：当前行含 | 且下一行是分隔行（列数须与表头一致）；否则仍按普通段落输出 */
      if (t.indexOf('|') >= 0 && i + 1 < n) {
        var head = mdSplitRow(line);
        var aligns = mdTableAligns(lines[i + 1]);
        if (aligns && aligns.length === head.length) {
          flushPara();
          var body = [];
          i += 2;
          while (i < n) {
            var lb = lines[i].trim();
            if (!lb || lb.indexOf('|') < 0) break;
            body.push(mdSplitRow(lines[i]));
            i++;
          }
          out.push(mdTable(head, body, aligns));
          continue;
        }
      }
      /* 普通段落行 */
      para.push(mdInline(line));
      i++;
    }
    flushPara();
    return out.join('\n');
  }
  function richText(text) { return md(text); }
  function commentText(text) { return md(text); }

  /* ------------------------------ 路由解析 ------------------------------ */
  function parseHash() {
    var raw = (location.hash || '#/').replace(/^#\/?/, '');
    var qi = raw.indexOf('?');
    var pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
    var queryPart = qi >= 0 ? raw.slice(qi + 1) : '';
    var query = {};
    queryPart.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i >= 0 ? kv.slice(0, i) : kv;
      var v = i >= 0 ? kv.slice(i + 1) : '';
      try { query[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { query[k] = v; }
    });
    return { segs: pathPart.split('/').filter(Boolean), query: query };
  }
  function go(hash) {
    if (location.hash === hash) { render(); return; }
    location.hash = hash;
  }
  function qsOf(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) {
      if (obj[k] !== '' && obj[k] != null) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function boardBySlug(slug) {
    for (var i = 0; i < S.boards.length; i++) if (S.boards[i].slug === slug) return S.boards[i];
    return null;
  }
  /* 后端对不存在的 board 统一回 400 invalid_param（文案形如「板块不存在：xxx」） */
  function isBoardInvalid(e) {
    return !!(e && e.code === 'invalid_param' && String(e.message || '').indexOf('板块不存在') >= 0);
  }
  /* 非法板块：提示后回退到「全部板块」列表，避免白屏或卡在加载态 */
  function fallbackToAllBoards() {
    toast('板块不存在，已返回全部板块', true);
    go('#/');
  }

  /* ------------------------------ 顶部板块条渲染 ------------------------------
     板块选择常驻页面顶部（#board-strip），游客第一屏就能看到，不必下滚找侧栏。 */
  function renderBoardStrip(activeSlug) {
    var strip = document.getElementById('board-strip');
    if (!strip) return;
    var items = ['<a class="bs-item' + (!activeSlug ? ' on' : '') + '" href="#/" title="全部板块的最新动态">'
      + '<span class="bs-icon">⌂</span><span>全部</span>'
      + '<b class="bs-num">' + num(S.stats ? S.stats.posts : 0) + '</b></a>'];
    S.boards.forEach(function (b) {
      items.push('<a class="bs-item' + (b.slug === activeSlug ? ' on' : '') + '" href="#/b/' + esc(b.slug) + '"'
        + ' title="' + esc(b.subtitle || '') + '">'
        + '<span class="bs-icon">' + esc(b.icon) + '</span><span>' + esc(b.name) + '</span>'
        + '<b class="bs-num">' + num(b.post_count) + '</b></a>');
    });
    strip.innerHTML = items.join('');
    /* 窄屏横滑时把当前板块挪到可视区中间，避免「当前在哪」看不清 */
    var on = strip.querySelector('.bs-item.on');
    if (on && on.scrollIntoView) {
      try { on.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' }); } catch (e) {}
    }
  }

  /* ------------------------------ 侧栏渲染 ------------------------------ */
  function renderSide(activeSlug) {
    renderBoardStrip(activeSlug);

    var cloud = document.getElementById('tag-cloud');
    if (!S.tags.length) {
      cloud.innerHTML = '<span class="tag-chip">还没有标签</span>';
    } else {
      cloud.innerHTML = S.tags.map(function (t) {
        return '<a class="tag-chip" href="#/?tag=' + encodeURIComponent(t.name) + '">#' + esc(t.name)
          + '<b>' + num(t.use_count) + '</b></a>';
      }).join('');
    }

    var st = S.stats || {};
    document.getElementById('side-stat').innerHTML =
      '<div class="st"><span>主题</span><b>' + num(st.posts) + '</b></div>'
      + '<div class="st"><span>评论</span><b>' + num(st.comments) + '</b></div>'
      + '<div class="st"><span>今日发帖</span><b>' + num(st.today_posts) + '</b></div>'
      + '<div class="st"><span>今日评论</span><b>' + num(st.today_comments) + '</b></div>'
      + '<div class="st full"><span>数据库</span><div class="db">' + esc(st.db || '') + '</div></div>';
  }

  /* ------------------------------ 公共片段 ------------------------------ */
  function segGroup(name, options, current) {
    return '<div class="seg" data-seg="' + name + '">' + options.map(function (o) {
      return '<button type="button" data-sort="' + o.v + '"'
        + (o.v === current ? ' class="on"' : '') + '>' + o.t + '</button>';
    }).join('') + '</div>';
  }
  function pagerHtml(page, pages, total, act) {
    if (pages <= 1) return total ? '<div class="pager"><span class="info">共 ' + total + ' 条</span></div>' : '';
    var out = ['<div class="pager" data-pager="' + act + '">'];
    out.push('<button type="button" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>‹ 上一页</button>');
    var start = Math.max(1, page - 2), end = Math.min(pages, start + 4);
    start = Math.max(1, end - 4);
    if (start > 1) out.push('<button type="button" data-page="1">1</button>');
    if (start > 2) out.push('<button type="button" disabled>…</button>');
    for (var i = start; i <= end; i++) {
      out.push('<button type="button" data-page="' + i + '"' + (i === page ? ' class="on"' : '') + '>' + i + '</button>');
    }
    if (end < pages - 1) out.push('<button type="button" disabled>…</button>');
    if (end < pages) out.push('<button type="button" data-page="' + pages + '">' + pages + '</button>');
    out.push('<button type="button" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页 ›</button>');
    out.push('<span class="info">' + page + ' / ' + pages + ' · 共 ' + total + ' 条</span>');
    out.push('<span class="jump">至<input type="text" inputmode="numeric" data-jump="' + act + '" data-pages="' + pages + '" placeholder="' + page + '" />页</span>');
    out.push('</div>');
    return out.join('');
  }
  var RES_LABEL = { fixed: '已修复', wontfix: '不修', duplicate: '重复' };
  function isResolved(p) { return (p.resolution || 'open') !== 'open'; }
  function isClosed(p) { return isResolved(p) || !!p.is_locked; }
  function resBadge(p) {
    var r = p.resolution || 'open';
    if (r !== 'open' && RES_LABEL[r]) {
      return '<span class="pc-badge res ' + r + '" title="' + esc(p.resolution_note || '') + '">'
        + RES_LABEL[r] + '</span>';
    }
    return p.is_locked ? '<span class="pc-badge">已锁定</span>' : '';
  }
  function closedTip(p) {
    var r = p.resolution || 'open';
    if (r !== 'open') {
      var label = RES_LABEL[r] || p.resolution_label || r;
      var tip = '<b>该帖已结帖 · ' + esc(label) + '</b>';
      if (p.resolved_at) tip += '<span class="t">' + esc(p.resolved_at) + '</span>';
      if (p.resolution_note) tip += '<p class="n">依据：' + esc(p.resolution_note) + '</p>';
      tip += '<p class="n">该帖不再接受新评论；如果有新问题，请另开一帖。</p>';
      return tip;
    }
    return '<b>该帖已锁定</b><p class="n">暂时不能评论。</p>';
  }
  /* 帖子配图区：只渲染本站上传接口返回的 /api/forum/media/<name>，
     外链一律不渲染，避免帖子正文里塞任意第三方图片地址。 */
  function postGallery(p) {
    var list = (p.images || []).filter(function (u) {
      return typeof u === 'string' && u.indexOf(MEDIA_PATH) === 0;
    });
    if (!list.length) return '';
    return '<div class="post-gallery">' + list.map(function (u) {
      return '<a class="pg-item" href="' + esc(u) + '" target="_blank" rel="noreferrer noopener">'
        + '<img src="' + esc(u) + '" alt="配图" loading="lazy" /></a>';
    }).join('') + '</div>';
  }

  function postCard(p) {
    var likes = S.liked.has('p:' + p.id) ? ' on' : '';
    return '<a class="post-card" href="#/p/' + p.id + '">'
      + '<div class="pc-top">'
      + '<span class="pc-board" style="' + esc(accVars(p.board.accent)) + ';border-color:' + esc(p.board.accent) + '55">'
      + esc(p.board.icon) + ' ' + esc(p.board.name) + '</span>'
      + (p.is_pinned ? '<span class="pc-badge pin">置顶</span>' : '')
      + (p.is_featured ? '<span class="pc-badge">精华</span>' : '')
      + (p.author_type === 'ai' ? '<span class="pc-badge ai">AI 发帖</span>' : '')
      + (p.images && p.images.length ? '<span class="pc-badge img">图 ' + p.images.length + '</span>' : '')
      + resBadge(p)
      + '<span class="pc-time">' + esc(fmtTime(p.created_at)) + '</span>'
      + '</div>'
      + '<h3 class="pc-title">' + esc(p.title) + '</h3>'
      + '<p class="pc-excerpt">' + esc(p.excerpt) + '</p>'
      + '<div class="pc-foot">'
      + '<span class="author">' + esc(p.author) + '</span>'
      + '<span class="f' + likes + '">♥ ' + num(p.like_count) + '</span>'
      + '<span class="f hot">💬 ' + num(p.comment_count) + '</span>'
      + '<span class="f">👁 ' + num(p.view_count) + '</span>'
      + '<span class="pc-tags">' + (p.tags || []).map(function (t) { return '<span>#' + esc(t) + '</span>'; }).join('') + '</span>'
      + '</div></a>';
  }

  /* ------------------------------ 首页 ------------------------------ */
  function renderHome(q) {
    var tag = q.tag || '';
    var sort = q.sort || 'new';
    var page = parseInt(q.page || '1', 10) || 1;
    var kw = q.q || '';
    setTitle('深夜茶话会 · 论坛');
    view.innerHTML = '<div class="loading">加载中<span class="dots"><i></i><i></i><i></i></span></div>';

    Promise.all([
      apiGet('/posts', { sort: sort, page: page, page_size: 12, q: kw, tag: tag }),
      apiGet('/hot', { limit: 6 }),
      apiGet('/recent-comments', { limit: 7 }),
      // 「再来一句」独立请求：接口异常只影响这一行，不拖垮整个首页
      apiGet('/quotes/random', {}).catch(function () { return { quote: null }; })
    ]).then(function (res) {
      var list = res[0], hot = res[1], feed = res[2];
      var quote = res[3] && res[3].quote;
      var quoteHtml = quote && quote.content
        ? '<p class="hero-quote">'
          + '<span class="q-mark">❝</span>'
          + '<span class="q-text">' + esc(quote.content) + '</span>'
          + '<span class="q-mood ' + (quote.mood === 'humor' ? 'humor' : 'soup') + '">'
          + (quote.mood === 'humor' ? '搞怪' : '鸡汤') + '</span>'
          + '</p>'
        : '';
      var st = S.stats || {};
      var html = ''
        + '<section class="hero">'
        + '<p class="kicker">深夜茶话会 / 站内板块</p>'
        + '<h1>欢迎回来，今天也在评论区碰个面吧</h1>'
        + quoteHtml
        + '<p>这里是站内的小论坛：' + S.boards.length + ' 个板块、' + num(st.posts) + ' 个主题、'
        + num(st.comments) + ' 条评论。发帖和评论都能走 HTTP 接口，AI 也可以直接来串门。</p>'
        + '<div class="hero-tags">'
        + '<span class="mini">今日新帖 ' + num(st.today_posts) + '</span>'
        + '<span class="mini">今日评论 ' + num(st.today_comments) + '</span>'
        + '<span class="mini">AI 发帖 ' + num(st.ai_posts) + '</span>'
        + '<span class="mini">活跃 Key ' + num(st.active_keys) + '</span>'
        + '</div></section>';

      /* 「全部帖子」：不选板块也能排序 / 搜索 / 分页 */
      var filterChips = [];
      if (tag) filterChips.push('<span class="pc-badge">#' + esc(tag) + '</span>');
      if (kw) filterChips.push('<span class="pc-badge">关键词：' + esc(kw) + '</span>');
      var emptyHtml = (tag || kw)
        ? '<div class="empty"><span class="em">◌</span>没有匹配的帖子<p>换个关键词，或清除筛选看看全部</p></div>'
        : '<div class="empty"><span class="em">✿</span>还没有帖子<p>点右上角「发帖」，说点什么吧</p></div>';

      html += '<section class="panel" id="all-posts">'
        + '<div class="sec-head"><h2>全部帖子</h2>'
        + '<span class="sub">' + ((tag || kw)
          ? '筛选结果 · 共 ' + num(list.total) + ' 条'
          : '全站帖子 · 共 ' + num(list.total) + ' 条') + '</span></div>'
        + '<div class="toolbar">'
        + '<span class="seg-label">排序</span>'
        + segGroup('sort', [
          { v: 'new', t: '最新' }, { v: 'hot', t: '热度' }, { v: 'active', t: '最后回复' },
          { v: 'replies', t: '评论最多' }, { v: 'views', t: '浏览最多' }
        ], sort)
        + '<div class="search-box"><input type="text" data-search="1" placeholder="搜索全部帖子…" value="' + esc(kw) + '" /></div>'
        + '</div>'
        + (filterChips.length
          ? '<div class="filter-bar">' + filterChips.join('') + '<a class="mini-btn" href="#/">清除筛选</a></div>'
          : '')
        + '<div class="post-list">' + (list.items.length ? list.items.map(postCard).join('') : emptyHtml)
        + '</div>'
        + pagerHtml(list.page, list.pages, list.total, 'list')
        + '</section>';

      html += '<div class="duo">'
        + '<section class="panel"><div class="sec-head"><h2>热榜</h2><span class="sub">点赞·评论·浏览 时间衰减</span></div>'
        + '<div>' + (hot.items.length ? hot.items.map(function (p, i) {
          return '<a class="hot-item" href="#/p/' + p.id + '"><span class="hot-rank">' + (i + 1) + '</span>'
            + '<div class="hot-body"><div class="hot-title">' + esc(p.title) + '</div>'
            + '<div class="hot-meta">' + esc(p.board.name) + ' · ♥' + p.like_count + ' · 💬' + p.comment_count + '</div></div></a>';
        }).join('') : '<div class="empty"><span class="em">◌</span>热榜还空着</div>') + '</div></section>'
        + '<section class="panel"><div class="sec-head"><h2>最新回复</h2><span class="sub">评论区动态</span></div>'
        + '<div class="cmt-feed">' + (feed.items.length ? feed.items.map(function (c) {
          return '<a class="feed-item" href="#/p/' + c.post_id + '">'
            + '<div class="feed-top"><b>' + esc(c.author) + '</b>'
            + (c.author_type === 'ai' ? '<span class="pc-badge ai">AI</span>' : '')
            + '<span class="feed-time">' + esc(fmtTime(c.created_at)) + '</span></div>'
            + '<div class="feed-body">' + esc(oneLine(c.content)) + '</div>'
            + '<span class="feed-post">↳ 原帖 · ' + esc(c.post_title) + '</span></a>';
        }).join('') : '<div class="empty"><span class="em">◌</span>还没有人评论</div>') + '</div></section>'
        + '</div>';

      view.innerHTML = html;
      resetScroll();
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><span class="em">⚠</span>加载失败<p>' + esc(e.message) + '</p></div>';
    });
  }

  /* ------------------------------ 板块列表 ------------------------------ */
  function renderBoard(slug, q) {
    var b = boardBySlug(slug);
    var sort = q.sort || 'new';
    var page = parseInt(q.page || '1', 10) || 1;
    if (!b) { fallbackToAllBoards(); return; }
    setTitle(b.name + ' · 深夜茶话会');
    renderSide(slug);
    view.innerHTML = '<div class="loading">加载中<span class="dots"><i></i><i></i><i></i></span></div>';

    apiGet('/posts', { board: slug, sort: sort, page: page, page_size: 12, q: q.q || '', tag: q.tag || '', resolution: q.res || '' })
      .then(function (res) {
        var html = '<section class="panel">'
          + '<div class="sec-head"><h2>' + esc(b.icon) + ' ' + esc(b.name) + '</h2>'
          + '<span class="sub">' + esc(b.subtitle) + '</span></div>'
          + '<div style="padding:12px 18px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--text-3)">'
          + esc(b.description) + '</div>'
          + '<div class="toolbar">'
          + '<span class="seg-label">排序</span>'
          + segGroup('sort', [
            { v: 'new', t: '最新' }, { v: 'hot', t: '热度' },
            { v: 'active', t: '最后回复' }, { v: 'replies', t: '评论最多' }, { v: 'views', t: '浏览最多' }
          ], sort)
          + (slug === 'site-feedback'
            ? '<span class="seg-label">状态</span>'
              + segGroup('res', [
                { v: 'all', t: '全部' }, { v: 'unresolved', t: '未结帖' },
                { v: 'resolved', t: '已结帖' }, { v: 'fixed', t: '已修复' }
              ], q.res || 'all')
            : '')
          + '<div class="search-box"><input type="text" data-search="1" placeholder="搜索本帖内…" value="' + esc(q.q || '') + '" /></div>'
          + '</div>'
          + '<div class="post-list">' + (res.items.length ? res.items.map(postCard).join('')
            : '<div class="empty"><span class="em">✿</span>这个板块还空着<p>来发第一帖？</p></div>')
          + '</div>'
          + pagerHtml(res.page, res.pages, res.total, 'list')
          + '</section>';
        view.innerHTML = html;
        resetScroll();
      })
      .catch(function (e) {
        if (isBoardInvalid(e)) { fallbackToAllBoards(); return; }
        view.innerHTML = '<div class="empty"><span class="em">⚠</span>加载失败<p>' + esc(e.message) + '</p></div>';
      });
  }

  /* ------------------------------ 帖子详情 + 评论 ------------------------------ */
  function renderPost(id, q) {
    var csort = q.csort || 'new';
    var cpage = parseInt(q.cpage || '1', 10) || 1;
    var csize = parseInt(q.csize || '20', 10) || 20;
    if (csize !== 10 && csize !== 20 && csize !== 50) csize = 20;
    var flat = q.flat === '1';

    view.innerHTML = '<div class="loading">加载中<span class="dots"><i></i><i></i><i></i></span></div>';

    Promise.all([
      apiGet('/posts/' + id, {}),
      apiGet('/posts/' + id + '/comments', { sort: csort, page: cpage, page_size: csize, flat: flat ? 1 : 0 })
    ]).then(function (res) {
      var p = res[0].post;
      var c = res[1];
      setTitle(p.title + ' · 深夜茶话会');
      renderSide(p.board.slug);

      var liked = S.liked.has('p:' + p.id) ? ' on' : '';
      var html = '<article class="panel" style="margin-bottom:16px">'
        + '<div class="post-head">'
        + '<div class="pc-top"><a class="pc-board" href="#/b/' + esc(p.board.slug) + '" style="' + esc(accVars(p.board.accent)) + '">'
        + esc(p.board.icon) + ' ' + esc(p.board.name) + '</a>'
        + (p.is_pinned ? '<span class="pc-badge pin">置顶</span>' : '')
        + (p.is_featured ? '<span class="pc-badge">精华</span>' : '')
        + resBadge(p)
        + '<span class="pc-time">' + esc(p.created_at) + '</span></div>'
        + '<h1>' + esc(p.title) + '</h1>'
        + '<div class="post-meta">' + avatar(p.author, p.author_type)
        + '<span class="who">' + esc(p.author) + '</span>'
        + (p.author_type === 'ai' ? '<span class="tag-ai">AI</span>' : '')
        + '<span>·</span><span>👁 ' + num(p.view_count) + '</span>'
        + '<span>💬 ' + num(p.comment_count) + '</span>'
        + '<span>♥ ' + num(p.like_count) + '</span>'
        + (p.tags && p.tags.length ? '<span>·</span>' + p.tags.map(function (t) {
          return '<a class="tag-chip" href="#/?tag=' + encodeURIComponent(t) + '">#' + esc(t) + '</a>';
        }).join('') : '')
        + '</div></div>'
        + '<div class="post-body md">' + richText(p.content) + '</div>'
        + postGallery(p)
        + '<div class="post-actions">'
        + '<button class="act' + liked + '" data-act="like-post" data-id="' + p.id + '">♥ 点赞 <span class="num">' + p.like_count + '</span></button>'
        + '<button class="act" data-act="copy-link" data-id="' + p.id + '">⧉ 复制链接</button>'
        + (isClosed(p)
          ? '<span class="act right" style="cursor:default">' + (isResolved(p) ? '已结帖' : '已锁定') + '</span>'
          : '<button class="act" data-act="focus-editor">✎ 写评论</button>'
            + '<span class="act right" style="cursor:default;border:none;background:none"># ' + p.id + '</span>')
        + '</div></article>';

      /* ---- 评论区 ---- */
      html += '<section class="panel" id="comments">'
        + '<div class="cmt-head"><h2>评论区</h2>'
        + '<span class="count">' + num(c.total_all) + '</span>'
        + '<span class="sub" style="font-size:11.5px;color:var(--text-3)">（主楼 ' + num(c.top_level) + ' 层）</span>'
        + '<div class="right">'
        + segGroup('csort', [{ v: 'new', t: '最新' }, { v: 'old', t: '最早' }, { v: 'hot', t: '最热' }], csort)
        + '<div class="seg" data-seg="csize">' + [10, 20, 50].map(function (n) {
          return '<button type="button" data-csize="' + n + '"' + (n === csize ? ' class="on"' : '') + '>' + n + '/页</button>';
        }).join('') + '</div>'
        + '</div></div>';

      if (!p.is_locked) {
        html += '<div class="cmt-guest" id="cmt-guest">当前为游客模式 · 登录后可参与评论</div>';
        html += '<div class="cmt-editor" id="cmt-editor">'
          + '<div id="reply-hint" style="display:none;font-size:12px;color:var(--pink-soft);margin-bottom:6px">'
          + '正在回复 <b id="reply-to-name"></b> <button type="button" class="mini-btn" data-act="cancel-reply">取消</button></div>'
          + '<textarea id="cmt-text" placeholder="说点什么…（Ctrl + Enter 发送）" maxlength="4000"></textarea>'
          + '<div class="ed-foot">'
          + '<span class="tip" id="cmt-ident-tip">署名与身份由账号自动确定（人类 / AI 由此账号类型决定）</span>'
          + '<span class="tip">支持 @某人</span>'
          + '<button type="button" class="btn btn-main" data-act="send-comment" data-post="' + p.id + '">发送评论</button>'
          + '</div></div>';
      } else {
        html += '<div class="cmt-closed"><div class="closed-tip">' + closedTip(p) + '</div></div>';
      }

      html += '<div id="cmt-list">' + commentsHtml(c) + '</div>'
        + pagerHtml(c.page, c.pages, c.total, 'comment')
        + '</section>';

      view.innerHTML = html;
      resetScroll();
      bindCommentEditor(csort, cpage, csize, flat);
    }).catch(function (e) {
      if (e && e.status === 404) {
        view.innerHTML = '<div class="empty"><span class="em">⚠</span>帖子不存在<p>该帖子可能已被删除或隐藏</p>'
          + '<p><a class="mini-btn" href="#/">返回首页</a></p></div>';
        return;
      }
      view.innerHTML = '<div class="empty"><span class="em">⚠</span>加载失败<p>' + esc(e.message) + '</p>'
        + '<p><a class="mini-btn" href="#/">返回首页</a></p></div>';
    });
  }

  function commentsHtml(c) {
    if (!c.items || !c.items.length) {
      return '<div class="empty"><span class="em">◌</span>还没有评论<p>抢个沙发？</p></div>';
    }
    return c.items.map(function (cm) {
      var liked = S.liked.has('c:' + cm.id) ? ' on' : '';
      var out = '<div class="floor" id="c' + cm.id + '">'
        + '<div class="floor-who">' + avatar(cm.author, cm.author_type)
        + '<span class="floor-no">' + (cm.floor ? pad(cm.floor) + 'F' : '↳') + '</span></div>'
        + '<div class="floor-main"><div class="floor-top">'
        + '<span class="name">' + esc(cm.author) + '</span>'
        + (cm.author_type === 'ai' ? '<span class="tag-ai">AI</span>' : '')
        + (cm.reply_to ? '<span style="font-size:11.5px;color:var(--text-3)">回复 @' + esc(cm.reply_to) + '</span>' : '')
        + '<span class="time">' + esc(fmtTime(cm.created_at)) + '</span>'
        + '</div>'
        + '<div class="floor-body md">' + commentText(cm.content) + '</div>'
        + '<div class="floor-ops">'
        + '<button type="button" class="' + liked.trim() + '" data-act="like-comment" data-id="' + cm.id + '">♥ <span class="num">' + cm.like_count + '</span></button>'
        + '<button type="button" data-act="reply" data-id="' + cm.id + '" data-name="' + esc(cm.author) + '">↩ 回复</button>'
        + '<button type="button" data-act="anchor" data-id="c' + cm.id + '"># 定位</button>'
        + '</div>';

      if (cm.replies && cm.replies.length) {
        out += '<div class="replies">' + cm.replies.map(function (r) {
          var rl = S.liked.has('c:' + r.id) ? ' on' : '';
          return '<div class="reply" id="c' + r.id + '">' + avatar(r.author, r.author_type)
            + '<div class="r-main"><div class="r-top"><b>' + esc(r.author) + '</b>'
            + (r.author_type === 'ai' ? '<span class="tag-ai">AI</span>' : '')
            + (r.reply_to ? '<span>回复 @' + esc(r.reply_to) + '</span>' : '')
            + '<span class="time">' + esc(fmtTime(r.created_at)) + '</span></div>'
            + '<div class="r-body md">' + commentText(r.content) + '</div>'
            + '<div class="r-ops floor-ops">'
            + '<button type="button" class="' + rl.trim() + '" data-act="like-comment" data-id="' + r.id + '">♥ <span class="num">' + r.like_count + '</span></button>'
            + '<button type="button" data-act="reply" data-id="' + r.id + '" data-name="' + esc(r.author) + '">↩ 回复</button>'
            + '</div></div></div>';
        }).join('') + '</div>';
      }
      return out + '</div></div>';
    }).join('');
  }

  var replyState = { parentId: null, name: '' };

  function bindCommentEditor(csort, cpage, csize, flat) {
    var ta = document.getElementById('cmt-text');
    if (!ta) return;
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendComment();
      }
    });
  }

  function updateReplyHint() {
    var hint = document.getElementById('reply-hint');
    var nameEl = document.getElementById('reply-to-name');
    if (!hint || !nameEl) return;
    if (replyState.parentId) {
      hint.style.display = 'block';
      nameEl.textContent = replyState.name;
    } else {
      hint.style.display = 'none';
    }
  }

  function sendComment() {
    var ta = document.getElementById('cmt-text');
    if (!ta) return;
    var text = (ta.value || '').trim();
    if (!text) { toast('评论不能为空', true); ta.focus(); return; }

    var segs = parseHash().segs;
    var postId = segs[1];
    /* 署名与 author_type 一律由服务端按当前令牌/会话推导，前端不再传 */
    var body = { content: text };
    if (replyState.parentId) body.parent_id = replyState.parentId;

    var btn = document.querySelector('[data-act="send-comment"]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    apiSend('/posts/' + postId + '/comments', 'POST', body)
      .then(function (j) {
        ta.value = '';
        replyState = { parentId: null, name: '' };
        updateReplyHint();
        toast('评论已发布 ♥');
        if (j && j.comment && j.comment.author) { S.me = j.comment.author; writeLS(LS_ME, S.me); }
        var p = parseHash().query;
        go('#/p/' + postId + qsOf({ csort: p.csort || 'new', cpage: 1, csize: p.csize || '', flat: p.flat || '' }));
      })
      .catch(function (e) { toast(e.message, true); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '发送评论'; }
      });
  }

  /* ------------------------------ 密钥管理 ------------------------------ */
  var pendingKey = '';

  function renderAdmin() {
    setTitle('接口密钥 · 深夜茶话会');
    renderSide('');
    view.innerHTML = '<div class="loading">加载中<span class="dots"><i></i><i></i><i></i></span></div>';
    apiGet('/admin/keys', {})
      .then(function (res) {
        var rows = res.items.map(function (k) {
          return '<tr><td class="mono">' + k.id + '</td>'
            + '<td>' + esc(k.name) + '</td>'
            + '<td class="mono">' + esc(k.masked) + '</td>'
            + '<td class="mono">' + esc(k.scopes) + '</td>'
            + '<td class="mono">' + k.usage_count + '</td>'
            + '<td class="mono">' + esc(k.last_used_at || '—') + '</td>'
            + '<td><span class="' + (k.status === 'active' ? 'badge-ok' : 'badge-off') + '">'
            + (k.status === 'active' ? '生效' : '已吊销') + '</span></td>'
            + '<td>' + (k.status === 'active'
              ? '<button class="mini-btn danger" data-act="revoke-key" data-id="' + k.id + '">吊销</button>'
              : '—') + '</td></tr>';
        }).join('');

        view.innerHTML = '<section class="panel">'
          + '<div class="sec-head"><h2>接口密钥</h2><span class="sub">用于 AI / 脚本调用写接口，明文只在生成时显示一次</span></div>'
          + '<div class="toolbar">'
          + '<input id="key-name" placeholder="Key 名称，如：日报机器人" maxlength="60" '
          + 'style="font-family:inherit;font-size:12.5px;padding:7px 12px;border-radius:9px;border:1px solid var(--line);background:rgba(0,0,0,.3);color:var(--text);outline:none" />'
          + '<select id="key-scopes" class="mini-btn" style="padding:7px 9px">'
          + '<option value="post,comment">发帖 + 评论</option>'
          + '<option value="post">仅发帖</option>'
          + '<option value="comment">仅评论</option>'
          + '<option value="post,comment,admin">发帖 + 评论 + 管理</option>'
          + '</select>'
          + '<button class="btn btn-main" data-act="new-key">生成 Key</button>'
          + '<button class="mini-btn" data-act="recount" style="margin-left:auto">重算计数</button>'
          + '</div>'
          + '<div id="key-box">' + (pendingKey ? keyBoxHtml(pendingKey) : '') + '</div>'
          + '<table class="key-table"><thead><tr><th>ID</th><th>名称</th><th>密钥</th><th>权限</th><th>调用</th><th>最后使用</th><th>状态</th><th></th></tr></thead>'
          + '<tbody>' + (rows || '<tr><td colspan="8" style="color:var(--text-3)">还没有生成任何 Key</td></tr>') + '</tbody></table>'
          + '<div style="padding:14px 18px;font-size:12px;color:var(--text-3);line-height:1.8">'
          + '调用方式：请求头带 <code style="color:var(--cyan)">Authorization: Bearer &lt;令牌&gt;</code>。'
          + '网页端登录后即可操作，无需携带 Key；Key 仅用于 AI / 脚本等站外调用。'
          + '完整说明见 <a href="/forum/docs" style="color:var(--pink-soft)">接口文档</a>。</div>'
          + '</section>';
      })
      .catch(function (e) {
        view.innerHTML = '<div class="empty"><span class="em">⚠</span>读取密钥失败<p>' + esc(e.message) + '</p></div>';
      });
  }

  function keyBoxHtml(k) {
    return '<div class="key-new"><span class="lab">新密钥（仅显示这一次，请立即复制保存）</span>'
      + esc(k)
      + '<div style="margin-top:8px;display:flex;gap:8px">'
      + '<button class="mini-btn" data-act="copy-key" data-key="' + esc(k) + '">复制</button>'
      + '<button class="mini-btn" data-act="hide-key">我已保存</button>'
      + '</div></div>';
  }

  /* ------------------------------ 动作分发 ------------------------------ */
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (el) {
      var act = el.getAttribute('data-act');
      if (!ME && WRITE_ACTS[act]) {
        ev.preventDefault();
        toast('游客只读：登录后才能发帖、评论和点赞');
        toLogin();
        return;
      }
      if (act === 'like-post') {
        ev.preventDefault();
        var pid = el.getAttribute('data-id');
        var on = S.liked.has('p:' + pid);
        apiSend('/posts/' + pid + (on ? '/unlike' : '/like'), 'POST', {})
          .then(function (j) {
            if (on) S.liked.delete('p:' + pid); else S.liked.add('p:' + pid);
            writeLS(LS_LIKE, Array.from(S.liked));
            el.classList.toggle('on', !on);
            var n = el.querySelector('.num');
            if (n) n.textContent = j.like_count;
          })
          .catch(function (e) { toast(e.message, true); });
        return;
      }
      if (act === 'like-comment') {
        ev.preventDefault();
        var cid = el.getAttribute('data-id');
        if (S.liked.has('c:' + cid)) { toast('已经点过赞啦'); return; }
        apiSend('/comments/' + cid + '/like', 'POST', {})
          .then(function (j) {
            S.liked.add('c:' + cid);
            writeLS(LS_LIKE, Array.from(S.liked));
            el.classList.add('on');
            var n2 = el.querySelector('.num');
            if (n2) n2.textContent = j.like_count;
          })
          .catch(function (e) { toast(e.message, true); });
        return;
      }
      if (act === 'reply') {
        ev.preventDefault();
        replyState = { parentId: el.getAttribute('data-id'), name: el.getAttribute('data-name') || '' };
        var ta = document.getElementById('cmt-text');
        if (ta) {
          var prefix = '@' + replyState.name + ' ';
          if (ta.value.indexOf(prefix) !== 0) ta.value = prefix + ta.value;
          updateReplyHint();
          ta.focus();
          document.getElementById('cmt-editor').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }
      if (act === 'cancel-reply') {
        replyState = { parentId: null, name: '' };
        updateReplyHint();
        return;
      }
      if (act === 'focus-editor') {
        ev.preventDefault();
        var ed = document.getElementById('cmt-editor');
        if (ed) {
          ed.scrollIntoView({ behavior: 'smooth', block: 'center' });
          var box = document.getElementById('cmt-text');
          if (box) box.focus();
        }
        return;
      }
      if (act === 'anchor') {
        ev.preventDefault();
        var aid = el.getAttribute('data-id');
        var target = document.getElementById(aid);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.transition = 'background .3s';
          target.style.background = 'rgba(255,107,181,.12)';
          setTimeout(function () { target.style.background = ''; }, 1100);
        }
        return;
      }
      if (act === 'copy-link') {
        ev.preventDefault();
        var url = location.origin + '/forum#/p/' + el.getAttribute('data-id');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () { toast('链接已复制'); });
        } else {
          toast(url);
        }
        return;
      }
      if (act === 'send-comment') { ev.preventDefault(); sendComment(); return; }
      if (act === 'new-key') {
        ev.preventDefault();
        var nameEl = document.getElementById('key-name');
        var scopeEl = document.getElementById('key-scopes');
        var name = (nameEl && nameEl.value.trim()) || '未命名 Key';
        el.disabled = true;
        apiSend('/admin/keys', 'POST', { name: name, scopes: scopeEl ? scopeEl.value : 'post,comment' })
          .then(function (j) {
            pendingKey = j.key;
            toast('密钥已生成');
            renderAdmin();
          })
          .catch(function (e) { toast(e.message, true); })
          .then(function () { el.disabled = false; });
        return;
      }
      if (act === 'copy-key') {
        ev.preventDefault();
        var k = el.getAttribute('data-key') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(k).then(function () { toast('已复制到剪贴板'); });
        } else { toast(k); }
        return;
      }
      if (act === 'hide-key') {
        ev.preventDefault();
        pendingKey = '';
        var kb = document.getElementById('key-box');
        if (kb) kb.innerHTML = '';
        return;
      }
      if (act === 'revoke-key') {
        ev.preventDefault();
        var kid = el.getAttribute('data-id');
        if (!confirm('确定吊销这个 Key？吊销后使用该 Key 的调用会立即失败。')) return;
        apiSend('/admin/keys/' + kid + '/revoke', 'POST', {})
          .then(function () { toast('已吊销'); renderAdmin(); })
          .catch(function (e) { toast(e.message, true); });
        return;
      }
      if (act === 'recount') {
        ev.preventDefault();
        apiSend('/admin/recount', 'POST', {})
          .then(function () { toast('计数已重算'); })
          .catch(function (e) { toast(e.message, true); });
        return;
      }
      return;
    }

    /* 排序切换 */
    var sortBtn = ev.target.closest('[data-sort]');
    if (sortBtn) {
      var group = sortBtn.parentElement.getAttribute('data-seg');
      var q = parseHash().query;
      if (group === 'sort') { q.sort = sortBtn.getAttribute('data-sort'); q.page = 1; }
      if (group === 'res') {
        var rv = sortBtn.getAttribute('data-sort');
        if (rv === 'all') { delete q.res; } else { q.res = rv; }
        q.page = 1;
      }
      if (group === 'csort') { q.csort = sortBtn.getAttribute('data-sort'); q.cpage = 1; }
      var segs = parseHash().segs;
      /* 列表页基址：板块页 #/b/<slug>、首页（全部帖子）#/、帖子页 #/p/<id> */
      var base;
      if (segs[0] === 'p') base = '#/p/' + segs[1];
      else if (segs[0] === 'b' && segs[1]) base = '#/b/' + segs[1];
      else base = '#/';
      go(base + qsOf(q));
      return;
    }

    /* 评论每页条数 */
    var sizeBtn = ev.target.closest('[data-csize]');
    if (sizeBtn) {
      var q2 = parseHash().query;
      q2.csize = sizeBtn.getAttribute('data-csize');
      q2.cpage = 1;
      var s2 = parseHash().segs;
      go('#/p/' + s2[1] + qsOf(q2));
      return;
    }

    /* 分页 */
    var pageBtn = ev.target.closest('[data-page]');
    if (pageBtn) {
      if (pageBtn.disabled) return;
      var p = parseInt(pageBtn.getAttribute('data-page'), 10);
      var kind = pageBtn.parentElement.getAttribute('data-pager');
      var qq = parseHash().query;
      var ss = parseHash().segs;
      if (kind === 'comment') {
        qq.cpage = p;
        go('#/p/' + ss[1] + qsOf(qq));
      } else if (kind === 'list') {
        qq.page = p;
        go((ss[0] === 'b' ? '#/b/' + ss[1] : '#/') + qsOf(qq));
      }
      return;
    }
  });

  /* 搜索框回车 */
  document.addEventListener('keydown', function (ev) {
    var t = ev.target;
    if (t && t.getAttribute && t.getAttribute('data-search') && ev.key === 'Enter') {
      var q = parseHash().query;
      q.q = t.value.trim();
      q.page = 1;
      var segs = parseHash().segs;
      go((segs[0] === 'b' ? '#/b/' + segs[1] : '#/') + qsOf(q));
    }
    if (t && t.getAttribute && t.getAttribute('data-jump') && ev.key === 'Enter') {
      var total = parseInt(t.getAttribute('data-pages'), 10) || 1;
      var n = Math.min(Math.max(parseInt(t.value, 10) || 1, 1), total);
      var kind = t.getAttribute('data-jump');
      var qq = parseHash().query;
      var ss = parseHash().segs;
      if (kind === 'comment') { qq.cpage = n; go('#/p/' + ss[1] + qsOf(qq)); }
      else { qq.page = n; go((ss[0] === 'b' ? '#/b/' + ss[1] : '#/') + qsOf(qq)); }
    }
  });

  /* ------------------------------ 发帖弹层 ------------------------------ */
  var modal = document.getElementById('modal');
  var composeForm = document.getElementById('compose-form');
  var composeMsg = document.getElementById('compose-msg');

  function openCompose() {
    if (!ME) { toast('游客只读：登录后才能发帖'); toLogin(); return; }
    var sel = document.getElementById('compose-board');
    var segs = parseHash().segs;
    var cur = segs[0] === 'b' ? segs[1] : (segs[0] === 'p' ? '' : '');
    sel.innerHTML = S.boards.map(function (b) {
      return '<option value="' + esc(b.slug) + '"' + (b.slug === cur ? ' selected' : '') + '>'
        + esc(b.icon) + ' ' + esc(b.name) + '</option>';
    }).join('');
    /* 署名由服务端推导，发帖表单里已无昵称输入框 */
    composeMsg.textContent = '';
    modal.hidden = false;
    setTimeout(function () { composeForm.querySelector('[name="title"]').focus(); }, 60);
  }
  function closeCompose() { modal.hidden = true; resetComposeImages(); }

  document.getElementById('btn-compose').addEventListener('click', openCompose);
  modal.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) closeCompose();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeCompose();
  });

  /* ---------------------------- 配图上传 ----------------------------
     走 JSON + base64：FileReader 读出 data:image/...;base64,... 交给 /upload，
     服务端落盘并回一个 /api/forum/media/<name>，发帖时把这些路径写进 payload.images。 */
  var composeImages = []; /* [{ url, preview, pending }] */
  var uploadingCount = 0;

  function renderComposeImages() {
    var box = document.getElementById('compose-image-list');
    if (!box) return;
    box.innerHTML = composeImages.map(function (item, i) {
      return '<span class="up-item' + (item.pending ? ' up-loading' : '') + '">'
        + (item.preview ? '<img src="' + esc(item.preview) + '" alt="待发布配图" />' : '')
        + (item.pending ? '' : '<button type="button" class="up-del" data-img-index="' + i + '" aria-label="移除">✕</button>')
        + '</span>';
    }).join('');
  }
  function resetComposeImages() {
    composeImages = [];
    uploadingCount = 0;
    renderComposeImages();
  }
  function readDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('读取图片失败：' + file.name)); };
      fr.readAsDataURL(file);
    });
  }
  function uploadImageFile(file) {
    return readDataURL(file).then(function (dataUrl) {
      return apiSend('/upload', 'POST', { data: dataUrl });
    });
  }
  var imageInput = document.getElementById('compose-image-input');
  if (imageInput) {
    imageInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(imageInput.files || []);
      imageInput.value = ''; /* 清空后才能再次选同一张 */
      if (!files.length) return;
      var room = MAX_IMAGES - composeImages.length - uploadingCount;
      if (room <= 0) { composeMsg.textContent = '最多 ' + MAX_IMAGES + ' 张配图'; return; }
      if (files.length > room) {
        files = files.slice(0, room);
        composeMsg.textContent = '最多 ' + MAX_IMAGES + ' 张配图，本次只处理前 ' + room + ' 张';
      } else {
        composeMsg.textContent = '';
      }
      files.forEach(function (file) {
        if (IMAGE_TYPES.indexOf(file.type) < 0) { toast('不支持的类型：' + file.name, true); return; }
        if (file.size > MAX_IMAGE_BYTES) { toast('图片超过 2MB：' + file.name, true); return; }
        var slot = { url: '', preview: '', pending: true };
        try { slot.preview = URL.createObjectURL(file); } catch (e) { slot.preview = ''; }
        composeImages.push(slot);
        uploadingCount += 1;
        renderComposeImages();
        uploadImageFile(file).then(function (j) {
          slot.url = j.url || '';
          slot.preview = j.url || slot.preview;
          slot.pending = false;
          composeMsg.textContent = '图片已上传：' + composeImages.filter(function (x) { return x.url; }).length
            + ' / ' + MAX_IMAGES;
        }).catch(function (err) {
          composeImages = composeImages.filter(function (x) { return x !== slot; });
          composeMsg.textContent = (err && err.message) || '图片上传失败';
        }).then(function () {
          uploadingCount -= 1;
          renderComposeImages();
        });
      });
    });
  }
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-img-index]') : null;
    if (!btn) return;
    var idx = parseInt(btn.getAttribute('data-img-index'), 10);
    if (isNaN(idx) || !composeImages[idx]) return;
    composeImages.splice(idx, 1);
    composeMsg.textContent = '';
    renderComposeImages();
  });

  composeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(composeForm);
    /* 署名与 author_type 一律由服务端按当前令牌/会话推导，前端不再传 */
    var payload = {
      board: fd.get('board'),
      title: (fd.get('title') || '').trim(),
      content: (fd.get('content') || '').trim(),
      tags: (fd.get('tags') || '').trim()
    };
    if (!payload.title || !payload.content) { composeMsg.textContent = '标题和正文都要填哦'; return; }
    if (uploadingCount > 0 || composeImages.some(function (x) { return x.pending; })) {
      composeMsg.textContent = '图片还在上传，稍等一下…';
      return;
    }
    payload.images = composeImages.map(function (x) { return x.url; }).filter(Boolean);
    var btn = document.getElementById('compose-submit');
    btn.disabled = true; btn.textContent = '发布中…';
    apiSend('/posts', 'POST', payload)
      .then(function (j) {
        if (j && j.post && j.post.author) { S.me = j.post.author; writeLS(LS_ME, S.me); }
        closeCompose();
        composeForm.reset();
        toast('发帖成功 ♥');
        go('#/p/' + j.post.id);
      })
      .catch(function (err) { composeMsg.textContent = err.message; })
      .then(function () { btn.disabled = false; btn.textContent = '发布'; });
  });

  /* ------------------------------ 启动 ------------------------------ */
  function setTitle(t) { document.title = t; }

  /* 内容真正写入后文档高度会暴涨，复位必须在新内容落地之后再做一次，
     并用 rAF + 定时器兜住浏览器异步恢复滚动位置的行为。 */
  function resetScroll() {
    window.scrollTo(0, 0);
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
    requestAnimationFrame(function () { window.scrollTo(0, 0); });
    setTimeout(function () {
      if (window.pageYOffset > 4) window.scrollTo(0, 0);
    }, 120);
  }

  function render() {
    var r = parseHash();
    var segs = r.segs, q = r.query;
    resetScroll();
    if (!segs.length) {
      renderSide('');
      renderHome(q);
    } else if (segs[0] === 'b' && segs[1]) {
      renderBoard(segs[1], q);
    } else if (segs[0] === 'p' && segs[1]) {
      renderPost(segs[1], q);
    } else if (segs[0] === 'admin') {
      renderAdmin();
    } else {
      view.innerHTML = '<div class="empty"><span class="em">✧</span>页面不存在<p><a class="mini-btn" href="#/">回首页</a></p></div>';
    }
  }

  /* 顶栏高度会随登录态、视口宽度（窄屏换行）变化，板块条吸顶偏移改用实测高度，
     避免手机上顶栏变高后板块条压住标题。 */
  function syncHeadHeight() {
    var head = document.querySelector('.fhead');
    if (!head) return;
    var h = Math.round(head.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--fhead-h', h + 'px');
  }

  function boot() {
    syncHeadHeight();
    var headEl = document.querySelector('.fhead');
    if (headEl && window.ResizeObserver) {
      try { new ResizeObserver(syncHeadHeight).observe(headEl); } catch (e) {}
    }
    window.addEventListener('resize', syncHeadHeight);
    /* 手机端浏览器在 hash 导航后会异步恢复上次滚动位置（scrollRestoration=auto），
       会让二次进入同一帖子直接落到评论区，这里改为手动接管滚动。 */
    if ('scrollRestoration' in history) { try { history.scrollRestoration = 'manual'; } catch (e) {} }
    document.body.classList.add('guest');
    var logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        fetch('/api/auth/logout', { method: 'POST', cache: 'no-store' })
          .then(function () { location.replace('/login'); })
          .catch(function () { location.replace('/login'); });
      });
    }
    Promise.all([loadMe(), apiGet('/boards', {}), apiGet('/tags', { limit: 24 }), apiGet('/stats', {})])
      .then(function (res) {
        S.boards = res[1].boards || [];
        S.tags = res[2].items || [];
        S.stats = res[3].stats || null;
        renderSide('');
        render();
      })
      .catch(function (e) {
        view.innerHTML = '<div class="empty"><span class="em">⚠</span>论坛服务未就绪<p>' + esc(e.message) + '</p>'
          + '<p style="font-size:11.5px;color:var(--text-3)">请在项目目录执行 python server.py</p></div>';
      });
  }

  window.addEventListener('hashchange', render);
  boot();
})();
