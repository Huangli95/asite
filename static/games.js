/* ==========================================================================
   小游戏板块 · 大厅页脚本
   --------------------------------------------------------------------------
   游戏清单从 /api/games 拉取（服务端 GAMES 注册表），接口不可用时回退到内置清单，
   新增小游戏只需在 server.py 的 GAMES 中登记一条并放好页面即可。
   ========================================================================== */
(function () {
  "use strict";

  var grid = document.getElementById("gm-grid");
  if (!grid) return;

  var FALLBACK = [
    {
      key: "bounce",
      name: "弹球打砖",
      tag: "弹球",
      desc: "瞄准发射小球，靠边界反弹敲掉下落的小方块，+1 方块能永久加球；方块为正方形、一行可排 8-12 列，一屏可容 12 层，方块血量随波次与轮数递增（最高 20 击）；可选持续下落或按轮次逐行下降（前 3 行每 3 轮、接着 2 行每 2 轮、之后每轮），逐行下降还能开「补行」——每降一行顶部随机补一行（每行随机空 2-3 格），不必打通整阵",
      url: "/games/bounce",
      accent: "#63e6ff"
    }
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function card(g) {
    var accent = g.accent || "#63e6ff";
    return '' +
      '<a class="gm-card" href="' + esc(g.url) + '" style="--gm-accent:' + esc(accent) + '">' +
        '<div class="gm-thumb" aria-hidden="true">' +
          '<span class="gm-thumb-grid"></span>' +
          '<span class="gm-thumb-ball"></span>' +
          '<span class="gm-thumb-bar"></span>' +
        '</div>' +
        '<div class="gm-card-body">' +
          '<div class="gm-card-head">' +
            '<h2>' + esc(g.name) + '</h2>' +
            '<span class="gm-tag">' + esc(g.tag || "小游戏") + '</span>' +
          '</div>' +
          '<p>' + esc(g.desc || "") + '</p>' +
          '<span class="gm-play">开始游戏 <i>→</i></span>' +
        '</div>' +
      '</a>';
  }

  function render(list) {
    grid.innerHTML = list.map(card).join("");
  }

  fetch("/api/games", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      var list = data && data.games && data.games.length ? data.games : FALLBACK;
      render(list);
    })
    .catch(function () { render(FALLBACK); });
})();

