/* ============================================================
   AI项目广场 · 门户式前端
   ============================================================ */
(function () {
  "use strict";

  var ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/></svg>';
  var ARROW_LEFT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H4M7.5 4.5 4 8l3.5 3.5"/></svg>';
  var SEARCH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14" stroke-linecap="round"/></svg>';
  /* 新闻摘要展开/收起与弹窗用到的图标 */
  var MORE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5 8 10.5l4-4"/></svg>';
  var LESS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5 8 5.5l4 4"/></svg>';
  var POPUP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5H13.5V6.5"/><path d="M13 3 8.6 7.4"/><path d="M12.5 9.8v2.7a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h2.7"/></svg>';
  var CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

  var THEME = {
    news: {
      tag: "NEWS",
      accent: "#2b5cff",
      glow: "rgba(43,92,255,.26)",
      desc: "定时任务抓取入库的热点新闻，按日期浏览、关键词检索"
    },
    overview: {
      tag: "STATS",
      accent: "#0fae8f",
      glow: "rgba(15,174,143,.24)",
      desc: "新闻库的存量结构、近 7 天入库分布与分类占比"
    },
    novel: {
      tag: "NOVEL",
      accent: "#8a5cff",
      glow: "rgba(138,92,255,.26)",
      desc: "长篇小说的世界观、章节摘要、角色事迹、世界线与关系网"
    },
    games: {
      tag: "GAME",
      accent: "#22b8d8",
      glow: "rgba(34,184,216,.26)",
      desc: "纯前端小游戏合集，手机触屏与桌面键鼠双适配，打开即玩"
    }
  };

  /* 独立页面的板块：卡片点击直接跳转，不走首页 hash 路由 */
  var BOARD_PAGE = { novel: "/novel", games: "/games" };

  var state = {
    boards: [],
    overview: null,
    forum: null,
    forumBoards: [],
    forumHot: null,
    news: [],
    dbPath: "",
    date: "",
    q: "",
    page: 1,
    pageSize: 10
  };

  var el = {
    view: document.getElementById("view"),
    refresh: document.getElementById("btn-refresh"),
    meta: document.getElementById("head-meta"),
    footDb: document.getElementById("foot-db")
  };

  /* ---------------- 基础工具 ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(n) {
    if (n === null || n === undefined || n === "" || isNaN(n)) return "—";
    return Number(n).toLocaleString("zh-CN");
  }

  function api(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function todayStr(offset) {
    var d = new Date();
    d.setDate(d.getDate() - (offset || 0));
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function shortDate(s) {
    if (!s) return "";
    return s.length >= 10 ? s.slice(5, 10) : s;
  }

  function showError(box, err) {
    var msg = err && err.message ? err.message : String(err);
    box.innerHTML = '<div class="err">加载失败：' + esc(msg) + "</div>";
  }

  function setTitle(t) {
    document.title = t ? t + " · AI项目广场" : "AI项目广场";
  }

  /* ---------------- 首页 ---------------- */

  function renderHome() {
    var ov = state.overview || {};

    var hero =
      '<section class="hero">' +
        '<p class="hero-eyebrow">Local Data Board</p>' +
        '<h1 class="hero-title">一处入口，<em>看清站点数据</em></h1>' +
        '<p class="hero-sub">共 <span class="num">' + (state.boards.length + 1) + '</span> 个入口：' +
          state.boards.length + ' 个数据板块，加 1 个社区论坛，数据实时读取数据库' +
          (state.overview
            ? "：累计 <span class=\"num\">" + fmt(ov.total) + "</span> 条新闻，今日入库 <span class=\"num\">" + fmt(ov.today_count) + "</span> 条。"
            : "。") +
        "</p>" +
      "</section>";

    var grid = '<div class="board-grid">' + state.boards.map(cardHtml).join("") + "</div>";

    el.view.innerHTML = hero + forumZone() + grid;
    setTitle("");

    Array.prototype.forEach.call(el.view.querySelectorAll(".board-card"), function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-key");
        if (BOARD_PAGE[key]) {
          location.href = BOARD_PAGE[key];
          return;
        }
        location.hash = "#/" + key;
      });
    });
  }

  /* ---------------- 首页 · 论坛入口 ---------------- */

  function forumZone() {
    var f = state.forum;
    var boards = state.forumBoards || [];
    var hot = state.forumHot;

    var chips = boards.slice(0, 6).map(function (b) {
      return '<span class="fchip" style="--chip:' + esc(b.accent || "#ff5fb0") + '">' +
        "<i>" + esc(b.icon || "·") + "</i>" + esc(b.name) + "</span>";
    }).join("");

    var stats = [
      { k: "帖子", v: f ? f.posts : null, u: "篇" },
      { k: "评论", v: f ? f.comments : null, u: "条" },
      { k: "板块", v: f ? f.boards : (boards.length || null), u: "个" }
    ];

    var latest;
    if (hot) {
      var hb = hot.board ? hot.board.name : "";
      var ht = String(hot.title || "");
      if (ht.length > 26) ht = ht.slice(0, 26) + "…";
      latest = '<p class="forum-latest">最新 · ' +
        (hb ? "<b>" + esc(hb) + "</b> " : "") + "「" + esc(ht) + "」" +
        (f && f.today_posts ? '　今日新增 <b>' + fmt(f.today_posts) + "</b> 帖" : "") +
        "</p>";
    } else {
      latest = '<p class="forum-latest">' +
        (f
          ? "今天发帖 <b>" + fmt(f.today_posts) + "</b> 篇、评论 <b>" + fmt(f.today_comments) + "</b> 条"
          : "发帖 / 评论 / 标签 / 热度排序，数据落在独立 forum.db") +
        "</p>";
    }

    return '<section class="forum-zone">' +
      '<div class="zone-head">' +
        '<h2 class="zone-title"><span class="zone-dot"></span>社区论坛</h2>' +
        '<a class="zone-link" href="/forum/docs">论坛接口文档 /forum/docs ' + ARROW + "</a>" +
      "</div>" +
      '<a class="forum-card" href="/forum" aria-label="进入深夜茶话会论坛">' +
        '<i class="fx-glow" aria-hidden="true"></i>' +
        '<div class="forum-body">' +
          '<span class="forum-eyebrow">深夜茶话会 · /forum</span>' +
          '<h3 class="forum-title">深夜茶话会 <em>论坛</em></h3>' +
          '<p class="forum-desc">多板块讨论区：闲聊日常、AI 工作日报、技术许愿、番剧安利都在这里。' +
            "支持发帖、评论分页、热度排序与标签检索，数据独立存于 forum.db，并开放 HTTP 接口。</p>" +
          (chips ? '<div class="forum-chips">' + chips + "</div>" : "") +
          latest +
        "</div>" +
        '<div class="forum-aside">' +
          '<div class="forum-stats">' +
            stats.map(function (s) {
              return '<div class="forum-stat"><span class="k">' + esc(s.k) + "</span>" +
                '<span class="v">' + fmt(s.v) + "<small>" + esc(s.u) + "</small></span></div>";
            }).join("") +
          "</div>" +
          '<span class="forum-go">进入论坛' + ARROW + "</span>" +
        "</div>" +
      "</a>" +
    "</section>";
  }

  function cardHtml(b, i) {
    var t = THEME[b.key] || { tag: "BOARD", accent: "#2b5cff", glow: "rgba(43,92,255,.22)", desc: b.desc };
    var stats = statsFor(b.key);

    return '<button type="button" class="board-card" data-key="' + esc(b.key) + '"' +
        ' style="--accent:' + t.accent + ';--glow:' + t.glow + ';animation-delay:' + (i * 90) + 'ms">' +
      '<i class="fx-glow" aria-hidden="true"></i>' +
      "<div>" +
        '<span class="card-tag"><span class="dot"></span>' + esc(t.tag) + "</span>" +
        '<h2 class="card-title">' + esc(b.name) + "</h2>" +
        '<p class="card-desc">' + esc(t.desc || b.desc || "") + "</p>" +
      "</div>" +
      '<div class="card-foot">' +
        '<div class="card-stats">' +
          stats.map(function (s) {
            return '<div class="card-stat"><span class="k">' + esc(s.k) + '</span>' +
              '<span class="v">' + fmt(s.v) + "<small>" + esc(s.u || "") + "</small></span></div>";
          }).join("") +
        "</div>" +
        '<span class="card-go">' + ARROW + "</span>" +
      "</div>" +
    "</button>";
  }

  function statsFor(key) {
    var ov = state.overview;
    if (!ov) return [{ k: "状态", v: "—" }, { k: "数据", v: "—" }];
    if (key === "news") {
      return [{ k: "累计条数", v: ov.total, u: "条" }, { k: "今日入库", v: ov.today_count, u: "条" }];
    }
    if (key === "overview") {
      return [{ k: "覆盖日期", v: ov.date_count, u: "天" }, { k: "来源", v: ov.source_count, u: "个" }];
    }
    return [{ k: "状态", v: "—" }];
  }

  /* ---------------- 板块页骨架 ---------------- */

  function backLink() {
    return '<a class="backlink" href="#/">' + ARROW_LEFT + "全部板块</a>";
  }

  function headHtml(title, desc, badges) {
    return '<div class="board-head">' +
      "<div><h1>" + esc(title) + "</h1><p>" + esc(desc) + "</p></div>" +
      (badges && badges.length
        ? '<div class="head-badges">' + badges.map(function (b) {
            return '<span class="badge">' + esc(b.k) + " <b>" + fmt(b.v) + "</b>" + esc(b.u || "") + "</span>";
          }).join("") + "</div>"
        : "") +
      "</div>";
  }

  /* ---------------- 热点新闻 ---------------- */

  function renderNews() {
    var ov = state.overview;
    var badges = ov
      ? [{ k: "累计", v: ov.total, u: "条" }, { k: "覆盖", v: ov.date_count, u: "天" }, { k: "最新", v: ov.latest_date }]
      : [];

    el.view.innerHTML =
      backLink() +
      headHtml("热点新闻", "数据由定时任务抓取入库，只读展示", badges) +
      '<div class="filters">' +
        '<div class="date-block">' +
          '<div class="date-strip" id="date-strip"></div>' +
          '<p class="date-note">日期标签仅显示最近 7 天，更早的日期可用右侧日期框查询</p>' +
        "</div>" +
        '<div class="filter-row">' +
          '<div class="search-box">' + SEARCH +
            '<input type="search" id="f-q" placeholder="搜索标题、摘要、来源、分类" value="' + esc(state.q) + '">' +
          "</div>" +
          '<input type="date" class="date-input" id="f-date" value="' + esc(state.date) + '" title="指定日期">' +
          '<span class="select-wrap"><select id="f-size">' +
            [10, 20, 50].map(function (n) {
              return '<option value="' + n + '"' + (n === state.pageSize ? " selected" : "") + ">每页 " + n + " 条</option>";
            }).join("") +
          "</select></span>" +
          '<button type="button" class="btn-primary" id="btn-search">查询</button>' +
        "</div>" +
      "</div>" +
      '<div id="news-body"><div class="loading">读取中</div></div>';

    setTitle("热点新闻");

    var qInput = document.getElementById("f-q");
    var dateInput = document.getElementById("f-date");

    document.getElementById("btn-search").addEventListener("click", function () {
      state.q = qInput.value.trim();
      state.page = 1;
      loadNews();
    });
    qInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        state.q = qInput.value.trim();
        state.page = 1;
        loadNews();
      }
    });
    dateInput.addEventListener("change", function () {
      state.date = dateInput.value || "";
      state.page = 1;
      loadNews();
    });
    document.getElementById("f-size").addEventListener("change", function () {
      state.pageSize = parseInt(this.value, 10) || 10;
      state.page = 1;
      loadNews();
    });

    renderDateStrip([]);
    loadNews();
  }

  /* 日期标签最多铺开最近 7 天（含今天），历史日期不再全部展开 */
  var MAX_DATE_CHIPS = 7;

  function recentDateChips(dates) {
    if (!dates || !dates.length) return [];

    var cutoff = todayStr(MAX_DATE_CHIPS - 1); /* 含今天在内共 7 天的窗口 */
    var picked = dates.filter(function (x) {
      return x && x.date && x.date >= cutoff;
    }).slice(0, MAX_DATE_CHIPS);

    /* 数据断更、窗口内没有数据时保底显示最新一天，避免条上只剩「全部」 */
    if (!picked.length) picked = dates.slice(0, 1);

    /* 通过日期选择器选了更早的日期时，保留该标签，避免选中态在条上消失 */
    var hasCurrent = picked.some(function (x) { return x.date === state.date; });
    if (state.date && !hasCurrent) {
      picked = picked.concat([{ date: state.date, count: null }]);
      /* 仍守住 7 个上限：挤掉最旧的一个窗口内日期，日期仍是倒序 */
      if (picked.length > MAX_DATE_CHIPS) {
        var extra = picked[picked.length - 1];
        picked = picked.slice(0, MAX_DATE_CHIPS - 1).concat([extra]);
      }
    }

    return picked;
  }

  function renderDateStrip(dates) {
    var strip = document.getElementById("date-strip");
    if (!strip) return;

    var html = '<button type="button" class="date-chip' + (state.date ? "" : " active") + '" data-date="">全部</button>';
    html += recentDateChips(dates).map(function (x) {
      return '<button type="button" class="date-chip' + (state.date === x.date ? " active" : "") +
        '" data-date="' + esc(x.date) + '">' + esc(shortDate(x.date)) +
        (x.count === null || x.count === undefined ? "" : '<span class="n">' + x.count + "</span>") +
        "</button>";
    }).join("");
    strip.innerHTML = html;

    Array.prototype.forEach.call(strip.querySelectorAll(".date-chip"), function (btn) {
      btn.addEventListener("click", function () {
        state.date = btn.getAttribute("data-date") || "";
        state.page = 1;
        var di = document.getElementById("f-date");
        if (di) di.value = state.date;
        Array.prototype.forEach.call(strip.querySelectorAll(".date-chip"), function (b) {
          b.classList.toggle("active", b === btn);
        });
        loadNews();
      });
    });
  }

  function loadNews() {
    var box = document.getElementById("news-body");
    if (!box) return;
    box.innerHTML = '<div class="loading">读取中</div>';

    var qs = "?page=" + state.page + "&page_size=" + state.pageSize;
    if (state.date) qs += "&date=" + encodeURIComponent(state.date);
    if (state.q) qs += "&q=" + encodeURIComponent(state.q);

    api("/api/news" + qs).then(function (d) {
      state.page = d.page;
      renderDateStrip(d.dates || []);

      if (!d.items.length) {
        box.innerHTML = '<div class="result-note"><b>0</b> 条结果</div>' +
          '<div class="empty"><strong>没有匹配的新闻</strong>' +
          "换个日期或清空关键词试试。数据由定时任务写入 news.db，入库后点右上角「刷新」即可看到。</div>";
        return;
      }

      var note = '<div class="result-note">共 <b>' + fmt(d.total) + "</b> 条" +
        (state.date ? '<span class="sep">/</span>日期 ' + esc(state.date) : "") +
        (state.q ? '<span class="sep">/</span>关键词 “' + esc(state.q) + "”" : "") +
        '<span class="sep">/</span>第 ' + d.page + " / " + d.pages + " 页</div>";

      var items = d.items.slice();
      var lead = (d.page === 1 && !state.q) ? items.shift() : null;

      /* state.news 按渲染顺序保存条目，供展开/弹窗按索引取回完整字段 */
      state.news = [];
      var body = "";
      if (lead) {
        state.news.push(lead);
        body += leadHtml(lead, 0);
      }
      if (items.length) {
        body += '<div class="news-grid">' + items.map(function (it) {
          state.news.push(it);
          return cardNewsHtml(it, state.news.length - 1);
        }).join("") + "</div>";
      }

      box.innerHTML = note + '<div class="news-stack">' + body + "</div>" + pagerHtml(d);
      bindPager(box, d);
      refreshNewsClamp(box);
    }).catch(function (e) { showError(box, e); });
  }

  /* ---------------- 新闻摘要：展开/收起 + 完整内容弹窗 ---------------- */

  var CLAMP_FALLBACK_CHARS = 96; /* 布局不可用时（如无渲染环境）的兜底字数阈值 */

  function newsOf(card) {
    if (!card) return null;
    var i = parseInt(card.getAttribute("data-news-idx"), 10);
    if (isNaN(i) || i < 0 || i >= state.news.length) return null;
    return state.news[i];
  }

  function isClamped(p) {
    if (!p) return false;
    /* clientHeight 为 0 说明还没完成布局，退化用字数估算，避免漏给入口 */
    if (p.clientHeight > 0) return p.scrollHeight - p.clientHeight > 2;
    return String(p.textContent || "").length > CLAMP_FALLBACK_CHARS;
  }

  /* 只在摘要确实被截断时才放出「展开全文 / 弹窗阅读」入口 */
  function refreshNewsClamp(root) {
    var scope = root || document;
    var cards = scope.querySelectorAll("[data-news-card]");
    Array.prototype.forEach.call(cards, function (card) {
      var p = card.querySelector("[data-news-clamp]");
      if (!p) return;
      var btns = card.querySelectorAll('[data-news-act="expand"], [data-news-act="modal"]');
      if (p.classList.contains("is-open")) {
        card.classList.add("has-clip");
        Array.prototype.forEach.call(btns, function (b) { b.hidden = false; });
        return;
      }
      var clipped = isClamped(p);
      card.classList.toggle("has-clip", clipped);
      Array.prototype.forEach.call(btns, function (b) { b.hidden = !clipped; });
    });
  }

  function toggleNewsExpand(card) {
    var p = card.querySelector("[data-news-clamp]");
    var btn = card.querySelector('[data-news-act="expand"]');
    if (!p || !btn) return;
    var open = !p.classList.contains("is-open");
    p.classList.toggle("is-open", open);
    card.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.innerHTML = (open ? LESS : MORE) + "<span>" + (open ? "收起" : "展开全文") + "</span>";
  }

  var newsModal = null;
  var modalReturnFocus = null;

  function buildNewsModal() {
    var wrap = document.createElement("div");
    wrap.className = "news-modal";
    wrap.id = "news-modal";
    wrap.setAttribute("hidden", "");
    wrap.innerHTML =
      '<div class="nm-mask" data-news-close></div>' +
      '<div class="nm-panel" role="dialog" aria-modal="true" aria-labelledby="nm-title" tabindex="-1">' +
        '<button type="button" class="nm-close" data-news-close aria-label="关闭">' + CLOSE + "</button>" +
        '<div class="nm-meta" id="nm-meta"></div>' +
        '<h2 class="nm-title" id="nm-title"></h2>' +
        '<div class="nm-body" id="nm-body"></div>' +
        '<div class="nm-foot" id="nm-foot"></div>' +
      "</div>";
    document.body.appendChild(wrap);
    return wrap;
  }

  function openNewsModal(it) {
    if (!it) return;
    if (!newsModal) newsModal = buildNewsModal();

    var meta = [];
    if (it.category) meta.push('<span class="nm-cat">' + esc(it.category) + "</span>");
    if (it.source) meta.push("<span>" + esc(it.source) + "</span>");
    if (it.news_date) meta.push("<span>" + esc(it.news_date) + "</span>");
    if (it.created_at) meta.push("<span>入库 " + esc(String(it.created_at).slice(11, 16)) + "</span>");

    newsModal.querySelector("#nm-meta").innerHTML = meta.join('<span class="nm-sep">·</span>');
    newsModal.querySelector("#nm-title").textContent = it.title || "（无标题）";

    var body = newsModal.querySelector("#nm-body");
    if (it.summary) {
      body.innerHTML = esc(it.summary);
    } else {
      body.innerHTML = '<span class="nm-empty">这条新闻没有提供摘要，可直接查看原文。</span>';
    }
    body.scrollTop = 0;

    newsModal.querySelector("#nm-foot").innerHTML = it.url
      ? '<a class="nm-link" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' +
        "<span>查看原文</span>" + ARROW + "</a>"
      : '<span class="nm-empty">该条目没有原文链接</span>';

    modalReturnFocus = document.activeElement;
    newsModal.removeAttribute("hidden");
    document.documentElement.classList.add("modal-open");
    document.body.classList.add("modal-open");
    window.requestAnimationFrame(function () {
      if (newsModal) newsModal.classList.add("is-open");
    });
    var panel = newsModal.querySelector(".nm-panel");
    if (panel && panel.focus) panel.focus({ preventScroll: true });
  }

  function closeNewsModal() {
    if (!newsModal || newsModal.hasAttribute("hidden")) return;
    newsModal.classList.remove("is-open");
    document.documentElement.classList.remove("modal-open");
    document.body.classList.remove("modal-open");
    window.setTimeout(function () {
      if (newsModal && !newsModal.classList.contains("is-open")) newsModal.setAttribute("hidden", "");
    }, 200);
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus({ preventScroll: true });
    modalReturnFocus = null;
  }

  function newsModalOpen() {
    return !!(newsModal && !newsModal.hasAttribute("hidden"));
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    if (t.closest("[data-news-close]")) {
      e.preventDefault();
      closeNewsModal();
      return;
    }

    var act = t.closest("[data-news-act]");
    if (act) {
      e.preventDefault();
      var card = act.closest("[data-news-card]");
      if (!card) return;
      if (act.getAttribute("data-news-act") === "expand") {
        toggleNewsExpand(card);
      } else {
        openNewsModal(newsOf(card));
      }
      return;
    }

    /* 头条整卡仍是「点开原文」的可点区域；标题、阅读全文是原生链接，不在此拦截 */
    if (t.closest("a, button, input, select, textarea, label")) return;
    var leadCard = t.closest(".news-lead[data-url]");
    if (leadCard) {
      var url = leadCard.getAttribute("data-url");
      if (url) window.open(url, "_blank", "noopener");
    }
  });

  document.addEventListener("keydown", function (e) {
    if ((e.key === "Escape" || e.key === "Esc") && newsModalOpen()) {
      e.preventDefault();
      closeNewsModal();
    }
  });

  var clampTimer = null;
  window.addEventListener("resize", function () {
    window.clearTimeout(clampTimer);
    clampTimer = window.setTimeout(function () { refreshNewsClamp(document); }, 160);
  });

  function leadHtml(it, idx) {
    var meta = [];
    if (it.category) meta.push('<span class="chip-cat">' + esc(it.category) + "</span>");
    if (it.source) meta.push("<span>" + esc(it.source) + "</span>");
    meta.push("<span>" + esc(it.news_date || "") + "</span>");

    var title = it.url
      ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + "</a>"
      : esc(it.title);

    var inner =
      '<div class="lead-meta">' + meta.join('<span style="opacity:.4">·</span>') + "</div>" +
      '<h3 class="lead-title">' + title + "</h3>" +
      (it.summary ? '<p class="lead-summary" data-news-clamp>' + esc(it.summary) + "</p>" : "") +
      newsActionsHtml(it) +
      '<div class="lead-foot">' +
        (it.url
          ? '<a class="lead-link" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' +
            "<span>阅读全文</span><span class=\"arrow\">" + ARROW + "</span></a>"
          : "<span>暂无原文链接</span>") +
      "</div>";

    return '<article class="news-lead" data-news-card data-news-idx="' + idx + '"' +
      (it.url ? ' data-url="' + esc(it.url) + '"' : "") + ">" + inner + "</article>";
  }

  /* 摘要被截断时才显示的入口：就地展开 + 弹窗查看完整内容 */
  function newsActionsHtml(it) {
    var html = '<div class="news-actions">';
    if (it.summary) {
      html += '<button type="button" class="news-more" data-news-act="expand" aria-expanded="false" hidden>' +
        MORE + "<span>展开全文</span></button>";
    }
    html += '<button type="button" class="news-more news-more--ghost" data-news-act="modal" ' +
      'aria-haspopup="dialog" hidden>' + POPUP + "<span>弹窗阅读</span></button>";
    return html + "</div>";
  }

  function cardNewsHtml(it, idx) {
    var meta = [];
    if (it.category) meta.push('<span class="nc-cat">' + esc(it.category) + "</span>");
    if (it.source) meta.push('<span class="nc-src">' + esc(it.source) + "</span>");
    meta.push('<span class="nc-dot">·</span><span>' + esc(shortDate(it.news_date)) + "</span>");

    var title = it.url
      ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + "</a>"
      : esc(it.title);

    var stamp = it.created_at ? String(it.created_at).slice(11, 16) : "";

    return '<article class="news-card" data-news-card data-news-idx="' + idx + '">' +
      '<div class="nc-meta">' + meta.join("") + "</div>" +
      '<h3 class="nc-title">' + title + "</h3>" +
      (it.summary ? '<p class="nc-summary" data-news-clamp>' + esc(it.summary) + "</p>" : "") +
      newsActionsHtml(it) +
      '<div class="nc-foot"><span>' + (stamp ? "入库 " + esc(stamp) : "") + "</span>" +
        '<span class="jump">' + ARROW + "</span></div>" +
      "</article>";
  }

  function pagerHtml(d) {
    if (d.pages <= 1) {
      return '<div class="pager"><button class="pg" disabled>上一页</button>' +
        '<button class="pg active">1</button><button class="pg" disabled>下一页</button>' +
        '<span class="pg-info">共 ' + fmt(d.total) + " 条</span></div>";
    }
    var cur = d.page, last = d.pages, nums = [], out = [];
    for (var i = 1; i <= last; i++) {
      if (i === 1 || i === last || Math.abs(i - cur) <= 1) nums.push(i);
    }
    var prev = 0;
    nums.forEach(function (n) {
      if (prev && n - prev > 1) out.push('<span class="ellipsis">···</span>');
      out.push('<button class="pg' + (n === cur ? " active" : "") + '" data-page="' + n + '">' + n + "</button>");
      prev = n;
    });

    return '<div class="pager">' +
      '<button class="pg" data-page="' + (cur - 1) + '"' + (cur <= 1 ? " disabled" : "") + ">上一页</button>" +
      out.join("") +
      '<button class="pg" data-page="' + (cur + 1) + '"' + (cur >= last ? " disabled" : "") + ">下一页</button>" +
      '<span class="pg-info">第 ' + cur + " / " + last + " 页 · 共 " + fmt(d.total) + " 条</span>" +
      "</div>";
  }

  function bindPager(scope, d) {
    Array.prototype.forEach.call(scope.querySelectorAll("[data-page]"), function (b) {
      b.addEventListener("click", function () {
        var p = parseInt(b.getAttribute("data-page"), 10);
        if (isNaN(p) || p === state.page || p < 1 || p > d.pages) return;
        state.page = p;
        loadNews();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  /* ---------------- 数据概览 ---------------- */

  function renderOverview() {
    el.view.innerHTML = backLink() +
      headHtml("数据概览", "新闻库的存量结构与近期入库情况") +
      '<div id="ov-body"><div class="loading">读取中</div></div>';
    setTitle("数据概览");

    var box = document.getElementById("ov-body");
    api("/api/overview").then(function (d) {
      var max = Math.max.apply(null, d.trend.map(function (t) { return t.count; }).concat([1]));
      var bars = d.trend.map(function (t) {
        var h = Math.max(Math.round((t.count / max) * 100), 2);
        return '<div class="bar-col"><div class="bar-num">' + t.count + "</div>" +
          '<div class="bar" style="height:' + h + '%"></div>' +
          '<div class="bar-lbl">' + esc(shortDate(t.date)) + "</div></div>";
      }).join("");

      var maxCat = Math.max.apply(null, d.categories.map(function (c) { return c.count; }).concat([1]));
      var cats = d.categories.length
        ? d.categories.map(function (c) {
            return '<div class="cat-row"><span class="cat-name">' + esc(c.category) + "</span>" +
              '<span class="cat-track"><span class="cat-fill" style="width:' +
              Math.round((c.count / maxCat) * 100) + '%"></span></span>' +
              '<span class="cat-num">' + c.count + "</span></div>";
          }).join("")
        : '<div class="empty" style="padding:36px"><strong>暂无分类数据</strong></div>';

      box.innerHTML =
        '<div class="stat-grid">' +
          statCard("新闻总量", d.total, "条", 0) +
          statCard("覆盖日期", d.date_count, "天", 70) +
          statCard("今日入库", d.today_count, "条", 140) +
          statCard("来源数量", d.source_count, "个", 210) +
        "</div>" +
        '<div class="panel"><h2>近 7 天入库分布</h2><p class="sub">按新闻日期统计，含今天在内的 7 天</p>' +
          '<div class="bars">' + bars + "</div></div>" +
        '<div class="panel"><h2>分类占比</h2><p class="sub">按分类字段聚合，最多显示 10 项</p>' +
          '<div class="cat-list">' + cats + "</div></div>" +
        '<div class="panel"><h2>数据源</h2><p class="sub">站点以只读方式连接以下数据库</p>' +
          '<div class="kv">' +
            '<div class="row"><span class="k">数据库文件</span><span class="val">' + esc(d.db_path) + "</span></div>" +
            '<div class="row"><span class="k">最新数据日期</span><span class="val">' + esc(d.latest_date) + "</span></div>" +
            '<div class="row"><span class="k">访问模式</span><span class="val">read-only（mode=ro）</span></div>' +
          "</div></div>";
    }).catch(function (e) { showError(box, e); });
  }

  function statCard(k, v, u, delay) {
    return '<div class="stat-card" style="animation-delay:' + (delay || 0) + 'ms">' +
      '<div class="k">' + esc(k) + "</div>" +
      '<div class="v">' + fmt(v) + "<small>" + esc(u) + "</small></div></div>";
  }

  /* ---------------- 路由 ---------------- */

  function route() {
    var h = (location.hash || "").replace(/^#\/?/, "").replace(/\/$/, "");
    if (h === "news") return renderNews();
    if (h === "overview") return renderOverview();
    return renderHome();
  }

  function boot() {
    state.boardPromise = api("/api/boards").catch(function (e) { return { error: e }; });
    var ovPromise = api("/api/overview").catch(function () { return null; });
    var foPromise = api("/api/forum/stats").catch(function () { return null; });
    var fbPromise = api("/api/forum/boards").catch(function () { return null; });
    var fhPromise = api("/api/forum/hot?limit=1").catch(function () { return null; });

    Promise.all([state.boardPromise, ovPromise, foPromise, fbPromise, fhPromise]).then(function (res) {
      var boards = res[0], ov = res[1];
      var fo = res[2], fb = res[3], fh = res[4];

      if (boards && boards.error) {
        showError(el.view, boards.error);
        return;
      }
      state.boards = (boards && boards.boards) || [];
      state.overview = ov;
      state.forum = fo && fo.stats ? fo.stats : null;
      state.forumBoards = (fb && fb.boards) || [];
      state.forumHot = fh && fh.items && fh.items.length ? fh.items[0] : null;
      state.dbPath = (boards && boards.db_path) || "";
      if (el.footDb) el.footDb.textContent = state.dbPath;
      if (el.meta) el.meta.textContent = ov ? "SQLite · 只读 · " + fmt(ov.total) + " 条" : "SQLite · 只读";
      route();
    });
  }

  el.refresh.addEventListener("click", function () {
    var p = fetch("/api/forum/stats", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
    p.then(function (j) {
      if (j && j.ok && j.stats) state.forum = j.stats;
      route();
    });
  });

  /* ---- 页面切换：淡出 -> 渲染 -> 淡入 ---- */
  var navTimer = null;

  function navigate() {
    clearTimeout(navTimer);
    closeNewsModal();
    el.view.classList.add("page-out");
    navTimer = setTimeout(function () {
      el.view.classList.remove("page-out");
      el.view.classList.remove("page-in");
      route();
      window.scrollTo({ top: 0, behavior: "smooth" });
      void el.view.offsetWidth;
      el.view.classList.add("page-in");
    }, 150);
  }

  window.addEventListener("hashchange", navigate);

  /* ---- 卡片光效：光标位置写入 --mx / --my ---- */
  var fxCard = null;
  var fxTarget = null;
  var fxPending = false;
  var fxX = 0;
  var fxY = 0;

  function applyGlow() {
    fxPending = false;
    if (!fxTarget) return;
    var r = fxTarget.getBoundingClientRect();
    fxTarget.style.setProperty("--mx", (fxX - r.left).toFixed(1) + "px");
    fxTarget.style.setProperty("--my", (fxY - r.top).toFixed(1) + "px");
  }

  document.addEventListener("pointermove", function (e) {
    var node = e.target;
    var card = node && node.closest ? node.closest(".board-card, .forum-card") : null;
    if (card !== fxCard) {
      if (fxCard) {
        fxCard.style.removeProperty("--mx");
        fxCard.style.removeProperty("--my");
      }
      fxCard = card;
    }
    if (!card) return;
    fxTarget = card;
    fxX = e.clientX;
    fxY = e.clientY;
    if (fxPending) return;
    fxPending = true;
    window.requestAnimationFrame(applyGlow);
  }, { passive: true });

  boot();
})();
