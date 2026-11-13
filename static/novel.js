/* 小说板块前端 —— 零依赖原生 JS
 * 页面按 <body data-page="..."> 分发：
 *   list        小说列表         /novel
 *   book        书籍详情+翻书     /novel/book/<id>
 *   characters  角色列表         /novel/book/<id>/characters
 *   character   角色详情+事迹     /novel/character/<id>
 *   timeline    世界线大事件      /novel/book/<id>/timeline
 *   graph       关系网拓扑        /novel/book/<id>/graph
 */
(function () {
  "use strict";

  var page = document.body.getAttribute("data-page") || "list";

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* 封面地址：有图用图，没有就退回文字占位 */
  function coverSrc(cover) {
    var c = String(cover == null ? "" : cover).trim();
    if (!c) return "";
    if (/^https?:\/\//i.test(c) || c.charAt(0) === "/") return c;
    return "/" + c.replace(/^\.?\//, "");
  }

  function toast(message, isError) {
    var el = $("#nv-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nv-toast";
      el.className = "nv-toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.background = isError ? "var(--t-warm, #ffd68a)" : "var(--t-inverse, #e9eeff)";
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.classList.remove("show");
    }, 2600);
  }

  /* 统一的 API 调用：非 2xx 抛带 code 的错误，方便按业务码分支 */
  function napi(path, options) {
    options = options || {};
    var init = {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: { "Accept": "application/json" }
    };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (resp) {
      return resp.json().catch(function () {
        return { ok: false, error: "响应不是合法 JSON", code: "bad_response" };
      }).then(function (data) {
        if (!resp.ok || data.ok === false) {
          var err = new Error(data.error || ("HTTP " + resp.status));
          err.code = data.code || "http_" + resp.status;
          err.status = resp.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function fail(target, err) {
    var msg = err && err.message ? err.message : String(err);
    if (err && (err.code === "login_required" || err.code === "invalid_token" || err.status === 401)) {
      msg = "需要登录后才能写入：<a href=\"/login\">去登录</a>";
      if (target) target.innerHTML = "<div class=\"nv-err\">" + msg + "</div>";
      return;
    }
    if (target) target.innerHTML = "<div class=\"nv-err\">" + esc(msg) + "</div>";
    else toast(msg, true);
  }

  function idFromPath(res) {
    var m = res.exec(location.pathname);
    return m ? parseInt(m[1], 10) : 0;
  }

  /* 顶栏登录态：只读接口对游客开放，写操作才需要登录 */
  function loadMe() {
    var box = $("#nv-user");
    if (!box) return Promise.resolve(null);
    return fetch("/api/auth/me", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.logged_in && data.user) {
          box.innerHTML = "已登录 <b>" + esc(data.user.display_name || data.user.username) + "</b>";
          return data.user;
        }
        box.innerHTML = "<a href=\"/login\" style=\"color:inherit\">未登录 · 去登录</a>";
        return null;
      })
      .catch(function () { return null; });
  }

  /* 字数计数器：超限飘红，配合服务端强校验形成双保险 */
  function bindCounter(input, counter, limit) {
    if (!input || !counter) return;
    function update() {
      var len = (input.value || "").length;
      counter.textContent = len + "/" + limit;
      counter.className = len > limit ? "over" : "";
    }
    input.addEventListener("input", update);
    update();
  }

  function readForm(root) {
    var out = {};
    $$("[data-name]", root).forEach(function (el) {
      var key = el.getAttribute("data-name");
      out[key] = el.type === "checkbox" ? el.checked : el.value;
    });
    return out;
  }

  /* 阶段任务文本 → 数组。每行：阶段名 | 起始章-结束章 | 阶段目标（后两段可省略，
     省略区间时按目标章节数在剩余阶段里平均分配，避免用户必须手算章号） */
  function parseStagesText(text, totalChapters) {
    var raw = String(text == null ? "" : text).trim();
    if (!raw) return [];
    var rows = [];
    raw.split(/\r?\n/).forEach(function (line, idx) {
      var t = line.trim();
      if (!t || t.charAt(0) === "#") return;
      var parts = t.split("|").map(function (s) { return s.trim(); });
      var name = parts[0] || ("阶段" + (rows.length + 1));
      var span = String(parts[1] || "").replace(/[～~—–]/g, "-");
      var m = span.match(/^(\d+)\s*-\s*(\d+)$/) || span.match(/^(\d+)$/);
      if (span && !m) {
        throw new Error("第 " + (idx + 1) + " 行章节区间看不懂，请写成 起始章-结束章，例如 16-35");
      }
      rows.push({
        name: name,
        from: m ? parseInt(m[1], 10) : 0,
        to: m ? parseInt(m[2] || m[1], 10) : 0,
        explicit: !!m,
        goal: parts[2] || ""
      });
    });
    var total = parseInt(totalChapters, 10) || 0;
    var lastEnd = 0;
    rows.forEach(function (r, i) {
      if (r.explicit) {
        lastEnd = r.to;
        return;
      }
      if (!total) {
        throw new Error("第 " + (i + 1) + " 行没写章节区间，请写上「起始-结束」，或先填目标章节数让它自动分配");
      }
      var rest = rows.slice(i).filter(function (x) { return !x.explicit; }).length;
      var remain = total - lastEnd;
      var size = Math.max(1, Math.floor(remain / rest));
      r.from = lastEnd + 1;
      r.to = rest === 1 ? total : Math.min(total, lastEnd + size);
      if (r.to < r.from) r.to = r.from;
      lastEnd = r.to;
    });
    return rows.map(function (r) {
      return { name: r.name, from_chapter: r.from, to_chapter: r.to, goal: r.goal };
    });
  }

  function stageLine(stage, progress, idx) {
    var span = "";
    if (stage.from_chapter || stage.to_chapter) {
      span = (stage.from_chapter || "?") + "-" + (stage.to_chapter || "?") + " 章";
    }
    var cur = progress && progress.current_stage;
    var isCur = !!cur && Number(cur.index) === (Number(idx) + 1);
    return "<li class=\"" + (isCur ? "cur" : "") + "\">" +
      "<b>" + esc(stage.name) + "</b>" +
      (span ? "<i>" + esc(span) + "</i>" : "") +
      (stage.goal ? "<p>" + esc(stage.goal) + "</p>" : "") +
      (isCur ? "<em>进行中</em>" : "") +
      "</li>";
  }

  /* 进度条 + 归档状态：书架卡片和详情页共用同一套渲染 */
  function progressHtml(progress) {
    if (!progress) return "";
    var pct = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    var label = (progress.chapter_count || 0) + " / " + (progress.target_chapters || "不限") + " 章";
    var extra = [];
    if (progress.word_count) extra.push((progress.word_count / 1000).toFixed(1) + "k 字");
    if (progress.remaining_chapters > 0) extra.push("还差 " + progress.remaining_chapters + " 章");
    return "<div class=\"nv-prog\">" +
      "<div class=\"nv-prog-bar\"><i style=\"width:" + pct + "%\"></i></div>" +
      "<span>" + esc(label) + (extra.length ? " · " + esc(extra.join(" · ")) : "") + "</span>" +
      "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* 页面：小说列表                                                      */
  /* ------------------------------------------------------------------ */

  function initList() {
    var box = $("#nv-books");
    var pager = $("#nv-pager");
    var formBox = $("#nv-new-novel");
    var form = $("#nv-novel-form");
    var PAGE_SIZE = 12;
    var state = { page: 1, pages: 1, total: 0, loading: false };

    var initial = parseInt(new URLSearchParams(location.search).get("page"), 10);
    if (initial > 0) state.page = initial;

    $("#nv-toggle-new").addEventListener("click", function () {
      formBox.hidden = !formBox.hidden;
      if (!formBox.hidden) $("#nv-novel-name").focus();
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var payload = readForm(form);
      var stages;
      try {
        stages = parseStagesText(payload.stages_text, payload.target_chapters);
      } catch (e) {
        fail($("#nv-novel-err"), { message: e.message });
        return;
      }
      delete payload.stages_text;
      payload.stages = stages;
      var btn = $("#nv-novel-submit");
      btn.disabled = true;
      napi("/api/novel/novels", { method: "POST", body: payload })
        .then(function (data) {
          toast("《" + data.novel.name + "》已创建");
          location.href = "/novel/book/" + data.novel.novel_id;
        })
        .catch(function (err) {
          btn.disabled = false;
          fail($("#nv-novel-err"), err);
        });
    });

    /* 封面占位：取书名前两字，零图片依赖 */
    function coverText(name) {
      var t = String(name || "").replace(/\s+/g, "");
      return t ? t.slice(0, 2) : "书";
    }

    function cardHtml(n) {
      var desc = n.completion_goal || n.background || n.worldview || n.latest_summary || "（作者还没写简介）";
      var updated = (n.updated_at || n.created_at || "").slice(0, 16);
      var src = coverSrc(n.cover);
      var done = (n.status || n.progress && n.progress.status) === "completed";
      var cover = src
        ? "<div class=\"nv-cover has-img\"><img src=\"" + esc(src) + "\" alt=\"" + esc(n.name) + "\" loading=\"lazy\">" +
          "<span class=\"nv-cover-tag\">NOVEL</span></div>"
        : "<div class=\"nv-cover\"><span class=\"nv-cover-tag\">NOVEL</span><span>" + esc(coverText(n.name)) + "</span></div>";
      return "<a class=\"nv-shelf-card" + (done ? " is-done" : "") + "\" href=\"/novel/book/" + n.novel_id + "\">" +
        cover +
        "<div class=\"nv-shelf-body\">" +
        "<h3>" + esc(n.name) + "<em class=\"nv-badge" + (done ? " done" : "") + "\">" +
        (done ? "已完结" : "连载中") + "</em></h3>" +
        "<p class=\"nv-shelf-desc\">" + esc(desc) + "</p>" +
        progressHtml(n.progress) +
        "<div class=\"nv-shelf-meta\">" +
        "<span>作者 " + esc(n.author || "匿名") + "</span>" +
        "<span><b>" + (n.chapter_count || 0) + "</b> 章 · 更新 " + esc(updated || "—") + "</span>" +
        "</div></div></a>";
    }

    function render(items) {
      if (!items.length) {
        box.innerHTML = "<div class=\"nv-empty\">还没有小说。点上面的「新建小说」写第一本，或让 AI 通过 /api/novel/novels 提交。</div>";
        return;
      }
      box.innerHTML = items.map(cardHtml).join("");
    }

    /* 页码窗口：首页、末页、当前页 ±1，其余折叠成省略号 */
    function pageNumbers(page, pages) {
      var out = [];
      if (pages <= 7) {
        for (var i = 1; i <= pages; i += 1) out.push(i);
        return out;
      }
      var set = [1, pages, page - 1, page, page + 1].filter(function (n) {
        return n >= 1 && n <= pages;
      });
      set = set.filter(function (n, i) { return set.indexOf(n) === i; }).sort(function (a, b) { return a - b; });
      set.forEach(function (n, i) {
        if (i > 0 && n - set[i - 1] > 1) out.push(0);
        out.push(n);
      });
      return out;
    }

    function renderPager() {
      if (!pager) return;
      if (state.pages <= 1) {
        pager.innerHTML = "";
        return;
      }
      var html = "<button class=\"nv-page-btn\" data-page=\"" + (state.page - 1) + "\"" +
        (state.page <= 1 ? " disabled" : "") + ">上一页</button>";
      pageNumbers(state.page, state.pages).forEach(function (n) {
        if (n === 0) {
          html += "<span class=\"nv-page-dots\">…</span>";
          return;
        }
        html += "<button class=\"nv-page-btn\" data-page=\"" + n + "\"" +
          (n === state.page ? " aria-current=\"page\"" : "") + ">" + n + "</button>";
      });
      html += "<button class=\"nv-page-btn\" data-page=\"" + (state.page + 1) + "\"" +
        (state.page >= state.pages ? " disabled" : "") + ">下一页</button>";
      html += "<span class=\"nv-page-info\">第 " + state.page + " / " + state.pages + " 页 · 共 " + state.total + " 本</span>";
      pager.innerHTML = html;
      $$(".nv-page-btn", pager).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var target = parseInt(btn.getAttribute("data-page"), 10);
          if (!target || target === state.page || target < 1 || target > state.pages) return;
          load(target, true);
        });
      });
    }

    function load(page, scrollTop) {
      if (state.loading) return;
      state.loading = true;
      box.innerHTML = "<div class=\"nv-empty\">加载中…</div>";
      napi("/api/novel/novels?page=" + page + "&page_size=" + PAGE_SIZE)
        .then(function (data) {
          state.loading = false;
          state.page = data.page || page;
          state.pages = data.pages || 1;
          state.total = data.total || 0;
          $("#nv-count").textContent = state.total;
          render(data.items || []);
          renderPager();
          history.replaceState(null, "", state.page > 1 ? "?page=" + state.page : location.pathname);
          if (scrollTop) window.scrollTo({ top: 0, behavior: "smooth" });
        })
        .catch(function (err) {
          state.loading = false;
          fail(box, err);
        });
    }

    load(state.page, false);
  }

  /* ------------------------------------------------------------------ */
  /* 页面：书籍详情 + 翻书动画                                            */
  /* ------------------------------------------------------------------ */

  function initBook() {
    var novelId = idFromPath(/^\/novel\/book\/(\d+)\/?$/);
    if (!novelId) {
      $("#nv-main").innerHTML = "<div class=\"nv-err\">路径缺少小说 ID</div>";
      return;
    }

    var state = { novel: null, chapters: [] };

    function paintFlip() {
      var n = state.novel;
      $("#nv-flip-front-title").textContent = n.name;
      $("#nv-flip-front-body").textContent = n.background || "（尚未填写背景描述）";
      $("#nv-flip-back-body").textContent = n.worldview || "（尚未填写世界观设定）";
      $("#nv-flip-front-foot").textContent = "作者 " + (n.author || "匿名") + " · 共 " + n.chapter_count + " 章";
      $("#nv-flip-back-foot").textContent = "世界观设定 · " + (n.worldview || "").length + " 字";
    }

    /* 书籍封面：有 cover 才插一块图，没有就什么都不做，保持原来的纯文字版式 */
    function paintCover(n) {
      var old = $("#nv-book-cover");
      if (old) old.parentNode.removeChild(old);
      var src = coverSrc(n.cover);
      if (!src) return;
      var sub = $("#nv-sub");
      if (!sub || !sub.parentNode) return;
      var box = document.createElement("div");
      box.id = "nv-book-cover";
      box.className = "nv-book-cover";
      var img = document.createElement("img");
      img.src = src;
      img.alt = n.name || "封面";
      img.loading = "lazy";
      img.onerror = function () { box.parentNode && box.parentNode.removeChild(box); };
      box.appendChild(img);
      sub.parentNode.insertBefore(box, sub.nextSibling);
    }

    function paintNovel(n) {
      $("#nv-title").textContent = n.name;
      $("#nv-sub").textContent = "作者 " + (n.author || "匿名") + " · 创建于 " + (n.created_at || "").slice(0, 16) +
        " · 最近更新 " + (n.updated_at || "").slice(0, 16);
      document.title = n.name + " · 小说板块";
      $("#nv-stat-chapters").textContent = n.chapter_count;
      $("#nv-stat-chars").textContent = n.character_count;
      $("#nv-stat-rels").textContent = n.relation_count;
      $("#nv-stat-events").textContent = n.world_event_count;
      $$("[data-link]").forEach(function (el) {
        el.setAttribute("href", el.getAttribute("data-link").replace("{id}", n.novel_id));
      });
      paintCover(n);
      paintFlip();
      paintGoal(n);
    }

    /* 完结目标面板：目标文本 + 进度 + 阶段清单，完结后按钮置灰 */
    function paintGoal(n) {
      var p = n.progress || {};
      var done = (p.status || n.status || "serializing") === "completed";
      var badge = $("#nv-goal-status");
      if (badge) {
        badge.textContent = done ? "已完结" : "连载中";
        badge.className = "nv-badge" + (done ? " done" : "");
      }
      var text = $("#nv-goal-text");
      if (text) {
        text.textContent = n.completion_goal || "（尚未设置完结目标，建议补上，否则 AI 容易无限续写）";
      }
      var bar = $("#nv-goal-progress");
      if (bar) {
        bar.innerHTML = progressHtml(p) +
          (done && n.finished_at
            ? "<div class=\"nv-goal-done\">已于 " + esc(String(n.finished_at).slice(0, 16)) + " 完结，共 " +
              (p.chapter_count || 0) + " 章 · " + (p.word_count || 0) + " 字</div>"
            : "");
      }
      var list = $("#nv-stages");
      if (list) {
        var stages = n.stages || [];
        list.innerHTML = stages.length
          ? stages.map(function (s, i) { return stageLine(s, p, i); }).join("")
          : "<li class=\"nv-muted\">未设置阶段任务</li>";
      }
      var finish = $("#nv-goal-finish");
      if (finish) {
        finish.disabled = done;
        finish.textContent = done ? "已完结" : "标记完结";
      }
    }

    function bindGoal() {
      var form = $("#nv-goal-form");
      var editBtn = $("#nv-goal-edit");
      var finishBtn = $("#nv-goal-finish");
      var cancelBtn = $("#nv-goal-cancel");
      if (!form || !editBtn) return;

      function fillForm(n) {
        var p = n.progress || {};
        form.querySelector("[data-name=\"completion_goal\"]").value = n.completion_goal || "";
        form.querySelector("[data-name=\"target_chapters\"]").value = p.target_chapters || "";
        form.querySelector("[data-name=\"target_words\"]").value = p.target_words || "";
        form.querySelector("[data-name=\"stages_text\"]").value = (n.stages || []).map(function (s) {
          return s.name + " | " + (s.from_chapter || "") + "-" + (s.to_chapter || "") + " | " + (s.goal || "");
        }).join("\n");
      }

      editBtn.addEventListener("click", function () {
        if (form.hidden) {
          fillForm(state.novel || {});
          form.hidden = false;
          editBtn.textContent = "收起";
        } else {
          form.hidden = true;
          editBtn.textContent = "改目标 / 阶段";
        }
      });

      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          form.hidden = true;
          editBtn.textContent = "改目标 / 阶段";
        });
      }

      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var payload = readForm(form);
        var stages;
        try {
          stages = parseStagesText(payload.stages_text, payload.target_chapters);
        } catch (e) {
          fail($("#nv-goal-err"), { message: e.message });
          return;
        }
        payload.stages = stages;
        delete payload.stages_text;
        if (!String(payload.completion_goal || "").trim()) {
          fail($("#nv-goal-err"), { message: "完结目标不能为空" });
          return;
        }
        napi("/api/novel/novels/" + novelId, { method: "PUT", body: payload })
          .then(function () {
            toast("目标已更新");
            form.hidden = true;
            editBtn.textContent = "改目标 / 阶段";
            return reload();
          })
          .catch(function (err) { fail($("#nv-goal-err"), err); });
      });

      if (finishBtn) {
        finishBtn.addEventListener("click", function () {
          finishBtn.disabled = true;
          napi("/api/novel/novels/" + novelId + "/complete", { method: "POST", body: {} })
            .then(function (data) {
              toast(data.already ? "这本书已是完结状态" : "已标记完结");
              return reload();
            })
            .catch(function (err) {
              finishBtn.disabled = false;
              fail($("#nv-goal-err"), err);
            });
        });
      }
    }

    function paintChapters(items) {
      var box = $("#nv-chapters");
      var startBtn = $("#nv-start-read");
      if (!items.length) {
        box.innerHTML = "<div class=\"nv-empty\">还没有章节。上传章节必须填写一句话摘要（≤32 字）和概述（≤200 字）。</div>";
        if (startBtn) {
          startBtn.textContent = "暂无章节";
          startBtn.className = "nv-btn is-off";
          startBtn.setAttribute("href", "javascript:void(0)");
        }
        return;
      }
      /* 目录只出方格：格内是章节序号（阿拉伯数字），点哪格跳哪章，正文在独立阅读页 */
      var firstSeq = null;
      items.forEach(function (c) {
        var seq = parseInt(c.seq, 10);
        if (firstSeq === null || seq < firstSeq) firstSeq = seq;
      });
      if (startBtn) {
        startBtn.textContent = "从第一章开始阅读";
        startBtn.className = "nv-btn primary";
        startBtn.setAttribute("href", "/novel/book/" + novelId + "/read/" + firstSeq);
      }
      box.innerHTML = "<div class=\"nv-ch-grid\">" + items.map(function (c) {
        var seq = parseInt(c.seq, 10);
        return "<a class=\"nv-ch-cell\" href=\"/novel/book/" + novelId + "/read/" + seq + "\"" +
          " title=\"第 " + seq + " 章\" aria-label=\"第 " + seq + " 章\">" + seq + "</a>";
      }).join("") + "</div>";
    }

    $("#nv-flip").addEventListener("click", function () {
      this.classList.toggle("flipped");
    });

    var uploadForm = $("#nv-chapter-form");
    bindCounter($("#nv-one-line"), $("#nv-one-line-count"), 32);
    bindCounter($("#nv-summary"), $("#nv-summary-count"), 200);
    bindGoal();

    uploadForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var payload = readForm(uploadForm);
      payload.seq = payload.seq ? parseInt(payload.seq, 10) : 0;
      var btn = $("#nv-chapter-submit");
      btn.disabled = true;
      $("#nv-chapter-err").innerHTML = "";
      napi("/api/novel/novels/" + novelId + "/chapters", { method: "POST", body: payload })
        .then(function (data) {
          btn.disabled = false;
          var extra = data.world_event ? "，并同步写入 1 条世界大事件" : "";
          if (data.auto_completed) extra += "；已达目标章节数，本书自动完结";
          toast("章节已保存" + extra);
          uploadForm.reset();
          bindCounter($("#nv-one-line"), $("#nv-one-line-count"), 32);
          bindCounter($("#nv-summary"), $("#nv-summary-count"), 200);
          return reload();
        })
        .catch(function (err) {
          btn.disabled = false;
          fail($("#nv-chapter-err"), err);
        });
    });

    function reload() {
      return napi("/api/novel/novels/" + novelId)
        .then(function (data) {
          state.novel = data.novel;
          paintNovel(data.novel);
          return napi("/api/novel/novels/" + novelId + "/chapters");
        })
        .then(function (data) {
          state.chapters = data.items || [];
          paintChapters(state.chapters);
        });
    }

    reload().catch(function (err) { fail($("#nv-main"), err); });
  }

  /* ------------------------------------------------------------------ */
  /* 页面：角色列表                                                      */
  /* ------------------------------------------------------------------ */

  function initCharacters() {
    var novelId = idFromPath(/^\/novel\/book\/(\d+)\/characters\/?$/);
    if (!novelId) return;

    var form = $("#nv-char-form");
    $("#nv-char-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var payload = readForm(form);
      var btn = $("#nv-char-submit");
      btn.disabled = true;
      napi("/api/novel/novels/" + novelId + "/characters", { method: "POST", body: payload })
        .then(function () {
          btn.disabled = false;
          toast("角色已添加");
          form.reset();
          return reload();
        })
        .catch(function (err) {
          btn.disabled = false;
          fail($("#nv-char-err"), err);
        });
    });

    function reload() {
      return napi("/api/novel/novels/" + novelId)
        .then(function (data) {
          $("#nv-title").textContent = "《" + data.novel.name + "》· 角色";
          document.title = data.novel.name + " · 角色";
          $$("[data-link]").forEach(function (el) {
            el.setAttribute("href", el.getAttribute("data-link").replace("{id}", data.novel.novel_id));
          });
          return napi("/api/novel/novels/" + novelId + "/characters");
        })
        .then(function (data) {
          var box = $("#nv-chars");
          var items = data.items || [];
          $("#nv-char-count").textContent = items.length;
          if (!items.length) {
            box.innerHTML = "<div class=\"nv-empty\">还没有角色。主角标记会决定关系网默认中心节点。</div>";
            return;
          }
          box.innerHTML = items.map(function (c) {
            var info = [c.gender, c.identity, c.age ? c.age + " 岁" : ""].filter(Boolean).join(" · ");
            return "<a class=\"nv-char\" href=\"/novel/character/" + c.character_id + "\">" +
              "<div class=\"nv-char-name\">" + esc(c.name) +
              (c.is_protagonist ? "<span class=\"nv-tag lead\">主角</span>" : "<span class=\"nv-tag\">配角</span>") +
              "</div>" +
              (info ? "<p class=\"nv-char-info\">" + esc(info) + "</p>" : "") +
              (c.intro ? "<p class=\"nv-char-intro\">" + esc(c.intro) + "</p>" : "") +
              "</a>";
          }).join("");
        });
    }

    reload().catch(function (err) { fail($("#nv-main"), err); });
  }

  /* ------------------------------------------------------------------ */
  /* 页面：角色详情 + 事迹时间线                                          */
  /* ------------------------------------------------------------------ */

  function initCharacter() {
    var characterId = idFromPath(/^\/novel\/character\/(\d+)\/?$/);
    if (!characterId) return;

    var state = { character: null };

    function renderTimeline(items) {
      var box = $("#nv-events");
      if (!items.length) {
        box.innerHTML = "<div class=\"nv-empty\">这个角色还没有事迹记录。</div>";
        return;
      }
      box.innerHTML = "<div class=\"nv-timeline\">" + items.map(function (e) {
        return "<div class=\"nv-node\">" +
          "<div class=\"nv-node-time\">" + esc(e.event_time || "时间不详") + "</div>" +
          "<div class=\"nv-node-desc\">" + esc(e.description) + "</div>" +
          (e.chapter_title ? "<div class=\"nv-node-src\">来源章节：" + esc(e.chapter_title) + "</div>" : "") +
          "</div>";
      }).join("") + "</div>";
    }

    var form = $("#nv-event-form");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var payload = readForm(form);
      if (payload.chapter_id) payload.chapter_id = parseInt(payload.chapter_id, 10);
      else delete payload.chapter_id;
      var btn = $("#nv-event-submit");
      btn.disabled = true;
      napi("/api/novel/characters/" + characterId + "/events", { method: "POST", body: payload })
        .then(function () {
          btn.disabled = false;
          toast("事迹已记录");
          form.reset();
          return reload();
        })
        .catch(function (err) {
          btn.disabled = false;
          fail($("#nv-event-err"), err);
        });
    });

    function reload() {
      return napi("/api/novel/characters/" + characterId)
        .then(function (data) {
          state.character = data.character;
          var c = data.character;
          $("#nv-title").textContent = c.name;
          document.title = c.name + " · 角色详情";
          $("#nv-sub").textContent = "《" + c.novel_name + "》· 事迹 " + c.event_count + " 条" +
            (c.is_protagonist ? " · 主角" : "");
          $$("[data-link]").forEach(function (el) {
            el.setAttribute("href", el.getAttribute("data-link").replace("{id}", c.novel_id));
          });
          var pairs = [
            ["性别", c.gender], ["身份", c.identity], ["年龄", c.age ? c.age + " 岁" : ""],
            ["定位", c.is_protagonist ? "主角" : "配角"], ["创建", (c.created_at || "").slice(0, 16)]
          ].filter(function (p) { return p[1]; });
          $("#nv-profile").innerHTML = pairs.map(function (p) {
            return "<div><span class=\"nv-muted\">" + esc(p[0]) + "</span><div>" + esc(p[1]) + "</div></div>";
          }).join("");
          $("#nv-intro").textContent = c.intro || "（暂无简介）";
          return napi("/api/novel/characters/" + characterId + "/events");
        })
        .then(function (data) {
          renderTimeline(data.items || []);
          $("#nv-event-count").textContent = data.total || 0;
        });
    }

    reload().catch(function (err) { fail($("#nv-main"), err); });
  }

  /* ------------------------------------------------------------------ */
  /* 页面：世界线大事件                                                  */
  /* ------------------------------------------------------------------ */

  function initTimeline() {
    var novelId = idFromPath(/^\/novel\/book\/(\d+)\/timeline\/?$/);
    if (!novelId) return;

    var form = $("#nv-wevent-form");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var payload = readForm(form);
      if (payload.chapter_id) payload.chapter_id = parseInt(payload.chapter_id, 10);
      else delete payload.chapter_id;
      var btn = $("#nv-wevent-submit");
      btn.disabled = true;
      napi("/api/novel/novels/" + novelId + "/events", { method: "POST", body: payload })
        .then(function () {
          btn.disabled = false;
          toast("大事件已记录");
          form.reset();
          return reload();
        })
        .catch(function (err) {
          btn.disabled = false;
          fail($("#nv-wevent-err"), err);
        });
    });

    function reload() {
      return napi("/api/novel/novels/" + novelId)
        .then(function (data) {
          $("#nv-title").textContent = "《" + data.novel.name + "》· 世界线大事件";
          document.title = data.novel.name + " · 世界线";
          $$("[data-link]").forEach(function (el) {
            el.setAttribute("href", el.getAttribute("data-link").replace("{id}", data.novel.novel_id));
          });
          return napi("/api/novel/novels/" + novelId + "/events");
        })
        .then(function (data) {
          var items = data.items || [];
          $("#nv-wevent-count").textContent = items.length;
          var box = $("#nv-wevents");
          if (!items.length) {
            box.innerHTML = "<div class=\"nv-empty\">还没有世界大事件。上传章节时填写事件描述会自动同步到这里。</div>";
            return;
          }
          box.innerHTML = "<div class=\"nv-timeline\">" + items.map(function (e) {
            return "<div class=\"nv-node\">" +
              "<div class=\"nv-node-time\">" + esc(e.event_time || "时间不详") + "</div>" +
              "<div class=\"nv-node-desc\">" + esc(e.description) + "</div>" +
              (e.chapter_title ? "<div class=\"nv-node-src\">来源章节：" + esc(e.chapter_title) + "</div>" : "") +
              "</div>";
          }).join("") + "</div>";
        });
    }

    reload().catch(function (err) { fail($("#nv-main"), err); });
  }

  /* ------------------------------------------------------------------ */
  /* 页面：关系网拓扑（原生 Canvas）                                      */
  /* ------------------------------------------------------------------ */

  function initGraph() {
    var novelId = idFromPath(/^\/novel\/book\/(\d+)\/graph\/?$/);
    if (!novelId) return;

    var canvas = $("#nv-canvas");
    var ctx = canvas.getContext("2d");
    var stage = $("#nv-stage");
    var model = { nodes: [], edges: [], center: 0, novel: null };
    var layoutNodes = [];
    var hoverId = 0;

    var EDGE_COLORS = ["--t-accent", "--t-accent-2", "--t-pink", "--t-cyan", "--t-violet", "--t-mint", "--t-warm"];

    function cssVar(name, fallback) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }

    function palette() {
      return {
        ink: cssVar("--t-ink", "#e7ecff"),
        ink2: cssVar("--t-ink-2", "#a6b2d6"),
        ink3: cssVar("--t-ink-3", "#74809f"),
        line: cssVar("--t-line", "#1a2138"),
        accent: cssVar("--t-accent", "#6b7dff"),
        accent2: cssVar("--t-accent-2", "#43d6c0"),
        surface: cssVar("--t-surface", "#101529"),
        bg: cssVar("--t-bg", "#0b1020"),
        pinksoft: cssVar("--t-pink-soft", "rgba(255,140,200,.18)")
      };
    }

    function edgeColor(type, pal) {
      var idx = 0;
      var text = String(type || "");
      for (var i = 0; i < text.length; i++) idx = (idx * 31 + text.charCodeAt(i)) % EDGE_COLORS.length;
      return cssVar(EDGE_COLORS[idx], pal.accent);
    }

    function resize() {
      var dpr = window.devicePixelRatio || 1;
      var w = stage.clientWidth;
      var h = stage.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    /* 以中心节点为核心做一层放射布局：中心 + 直接邻居环 */
    function layout() {
      var size = resize();
      var w = size.w;
      var h = size.h;
      var cx = w / 2;
      var cy = h / 2;
      var center = model.nodes.filter(function (n) { return n.id === model.center; })[0];
      var neighbors = model.edges.filter(function (e) {
        return e.source === model.center || e.target === model.center;
      }).map(function (e) {
        var otherId = e.source === model.center ? e.target : e.source;
        return { id: otherId, edge: e };
      });

      /* 同一角色可能有多条关系，按角色去重，关系类型合并展示 */
      var seen = {};
      var ring = [];
      neighbors.forEach(function (item) {
        if (!seen[item.id]) {
          seen[item.id] = { id: item.id, types: [] };
          ring.push(seen[item.id]);
        }
        seen[item.id].types.push(item.edge.type);
      });

      layoutNodes = [];
      if (!center) return { w: w, h: h, center: null, ring: [] };

      layoutNodes.push({ id: center.id, name: center.name, x: cx, y: cy, r: 42, lead: true, types: [] });

      var radius = Math.min(w, h) * 0.34;
      if (ring.length === 1) radius = Math.min(w, h) * 0.26;
      var start = -Math.PI / 2;
      ring.forEach(function (item, i) {
        var angle = start + (Math.PI * 2 * i) / Math.max(ring.length, 1);
        var node = model.nodes.filter(function (n) { return n.id === item.id; })[0];
        layoutNodes.push({
          id: item.id,
          name: node ? node.name : ("角色 " + item.id),
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          r: node && node.is_protagonist ? 30 : 26,
          lead: false,
          types: item.types
        });
      });
      return { w: w, h: h, center: center, ring: ring, radius: radius, cx: cx, cy: cy };
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function label(text, x, y, pal, color, size) {
      ctx.font = (size || 13) + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
      var metrics = ctx.measureText(text);
      var padX = 6;
      var w = metrics.width + padX * 2;
      var h = (size || 13) + 10;
      roundRect(x - w / 2, y - h / 2, w, h, 6);
      ctx.fillStyle = pal.bg;
      ctx.globalAlpha = 0.86;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y + 0.5);
    }

    function draw() {
      var pal = palette();
      var geo = layout();
      ctx.clearRect(0, 0, geo.w, geo.h);

      if (!geo.center) {
        ctx.fillStyle = pal.ink3;
        ctx.font = "14px 'Segoe UI','PingFang SC',sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("这本书还没有角色", geo.w / 2, geo.h / 2);
        return;
      }

      var byId = {};
      layoutNodes.forEach(function (n) { byId[n.id] = n; });
      var centerNode = byId[geo.center.id];

      /* 连线先画，节点压在上面 */
      model.edges.forEach(function (e) {
        var touches = e.source === geo.center.id || e.target === geo.center.id;
        if (!touches) return;
        var a = byId[e.source === geo.center.id ? e.source : e.target];
        var b = byId[e.source === geo.center.id ? e.target : e.source];
        if (!a || !b) return;
        var color = edgeColor(e.type, pal);
        var active = hoverId && (hoverId === e.source || hoverId === e.target);

        /* 二次贝塞尔，让多条边不重叠：按关系 id 做侧向偏移 */
        var mx = (a.x + b.x) / 2;
        var my = (a.y + b.y) / 2;
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var len = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        var off = ((e.id % 5) - 2) * 10;
        var cxp = mx + (-dy / len) * off;
        var cyp = my + (dx / len) * off;

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cxp, cyp, b.x, b.y);
        ctx.strokeStyle = color;
        ctx.globalAlpha = active ? 0.95 : 0.5;
        ctx.lineWidth = active ? 2.4 : 1.5;
        ctx.stroke();

        /* 箭头：指向 b */
        var t = 0.62;
        var px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cxp + t * t * b.x;
        var py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cyp + t * t * b.y;
        var angle = Math.atan2(b.y - cyp, b.x - cxp);
        ctx.globalAlpha = active ? 0.95 : 0.55;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - 9 * Math.cos(angle - 0.4), py - 9 * Math.sin(angle - 0.4));
        ctx.lineTo(px - 9 * Math.cos(angle + 0.4), py - 9 * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;

        label(e.type, (px + cxp) / 2, (py + cyp) / 2 - 8, pal, color, 11);
      });

      /* 节点 */
      layoutNodes.forEach(function (n) {
        var isCenter = n.id === geo.center.id;
        var hovered = hoverId === n.id;
        var grad = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.35, 4, n.x, n.y, n.r);
        if (isCenter) {
          grad.addColorStop(0, pal.accent2);
          grad.addColorStop(1, pal.accent);
        } else {
          grad.addColorStop(0, pal.surface);
          grad.addColorStop(1, cssVar("--t-card-a", "#131a2f"));
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = isCenter ? 3 : (hovered ? 2.4 : 1.4);
        ctx.strokeStyle = isCenter ? pal.accent2 : (hovered ? pal.accent2 : pal.line);
        ctx.stroke();

        /* 外发光 */
        if (isCenter || hovered) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2);
          ctx.strokeStyle = isCenter ? pal.accent2 : pal.accent;
          ctx.globalAlpha = 0.22;
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        ctx.font = (isCenter ? 15 : 13) + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
        ctx.fillStyle = isCenter ? cssVar("--t-on-accent", "#08102a") : pal.ink;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        var name = n.name.length > 8 ? n.name.slice(0, 7) + "…" : n.name;
        ctx.fillText(name, n.x, n.y);

        if (isCenter) {
          ctx.font = "11px 'Segoe UI','PingFang SC',sans-serif";
          ctx.fillStyle = cssVar("--t-on-accent", "#08102a");
          ctx.globalAlpha = 0.8;
          ctx.fillText("中心", n.x, n.y + n.r - 10);
          ctx.globalAlpha = 1;
        }
        if (!isCenter && n.types && n.types.length) {
          label(n.types.join(" / "), n.x, n.y + n.r + 14, pal, pal.ink3, 11);
        }
      });

      /* 未连接角色提示 */
      var connected = {};
      connected[geo.center.id] = true;
      layoutNodes.forEach(function (n) { connected[n.id] = true; });
      var orphan = model.nodes.filter(function (n) { return !connected[n.id]; }).length;
      $("#nv-graph-note").textContent = "当前中心：" + geo.center.name + " · 相邻 " + (layoutNodes.length - 1) + " 个角色" +
        (orphan ? " · 另有 " + orphan + " 个角色与它无直接关系（切换中心可查看）" : "");
    }

    function hitTest(x, y) {
      for (var i = 0; i < layoutNodes.length; i++) {
        var n = layoutNodes[i];
        var dx = x - n.x;
        var dy = y - n.y;
        if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return n;
      }
      return null;
    }

    function localPos(ev) {
      var rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    canvas.addEventListener("mousemove", function (ev) {
      var p = localPos(ev);
      var hit = hitTest(p.x, p.y);
      var next = hit ? hit.id : 0;
      if (next !== hoverId) {
        hoverId = next;
        canvas.style.cursor = hit ? "pointer" : "default";
        draw();
      }
    });

    canvas.addEventListener("mouseleave", function () {
      if (!hoverId) return;
      hoverId = 0;
      draw();
    });

    canvas.addEventListener("click", function (ev) {
      var p = localPos(ev);
      var hit = hitTest(p.x, p.y);
      if (!hit) return;
      if (hit.id === model.center) {
        toast("已经是中心节点：" + hit.name);
        return;
      }
      model.center = hit.id;
      draw();
      var url = new URL(location.href);
      url.searchParams.set("center", String(hit.id));
      history.replaceState(null, "", url.toString());
      $("#nv-center-name").textContent = hit.name;
    });

    window.addEventListener("resize", function () {
      if (!model.nodes.length) return;
      draw();
    });

    function reload() {
      return napi("/api/novel/novels/" + novelId + "/graph").then(function (data) {
        model.nodes = data.nodes || [];
        model.edges = data.edges || [];
        model.novel = data.novel;
        $("#nv-title").textContent = "《" + data.novel.name + "》· 关系网";
        document.title = data.novel.name + " · 关系网";
        $$("[data-link]").forEach(function (el) {
          el.setAttribute("href", el.getAttribute("data-link").replace("{id}", data.novel.novel_id));
        });

        var relBox = $("#nv-relations");
        if (!model.edges.length) {
          relBox.innerHTML = "<div class=\"nv-empty\">还没有关系数据。可在下方「新增关系」里连接两个角色。</div>";
        } else {
          relBox.innerHTML = model.edges.map(function (e) {
            return "<span class=\"nv-rel-chip\">" + esc(e.source_name) + " <b>" + esc(e.type) + "</b> " +
              esc(e.target_name) + "</span>";
          }).join("");
        }
        $("#nv-rel-count").textContent = model.edges.length;

        /* 默认中心：URL ?center= > 主角 > 第一个角色 */
        var fromUrl = parseInt(new URL(location.href).searchParams.get("center") || "0", 10);
        var center = 0;
        if (fromUrl && model.nodes.some(function (n) { return n.id === fromUrl; })) center = fromUrl;
        if (!center) {
          var lead = model.nodes.filter(function (n) { return n.is_protagonist; })[0];
          center = lead ? lead.id : (model.nodes[0] ? model.nodes[0].id : 0);
        }
        model.center = center;
        draw();
      });
    }

    /* 新增关系：下拉选两个角色 + 类型 */
    function fillSelects() {
      return napi("/api/novel/novels/" + novelId + "/characters").then(function (data) {
        var items = data.items || [];
        var options = items.map(function (c) {
          return "<option value=\"" + c.character_id + "\">" + esc(c.name) +
            (c.is_protagonist ? "（主角）" : "") + "</option>";
        }).join("");
        $$(".nv-select-char").forEach(function (sel) {
          var keep = sel.value;
          sel.innerHTML = "<option value=\"\">选择角色</option>" + options;
          sel.value = keep || "";
        });
      });
    }

    var relForm = $("#nv-rel-form");
    relForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var payload = readForm(relForm);
      if (!payload.character_a || !payload.character_b) {
        fail($("#nv-rel-err"), new Error("请先选择关系两端的角色"));
        return;
      }
      payload.character_a = parseInt(payload.character_a, 10);
      payload.character_b = parseInt(payload.character_b, 10);
      var btn = $("#nv-rel-submit");
      btn.disabled = true;
      napi("/api/novel/novels/" + novelId + "/relations", { method: "POST", body: payload })
        .then(function () {
          btn.disabled = false;
          $("#nv-rel-err").innerHTML = "";
          toast("关系已添加");
          return reload();
        })
        .catch(function (err) {
          btn.disabled = false;
          fail($("#nv-rel-err"), err);
        });
    });

    fillSelects().catch(function () { /* 游客也能看，选不到就算了 */ });
    reload().catch(function (err) { fail($("#nv-main"), err); });
  }

  /* ------------------------------------------------------------------ */
  /* 页面：独立阅读页（左章节目录 / 右正文）                              */
  /* ------------------------------------------------------------------ */

  function initRead() {
    var m = /^\/novel\/book\/(\d+)\/read\/(\d+)\/?$/.exec(location.pathname);
    var novelId = m ? parseInt(m[1], 10) : 0;
    var seq = m ? parseInt(m[2], 10) : 0;

    var tocPane = $("#nv-toc-pane");
    var tocList = $("#nv-toc");
    var contentBox = $("#nv-content");
    var reader = $("#nv-main");
    var prevEl = $("#nv-prev");
    var nextEl = $("#nv-next");

    if (!novelId || !seq) {
      fail(contentBox, new Error("阅读地址不合法，应为 /novel/book/<id>/read/<seq>"));
      return;
    }

    function readUrl(s) {
      return "/novel/book/" + novelId + "/read/" + s;
    }

    function paintToc(toc, current) {
      tocList.innerHTML = toc.map(function (c) {
        var no = c.seq < 10 ? "0" + c.seq : String(c.seq);
        return "<li class=\"nv-toc-item" + (c.seq === current ? " active" : "") + "\">" +
          "<a href=\"" + readUrl(c.seq) + "\" data-seq=\"" + c.seq + "\">" +
          "<span class=\"nv-toc-seq\">" + no + "</span>" + esc(c.title) + "</a></li>";
      }).join("");
      var active = $(".nv-toc-item.active", tocList);
      if (active && active.scrollIntoView) {
        active.scrollIntoView({ block: "center" });
      }
    }

    function paint(data) {
      var ch = data.chapter || {};
      var novel = data.novel || {};
      var bookName = novel.name || "书籍";
      var stamp = String(ch.created_at || "").slice(0, 16);

      document.title = "第 " + ch.seq + " 章 " + (ch.title || "") + " · " + bookName;
      $("#nv-toc-title").textContent = bookName;
      $("#nv-toc-meta").textContent = "共 " + data.total + " 章 · 正在读第 " + data.index + " 章";
      $("#nv-toc-back").setAttribute("href", "/novel/book/" + novelId);
      $("#nv-toc-back").textContent = "← 返回《" + bookName + "》目录";
      $("#nv-crumb-book").textContent = bookName;
      $("#nv-crumb-book").setAttribute("href", "/novel/book/" + novelId);

      $("#nv-ch-title").textContent = "第 " + ch.seq + " 章 · " + (ch.title || "无题");
      $("#nv-ch-meta").textContent = "作者 " + (novel.author || "匿名") + " · 本章 " + (ch.char_count || 0) +
        " 字" + (stamp ? " · " + stamp : "") + " · 进度 " + data.index + " / " + data.total;

      contentBox.textContent = ch.content || "（本章暂无正文）";
      paintToc(data.toc || [], ch.seq);

      if (data.prev_seq) {
        prevEl.hidden = false;
        prevEl.setAttribute("href", readUrl(data.prev_seq));
      } else {
        prevEl.hidden = true;
      }
      if (data.next_seq) {
        nextEl.hidden = false;
        nextEl.setAttribute("href", readUrl(data.next_seq));
      } else {
        nextEl.hidden = true;
      }
    }

    function scrollTop() {
      if (reader) reader.scrollTop = 0;
      window.scrollTo(0, 0);
    }

    function load(targetSeq, push) {
      contentBox.innerHTML = "<div class=\"nv-empty\">加载中…</div>";
      return napi("/api/novel/novels/" + novelId + "/read/" + targetSeq)
        .then(function (data) {
          seq = data.chapter.seq;
          paint(data);
          if (push) history.pushState({ seq: seq }, "", readUrl(seq));
          scrollTop();
        })
        .catch(function (err) {
          fail(contentBox, err);
        });
    }

    /* 左栏章节点击：不整页刷新，直接换正文并高亮当前章 */
    tocList.addEventListener("click", function (ev) {
      var node = ev.target;
      while (node && node !== tocList && !node.getAttribute("data-seq")) node = node.parentNode;
      if (!node || node === tocList) return;
      ev.preventDefault();
      var target = parseInt(node.getAttribute("data-seq"), 10);
      if (tocPane) tocPane.classList.remove("open");
      if (target && target !== seq) load(target, true);
    });

    var toggle = $("#nv-toc-toggle");
    if (toggle && tocPane) {
      toggle.addEventListener("click", function () {
        tocPane.classList.toggle("open");
      });
    }

    window.addEventListener("popstate", function () {
      var mm = /^\/novel\/book\/(\d+)\/read\/(\d+)\/?$/.exec(location.pathname);
      if (mm && parseInt(mm[1], 10) === novelId) {
        var s = parseInt(mm[2], 10);
        if (s && s !== seq) load(s, false);
      }
    });

    var bookLink = $("[data-book-link]");
    if (bookLink) bookLink.setAttribute("href", "/novel/book/" + novelId);

    load(seq, false);
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  loadMe();

  var inits = {
    list: initList,
    book: initBook,
    read: initRead,
    characters: initCharacters,
    character: initCharacter,
    timeline: initTimeline,
    graph: initGraph
  };

  if (inits[page]) {
    try {
      inits[page]();
    } catch (err) {
      var main = $("#nv-main") || document.body;
      fail(main, err);
    }
  }
})();
