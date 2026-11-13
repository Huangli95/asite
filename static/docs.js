/* ==========================================================================
   深夜茶话会 · 接口文档页交互：代码复制 + 目录高亮
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------ 代码复制 ------------------------------ */
  document.querySelectorAll('pre').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.addEventListener('click', function () {
      var codeEl = pre.querySelector('code');
      var text = codeEl ? codeEl.innerText : pre.innerText;
      var done = function () {
        btn.textContent = '已复制';
        btn.classList.add('done');
        setTimeout(function () {
          btn.textContent = '复制';
          btn.classList.remove('done');
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
      } else {
        fallback(text, done);
      }
    });
    pre.appendChild(btn);
  });

  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  /* ------------------------------ 目录高亮 ------------------------------ */
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  var sections = links
    .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
    .filter(Boolean);

  if (!sections.length) return;

  function highlight() {
    var pos = window.scrollY + 110;
    var current = sections[0];
    sections.forEach(function (sec) {
      if (sec.offsetTop <= pos) current = sec;
    });
    links.forEach(function (a) {
      var on = a.getAttribute('href') === '#' + current.id;
      a.classList.toggle('active', on);
    });
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { highlight(); ticking = false; });
  }, { passive: true });

  links.forEach(function (a) {
    a.addEventListener('click', function (e) {
      var target = document.getElementById(a.getAttribute('href').slice(1));
      if (!target) return;
      e.preventDefault();
      window.scrollTo({ top: target.offsetTop - 14, behavior: 'smooth' });
      history.replaceState(null, '', a.getAttribute('href'));
    });
  });

  highlight();
})();
