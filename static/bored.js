/* 无聊一下 —— 一批没有任何用处的小页面，进来随机给一个
   场景约定：{ key, title, tip, mount(stage) -> cleanup() }
   全部为纯前端实现，不请求后端、不写 localStorage。 */
(function () {
  'use strict';

  var SCENES = [];

  function add(o) { SCENES.push(o); }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) { d.className = cls; }
    if (text !== undefined && text !== null) { d.textContent = String(text); }
    return d;
  }
  function rnd(n) { return Math.floor(Math.random() * n); }
  function pick(a) { return a[rnd(a.length)]; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 统一骨架：标题 + 一句说明 + 内容区 */
  function frame(sc) {
    var wrap = el('div', 'bd-scene');
    wrap.appendChild(el('h2', 'bd-title', sc.title));
    wrap.appendChild(el('p', 'bd-tip', sc.tip));
    var box = el('div', 'bd-box');
    wrap.appendChild(box);
    return { wrap: wrap, box: box };
  }

  /* ---------------------------------------------------------------- 1 */
  add({
    key: 'clicker',
    title: '无聊计数器',
    tip: '点一下，数字就多一。没有奖励，也不记录你能排第几。',
    mount: function (stage) {
      var f = frame(this);
      var n = 0;
      var num = el('div', 'bd-big', '0');
      var btn = el('button', 'bd-btn', '点一下');
      var note = el('p', 'bd-note', '目前什么都没有发生');
      var spent = el('p', 'bd-note bd-mute', '已在这里待了 0 秒');
      var reset = el('button', 'bd-link', '清零重来');
      f.box.appendChild(num);
      f.box.appendChild(btn);
      f.box.appendChild(note);
      f.box.appendChild(spent);
      f.box.appendChild(reset);

      var t0 = Date.now();
      var tick = setInterval(function () {
        spent.textContent = '已在这里待了 ' + Math.round((Date.now() - t0) / 1000) + ' 秒';
      }, 1000);

      btn.addEventListener('click', function () {
        n += 1;
        num.textContent = String(n);
        num.classList.remove('bd-pop');
        void num.offsetWidth;
        num.classList.add('bd-pop');
        if (n < 10) { note.textContent = '刚热身，接着点'; }
        else if (n < 50) { note.textContent = '有点上头了，这正是它的目的'; }
        else if (n < 100) { note.textContent = '手比脑子快的时候，一般就是这样'; }
        else { note.textContent = '数字只是数字，你确实很闲'; }
      });
      reset.addEventListener('click', function () {
        n = 0;
        num.textContent = '0';
        note.textContent = '目前什么都没有发生';
      });

      stage.appendChild(f.wrap);
      return function () { clearInterval(tick); };
    }
  });

  /* ---------------------------------------------------------------- 2 */
  add({
    key: 'breath',
    title: '跟着呼吸',
    tip: '吸气 4 秒、屏住 7 秒、呼气 8 秒。它不评价你做得对不对。',
    mount: function (stage) {
      var f = frame(this);
      var circle = el('div', 'bd-breath');
      var inner = el('span', 'bd-breath-t', '准备');
      circle.appendChild(inner);
      var cnt = el('p', 'bd-note bd-mute', '马上开始');
      f.box.appendChild(circle);
      f.box.appendChild(cnt);

      var steps = [
        { t: '吸气', sec: 4, scale: 1.42, cls: 'in' },
        { t: '屏住', sec: 7, scale: 1.42, cls: 'hold' },
        { t: '呼气', sec: 8, scale: 1, cls: 'out' }
      ];
      var timers = [];
      var alive = true;
      var i = 0;

      function run() {
        if (!alive) { return; }
        var s = steps[i % steps.length];
        inner.textContent = s.t;
        circle.className = 'bd-breath bd-breath--' + s.cls;
        circle.style.transitionDuration = (s.cls === 'hold' ? 0.5 : s.sec) + 's';
        circle.style.transform = 'scale(' + s.scale + ')';
        var left = s.sec;
        cnt.textContent = s.t + ' · 还剩 ' + left + ' 秒';
        var tick = setInterval(function () {
          left -= 1;
          if (left > 0) { cnt.textContent = s.t + ' · 还剩 ' + left + ' 秒'; }
        }, 1000);
        timers.push(tick);
        var to = setTimeout(function () {
          clearInterval(tick);
          i += 1;
          run();
        }, s.sec * 1000);
        timers.push(to);
      }
      run();

      stage.appendChild(f.wrap);
      return function () {
        alive = false;
        for (var k = 0; k < timers.length; k++) {
          clearInterval(timers[k]);
          clearTimeout(timers[k]);
        }
      };
    }
  });

  /* ---------------------------------------------------------------- 3 */
  add({
    key: 'coin',
    title: '抛硬币',
    tip: '正面和反面的概率都是五成。硬币不会替你决定任何事。',
    mount: function (stage) {
      var f = frame(this);
      var coin = el('div', 'bd-coin', '?');
      var btn = el('button', 'bd-btn', '抛一次');
      var stat = el('p', 'bd-note', '正面 0 · 反面 0');
      var note = el('p', 'bd-note bd-mute', '按一下开始');
      f.box.appendChild(coin);
      f.box.appendChild(btn);
      f.box.appendChild(stat);
      f.box.appendChild(note);

      var head = 0;
      var tail = 0;
      var busy = false;
      var to = 0;

      btn.addEventListener('click', function () {
        if (busy) { return; }
        busy = true;
        coin.classList.add('bd-coin--flip');
        coin.textContent = '';
        to = setTimeout(function () {
          var isHead = Math.random() < 0.5;
          coin.classList.remove('bd-coin--flip');
          coin.textContent = isHead ? '正' : '反';
          if (isHead) { head += 1; } else { tail += 1; }
          stat.textContent = '正面 ' + head + ' · 反面 ' + tail;
          note.textContent = isHead ? '正面。你可以再抛一次。' : '反面。也可以再抛一次。';
          busy = false;
        }, 850);
      });

      stage.appendChild(f.wrap);
      return function () { clearTimeout(to); };
    }
  });

  /* ---------------------------------------------------------------- 4 */
  add({
    key: 'dodge',
    title: '会躲的按钮',
    tip: '鼠标一靠近它就跑。跑到第八次它会放弃，那时候你就能点到了。',
    mount: function (stage) {
      var f = frame(this);
      var arena = el('div', 'bd-arena');
      var btn = el('button', 'bd-btn bd-dodge', '点我');
      arena.appendChild(btn);
      var note = el('p', 'bd-note', '它躲了 0 次');
      var after = el('p', 'bd-note bd-mute', '');
      f.box.appendChild(arena);
      f.box.appendChild(note);
      f.box.appendChild(after);

      var dodged = 0;
      var tired = false;

      function jump() {
        if (tired) { return; }
        var w = arena.clientWidth - btn.offsetWidth;
        var h = arena.clientHeight - btn.offsetHeight;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        btn.style.margin = '0';
        btn.style.left = clamp(rnd(Math.max(1, w)), 0, Math.max(0, w)) + 'px';
        btn.style.top = clamp(rnd(Math.max(1, h)), 0, Math.max(0, h)) + 'px';
        dodged += 1;
        if (dodged >= 8) {
          tired = true;
          note.textContent = '它躲了 8 次，累了';
          after.textContent = '现在可以点了';
          btn.textContent = '点吧';
        } else {
          note.textContent = '它躲了 ' + dodged + ' 次';
        }
      }

      btn.addEventListener('mouseenter', jump);
      btn.addEventListener('click', function (ev) {
        if (!tired) {
          ev.preventDefault();
          jump();
          return;
        }
        after.textContent = '你点到了。里面什么也没有，但它总算松了口气。';
        btn.textContent = '就这样';
      });

      stage.appendChild(f.wrap);
      return function () { };
    }
  });

  /* ---------------------------------------------------------------- 5 */
  add({
    key: 'loader',
    title: '永远差一点',
    tip: '这个进度条最多到 99%，然后就不动了。等下去也不会有结果。',
    mount: function (stage) {
      var f = frame(this);
      var bar = el('div', 'bd-progress');
      var fill = el('i', 'bd-progress-i');
      bar.appendChild(fill);
      var pct = el('div', 'bd-big', '0%');
      var note = el('p', 'bd-note', '正在准备…');
      var again = el('button', 'bd-link', '从头再来');
      f.box.appendChild(pct);
      f.box.appendChild(bar);
      f.box.appendChild(note);
      f.box.appendChild(again);

      var texts = [
        '正在整理宇宙尘埃…',
        '正在给数据排队…',
        '正在等待一个更好的时机…',
        '正在假装很忙…',
        '正在把 1 和 0 重新数一遍…',
        '马上就好（这句话已经说过很多次了）'
      ];
      var p = 0;
      var alive = true;
      var step = 0;
      var noteTimer = setInterval(function () {
        if (p < 98.6) { note.textContent = pick(texts); }
      }, 2600);

      function run() {
        if (!alive) { return; }
        var inc = Math.max(0.15, (100 - p) * 0.06);
        p = Math.min(99, p + inc);
        fill.style.width = p.toFixed(1) + '%';
        pct.textContent = Math.floor(p) + '%';
        if (p >= 98.6) { note.textContent = '快好了，就差最后一下（不会好的）'; }
        step = setTimeout(run, 420);
      }
      run();

      again.addEventListener('click', function () {
        p = 0;
        fill.style.width = '0%';
        pct.textContent = '0%';
        note.textContent = '正在准备…';
      });

      stage.appendChild(f.wrap);
      return function () {
        alive = false;
        clearTimeout(step);
        clearInterval(noteTimer);
      };
    }
  });

  /* ---------------------------------------------------------------- 6 */
  add({
    key: 'talk',
    title: '废话生成器',
    tip: '点一下出一句听着很有道理、实际什么也没说的话。可以复制走。',
    mount: function (stage) {
      var f = frame(this);
      var lead = ['经过一段时间的观察', '本着认真负责的态度', '在今天这样的日子里', '从整体来看', '换个角度说', '众所周知'];
      var sub = ['我们', '大家', '这件事', '你', '这一块'];
      var verb = ['需要', '应该', '可以考虑', '不妨', '值得'];
      var obj = ['先放一放', '再想一想', '喝口水', '把窗户打开', '什么都不做', '看一眼远处', '等一等再说', '保持现状'];

      function build() {
        return pick(lead) + '，' + pick(sub) + pick(verb) + pick(obj) + '。';
      }

      var btn = el('button', 'bd-btn', '来一句');
      var out = el('p', 'bd-quote', '点下面的按钮');
      var list = el('div', 'bd-list');
      f.box.appendChild(out);
      f.box.appendChild(btn);
      f.box.appendChild(list);

      btn.addEventListener('click', function () {
        var s = build();
        out.classList.remove('bd-pop');
        out.textContent = s;
        void out.offsetWidth;
        out.classList.add('bd-pop');
        var row = el('div', 'bd-listrow');
        var span = el('span', 'bd-listtext', s);
        var copy = el('button', 'bd-link', '复制');
        copy.addEventListener('click', function () {
          function done() { copy.textContent = '已复制'; }
          function fail() { copy.textContent = '复制失败'; }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(s).then(done, fail);
          } else {
            try {
              var ta = el('textarea', 'bd-hide');
              ta.value = s;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              done();
            } catch (e) { fail(); }
          }
          setTimeout(function () { copy.textContent = '复制'; }, 1600);
        });
        row.appendChild(span);
        row.appendChild(copy);
        list.insertBefore(row, list.firstChild);
        while (list.children.length > 6) { list.removeChild(list.lastChild); }
      });

      stage.appendChild(f.wrap);
      return function () { };
    }
  });

  /* ---------------------------------------------------------------- 7 */
  add({
    key: 'daze',
    title: '发呆一分钟',
    tip: '按下开始，什么都不用做。六十秒后它会告诉你刚刚什么都没发生。',
    mount: function (stage) {
      var f = frame(this);
      var big = el('div', 'bd-big', '60');
      var unit = el('p', 'bd-note bd-mute', '秒');
      var note = el('p', 'bd-note', '按开始，然后看着数字变小');
      var btn = el('button', 'bd-btn', '开始发呆');
      f.box.appendChild(big);
      f.box.appendChild(unit);
      f.box.appendChild(note);
      f.box.appendChild(btn);

      var left = 60;
      var timer = 0;
      var running = false;

      function stop() {
        clearInterval(timer);
        running = false;
      }

      btn.addEventListener('click', function () {
        if (running) {
          stop();
          note.textContent = '停了。你提前结束了发呆。';
          btn.textContent = '继续发呆';
          return;
        }
        if (left <= 0) { left = 60; big.textContent = '60'; }
        running = true;
        btn.textContent = '不想发了';
        note.textContent = '正在发呆…';
        timer = setInterval(function () {
          left -= 1;
          big.textContent = String(left > 0 ? left : 0);
          if (left <= 0) {
            stop();
            big.textContent = '0';
            note.textContent = '你刚刚认真地发呆了 60 秒，什么也没做。很好。';
            btn.textContent = '再来一次';
          }
        }, 1000);
      });

      stage.appendChild(f.wrap);
      return function () { stop(); };
    }
  });

  /* ---------------------------------------------------------------- 8 */
  add({
    key: 'trail',
    title: '光标尾迹',
    tip: '在这里随便晃晃鼠标（手机上用手指划）。它什么都不会留下。',
    mount: function (stage) {
      var f = frame(this);
      var canvas = el('canvas', 'bd-canvas');
      f.box.appendChild(canvas);
      stage.appendChild(f.wrap);

      var ctx = canvas.getContext('2d');
      var dpr = window.devicePixelRatio || 1;
      var dots = [];
      var alive = true;
      var raf = 0;

      function resize() {
        var w = canvas.clientWidth || 320;
        var h = canvas.clientHeight || 260;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      resize();

      function push(x, y) {
        dots.push({ x: x, y: y, life: 1 });
        if (dots.length > 220) { dots.shift(); }
      }

      function pos(ev) {
        var r = canvas.getBoundingClientRect();
        var p = (ev.touches && ev.touches[0]) ? ev.touches[0] : ev;
        return { x: p.clientX - r.left, y: p.clientY - r.top };
      }

      function onMove(ev) {
        var p = pos(ev);
        push(p.x, p.y);
      }

      function draw() {
        if (!alive) { return; }
        var w = canvas.clientWidth || 320;
        var h = canvas.clientHeight || 260;
        ctx.clearRect(0, 0, w, h);
        for (var i = 0; i < dots.length; i++) {
          var d = dots[i];
          d.life -= 0.012;
          if (d.life <= 0) { continue; }
          var r = 2 + (1 - d.life) * 26;
          ctx.beginPath();
          ctx.fillStyle = 'rgba(107,125,255,' + (d.life * 0.5).toFixed(3) + ')';
          ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        for (var k = dots.length - 1; k >= 0; k--) {
          if (dots[k].life <= 0) { dots.splice(k, 1); }
        }
        raf = requestAnimationFrame(draw);
      }
      draw();

      canvas.addEventListener('mousemove', onMove);
      canvas.addEventListener('touchmove', function (ev) {
        ev.preventDefault();
        onMove(ev);
      }, { passive: false });
      window.addEventListener('resize', resize);

      return function () {
        alive = false;
        cancelAnimationFrame(raf);
        canvas.removeEventListener('mousemove', onMove);
        window.removeEventListener('resize', resize);
      };
    }
  });

  /* ---------------------------------------------------------------- 9 */
  add({
    key: 'guess',
    title: '猜一个数',
    tip: '我心里有个 1 到 100 的整数。猜中了也没有奖励，只有一句话。',
    mount: function (stage) {
      var f = frame(this);
      var target = rnd(100) + 1;
      var tries = 0;

      var row = el('div', 'bd-row');
      var input = el('input', 'bd-input');
      input.type = 'number';
      input.min = '1';
      input.max = '100';
      input.placeholder = '1 - 100';
      var btn = el('button', 'bd-btn', '猜');
      row.appendChild(input);
      row.appendChild(btn);
      var note = el('p', 'bd-note', '还没开始猜');
      var again = el('button', 'bd-link', '换一个数');
      f.box.appendChild(row);
      f.box.appendChild(note);
      f.box.appendChild(again);

      function submit() {
        var v = parseInt(input.value, 10);
        if (isNaN(v) || v < 1 || v > 100) {
          note.textContent = '请填一个 1 到 100 之间的整数';
          return;
        }
        tries += 1;
        if (v < target) { note.textContent = '小了。已猜 ' + tries + ' 次'; }
        else if (v > target) { note.textContent = '大了。已猜 ' + tries + ' 次'; }
        else { note.textContent = '对了，就是 ' + target + '，你用了 ' + tries + ' 次。' + (tries <= 6 ? '还行。' : '也可以。'); }
        input.value = '';
        input.focus();
      }

      btn.addEventListener('click', submit);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { submit(); }
      });
      again.addEventListener('click', function () {
        target = rnd(100) + 1;
        tries = 0;
        note.textContent = '换好了，重新开始猜';
        input.value = '';
      });

      stage.appendChild(f.wrap);
      return function () { };
    }
  });

  /* --------------------------------------------------------------- 10 */
  add({
    key: 'bubble',
    title: '气泡纸',
    tip: '一张 64 个气泡的包装纸，捏破它们，没有别的事会发生。',
    mount: function (stage) {
      var f = frame(this);
      var grid = el('div', 'bd-bubble');
      var note = el('p', 'bd-note', '已捏 0 / 64');
      var jab = el('p', 'bd-note bd-mute bd-jab', ' ');
      var reset = el('button', 'bd-link', '换一张新的');
      f.box.appendChild(grid);
      f.box.appendChild(note);
      f.box.appendChild(jab);
      f.box.appendChild(reset);

      var total = 64;
      /* 每捏满 8 个，说一句毫无帮助的话 */
      var LINES = [
        '你真的挺无聊的',
        '这些气泡跟你没仇',
        '捏完了也没人会夸你',
        '手指头开始发麻了吧',
        '现在停手还来得及',
        '这张纸的成本是三毛钱',
        '最后几个了，别走神'
      ];
      var jabTimer = null;

      function say(text) {
        jab.textContent = text;
        if (jabTimer) { clearTimeout(jabTimer); }
        jabTimer = setTimeout(function () {
          jab.textContent = ' ';
          jabTimer = null;
        }, 2800);
      }

      function build() {
        grid.innerHTML = '';
        for (var i = 0; i < total; i++) {
          grid.appendChild(el('span', 'bd-bub'));
        }
        note.textContent = '已捏 0 / ' + total;
        if (jabTimer) { clearTimeout(jabTimer); jabTimer = null; }
        jab.textContent = ' ';
      }

      function onClick(ev) {
        var t = ev.target;
        if (!t || t.className.indexOf('bd-bub') < 0) { return; }
        if (t.classList.contains('is-pop')) { return; }
        t.classList.add('is-pop');
        var done = grid.querySelectorAll('.bd-bub.is-pop').length;
        if (done >= total) {
          note.textContent = '整张都捏完了，一共 ' + total + ' 个。爽了吗？';
          say('捏完了，什么都没发生');
        } else {
          note.textContent = '已捏 ' + done + ' / ' + total;
          if (done % 8 === 0 && done / 8 <= LINES.length) {
            say(LINES[done / 8 - 1]);
          }
        }
      }

      grid.addEventListener('click', onClick);
      reset.addEventListener('click', build);
      build();

      stage.appendChild(f.wrap);
      return function () {
        grid.removeEventListener('click', onClick);
        if (jabTimer) { clearTimeout(jabTimer); jabTimer = null; }
      };
    }
  });

  /* --------------------------------------------------------------- 11 */
  add({
    key: 'muyu',
    title: '敲木鱼',
    tip: '敲一下，功德加一。敲到手酸也不会真的多出什么。',
    mount: function (stage) {
      var f = frame(this);

      var merit = el('div', 'bd-merit');
      var numEl = el('span', 'bd-merit-num', '0');
      merit.appendChild(numEl);
      merit.appendChild(el('em', 'bd-merit-unit', '功德'));

      var arena = el('div', 'bd-muyu-arena');
      var muyu = el('div', 'bd-muyu');
      muyu.setAttribute('role', 'button');
      muyu.setAttribute('tabindex', '0');
      muyu.setAttribute('aria-label', '敲一下木鱼');

      var body = el('div', 'bd-muyu-body');
      body.appendChild(el('i', 'bd-muyu-slot'));
      body.appendChild(el('i', 'bd-muyu-eye'));
      var stick = el('div', 'bd-muyu-stick');
      var hand = el('div', 'bd-muyu-hand');
      hand.appendChild(el('i', 'bd-hand-palm'));
      muyu.appendChild(body);
      muyu.appendChild(stick);
      muyu.appendChild(hand);

      var fx = el('div', 'bd-muyu-fx');
      arena.appendChild(muyu);
      arena.appendChild(fx);

      var note = el('p', 'bd-note', '还没有开始积德');
      var hint = el('p', 'bd-note bd-mute', '也可以用空格或回车敲');
      var reset = el('button', 'bd-link', '功德清零');

      f.box.appendChild(merit);
      f.box.appendChild(arena);
      f.box.appendChild(note);
      f.box.appendChild(hint);
      f.box.appendChild(reset);

      var n = 0;
      var actx = null;
      var timers = [];

      function line(k) {
        if (k < 10) { return '手感还在找'; }
        if (k < 50) { return '节奏有了，功德 ' + k; }
        if (k < 108) { return '手腕开始发酸，功德 ' + k; }
        if (k === 108) { return '一百零八下，不多不少'; }
        if (k < 1000) { return '继续敲，这个数字没有上限'; }
        return '木鱼还在，你也可以停了';
      }

      function tone(flat) {
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) { return; }
          if (!actx) { actx = new AC(); }
          if (actx.state === 'suspended' && actx.resume) { actx.resume(); }
          var t = actx.currentTime;
          var osc = actx.createOscillator();
          var gain = actx.createGain();
          osc.type = flat ? 'sawtooth' : 'triangle';
          osc.frequency.setValueAtTime(flat ? 150 : 250, t);
          osc.frequency.exponentialRampToValueAtTime(flat ? 62 : 92, t + 0.14);
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(flat ? 0.18 : 0.30, t + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + (flat ? 0.20 : 0.30));
          osc.connect(gain);
          gain.connect(actx.destination);
          osc.start(t);
          osc.stop(t + (flat ? 0.22 : 0.32));
        } catch (e) { /* 不支持 WebAudio 时静音 */ }
      }

      function floatText(txt, bad) {
        var s = el('span', bad ? 'bd-float bd-float--bad' : 'bd-float', txt);
        s.style.left = (30 + rnd(36)) + '%';
        s.style.top = (10 + rnd(20)) + '%';
        fx.appendChild(s);
        timers.push(setTimeout(function () {
          if (s.parentNode) { s.parentNode.removeChild(s); }
        }, 900));
      }

      /* 手滑事故：木槌偶尔被敲飞，功德 -6，再由一只手把它捡回来 */
      var CHANCE = 0.04;
      var busy = false;

      function accident(del) {
        busy = true;
        muyu.classList.remove('is-hit');
        muyu.classList.add('is-fly');
        numEl.classList.remove('is-hurt');
        void numEl.offsetWidth;
        numEl.classList.add('is-hurt');
        timers.push(setTimeout(function () { numEl.classList.remove('is-hurt'); }, 560));
        floatText(del > 0 ? '功德 -' + del : '功德 0', true);
        tone(true);
        note.textContent = del > 0
          ? '手一滑，木槌飞了出去，功德 -' + del
          : '手一滑，木槌飞了出去（功德不够，没扣成）';

        timers.push(setTimeout(function () {
          hand.classList.add('is-in');
          note.textContent = '有只手从旁边伸了过来';
        }, 740));

        timers.push(setTimeout(function () {
          hand.classList.add('is-out');
          stick.classList.add('is-taken');
          note.textContent = '木槌被捡走了';
        }, 1320));

        timers.push(setTimeout(function () {
          hand.classList.remove('is-in');
          hand.classList.remove('is-out');
          muyu.classList.remove('is-fly');
          stick.classList.remove('is-taken');
          stick.classList.add('is-back');
          note.textContent = '木槌放回来了，继续敲';
        }, 1880));

        timers.push(setTimeout(function () {
          stick.classList.remove('is-back');
          busy = false;
        }, 2380));
      }

      function hit() {
        if (busy) { return; }
        n += 1;
        numEl.textContent = String(n);
        muyu.classList.remove('is-hit');
        void muyu.offsetWidth;
        muyu.classList.add('is-hit');
        floatText('功德 +1', false);
        tone(false);
        note.textContent = line(n);
        if (Math.random() < CHANCE) {
          var del = Math.min(6, n);
          n -= del;
          numEl.textContent = String(n);
          accident(del);
        }
      }

      function onKey(ev) {
        if (ev.key === ' ' || ev.key === 'Spacebar' || ev.key === 'Enter') {
          ev.preventDefault();
          hit();
        }
      }

      function onReset() {
        n = 0;
        numEl.textContent = '0';
        fx.innerHTML = '';
        busy = false;
        numEl.classList.remove('is-hurt');
        muyu.classList.remove('is-hit');
        muyu.classList.remove('is-fly');
        stick.classList.remove('is-taken');
        stick.classList.remove('is-back');
        hand.classList.remove('is-in');
        hand.classList.remove('is-out');
        note.textContent = '功德清零，刚才全白敲了';
      }

      muyu.addEventListener('click', hit);
      muyu.addEventListener('keydown', onKey);
      reset.addEventListener('click', onReset);

      stage.appendChild(f.wrap);
      return function () {
        muyu.removeEventListener('click', hit);
        muyu.removeEventListener('keydown', onKey);
        reset.removeEventListener('click', onReset);
        for (var i = 0; i < timers.length; i++) { clearTimeout(timers[i]); }
        timers.length = 0;
        if (actx) {
          try { actx.close(); } catch (e) { /* 忽略关闭异常 */ }
          actx = null;
        }
      };
    }
  });

  /* --------------------------------------------------------------- 12 */
  add({
    key: 'train',
    title: '等一趟小火车',
    tip: '它从左开到右，不停站，也不带你去哪。',
    mount: function (stage) {
      var f = frame(this);
      var rail = el('div', 'bd-rail');
      rail.appendChild(el('div', 'bd-rail-line'));
      var train = el('div', 'bd-train');
      var loco = el('div', 'bd-loco');
      loco.appendChild(el('span', 'bd-smoke'));
      loco.appendChild(el('span', 'bd-smoke bd-smoke--b'));
      loco.appendChild(el('span', 'bd-smoke bd-smoke--c'));
      loco.appendChild(el('i', 'bd-wheel'));
      loco.appendChild(el('i', 'bd-wheel bd-wheel--b'));
      train.appendChild(loco);
      for (var ci = 0; ci < 2; ci++) {
        var car = el('div', 'bd-car');
        car.appendChild(el('i', 'bd-wheel'));
        train.appendChild(car);
      }
      rail.appendChild(train);
      var note = el('p', 'bd-note', '车还没来。');
      var count = el('p', 'bd-note bd-mute', '你已经等了 0 趟。');
      var btn = el('button', 'bd-btn', '再等一趟');
      var lines = [
        '车开过去了。没有一节车厢是给你的。',
        '又过去一趟。方向一样，速度也一样。',
        '第三趟了。站台上还是只有你一个人。',
        '车走了。它并不知道你在等。'
      ];
      var runs = 0;
      var t = null;
      function run() {
        if (t) { clearTimeout(t); t = null; }
        train.classList.remove('is-run');
        /* 读一次宽度强制重排，动画才会从头再放一遍 */
        void train.offsetWidth;
        train.classList.add('is-run');
        note.textContent = '车正在开过来……';
        t = setTimeout(function () {
          t = null;
          runs++;
          count.textContent = '你已经等了 ' + runs + ' 趟。';
          note.textContent = runs <= lines.length ? lines[runs - 1] : '车不会回来了。这个站早就废弃了。';
          btn.textContent = runs >= 4 ? '再等也没用' : '再等一趟';
        }, 7000);
      }
      btn.addEventListener('click', run);
      f.box.appendChild(rail);
      f.box.appendChild(note);
      f.box.appendChild(count);
      f.box.appendChild(btn);
      stage.appendChild(f.wrap);
      run();
      return function () {
        btn.removeEventListener('click', run);
        if (t) { clearTimeout(t); t = null; }
      };
    }
  });

  /* --------------------------------------------------------------- 13 */
  add({
    key: 'sunset',
    title: '看一眼日落',
    tip: '十四秒，比真的日落快一点，也没人陪你看。',
    mount: function (stage) {
      var f = frame(this);
      var sky = el('div', 'bd-sky');
      sky.appendChild(el('i', 'bd-sun'));
      sky.appendChild(el('i', 'bd-sea'));
      var note = el('p', 'bd-note', '太阳还在上面，还有 14 秒。');
      var btn = el('button', 'bd-btn', '等不及了');
      var iv = null;
      function finish() {
        if (!iv) { return; }
        clearInterval(iv);
        iv = null;
        sky.classList.add('is-dusk');
        sky.classList.add('is-done');
        note.textContent = '太阳沉下去了。今天就这样，明天还会有一次。';
        btn.textContent = '再看一次';
      }
      function start() {
        if (iv) { clearInterval(iv); iv = null; }
        sky.classList.remove('is-done');
        sky.classList.remove('is-dusk');
        var left = 14;
        note.textContent = '太阳还在上面，还有 14 秒。';
        btn.textContent = '等不及了';
        iv = setInterval(function () {
          left--;
          if (left > 0) {
            note.textContent = '太阳还在上面，还有 ' + left + ' 秒。';
            return;
          }
          finish();
        }, 1000);
      }
      function onBtn() {
        if (iv) { finish(); return; }
        start();
      }
      btn.addEventListener('click', onBtn);
      f.box.appendChild(sky);
      f.box.appendChild(note);
      f.box.appendChild(btn);
      stage.appendChild(f.wrap);
      start();
      return function () {
        btn.removeEventListener('click', onBtn);
        if (iv) { clearInterval(iv); iv = null; }
      };
    }
  });

  /* --------------------------------------------------------------- 14 */
  add({
    key: 'cat',
    title: '一只猫路过',
    tip: '它从右边走过来，绕开你，再走出去。',
    mount: function (stage) {
      var f = frame(this);
      var street = el('div', 'bd-street');
      var cat = el('div', 'bd-cat');
      cat.appendChild(el('i', 'bd-cat-tail'));
      cat.appendChild(el('i', 'bd-cat-body'));
      cat.appendChild(el('i', 'bd-cat-leg'));
      cat.appendChild(el('i', 'bd-cat-leg bd-cat-leg--b'));
      cat.appendChild(el('i', 'bd-cat-head'));
      street.appendChild(cat);
      var note = el('p', 'bd-note', '街上什么也没有。');
      var count = el('p', 'bd-note bd-mute', '过去 0 只。');
      var btn = el('button', 'bd-btn', '再叫一只');
      var lines = [
        '猫走过去了，没看你一眼。',
        '第二只。它比第一只走得还快。',
        '你叫了一声，它停了一下，然后继续走。',
        '猫不觉得这条街无聊，它只是路过。'
      ];
      var n = 0;
      var t = null;
      function walk() {
        if (t) { clearTimeout(t); t = null; }
        cat.classList.remove('is-walk');
        void cat.offsetWidth;
        cat.classList.add('is-walk');
        note.textContent = '猫正在走过来……';
        t = setTimeout(function () {
          t = null;
          n++;
          count.textContent = '过去 ' + n + ' 只。';
          note.textContent = lines[(n - 1) % lines.length];
          btn.textContent = n >= 4 ? '这条街上没猫了' : '再叫一只';
        }, 6000);
      }
      btn.addEventListener('click', walk);
      f.box.appendChild(street);
      f.box.appendChild(note);
      f.box.appendChild(count);
      f.box.appendChild(btn);
      stage.appendChild(f.wrap);
      walk();
      return function () {
        btn.removeEventListener('click', walk);
        if (t) { clearTimeout(t); t = null; }
      };
    }
  });

  /* --------------------------------------------------------------- 15 */
  add({
    key: 'typer',
    title: '一个字一个字',
    tip: '它只会把句子打完，再一个字一个字删掉。',
    mount: function (stage) {
      var f = frame(this);
      var box = el('div', 'bd-type');
      var txt = el('span', 'bd-type-text', '');
      box.appendChild(txt);
      box.appendChild(el('span', 'bd-caret'));
      var note = el('p', 'bd-note bd-mute', '第 1 句。');
      var btn = el('button', 'bd-btn', '换一句');
      var lines = [
        '你打开这个页面，页面也没有什么想说的。',
        '如果你正在看这一行字，说明你现在确实没什么事做。',
        '这里没有故事，只有一句一句打出来又删掉的废话。',
        '看完它，你大概也记不住它写了什么。',
        '你可以关掉了。也不着急。'
      ];
      var li = 0;
      var pos = 0;
      var phase = 'type';
      var t = null;
      function step() {
        var s = lines[li];
        if (phase === 'type') {
          pos++;
          txt.textContent = s.slice(0, pos);
          if (pos >= s.length) {
            phase = 'hold';
            t = setTimeout(step, 1600);
            return;
          }
          t = setTimeout(step, 90);
          return;
        }
        if (phase === 'hold') {
          phase = 'erase';
          t = setTimeout(step, 60);
          return;
        }
        pos--;
        txt.textContent = s.slice(0, pos > 0 ? pos : 0);
        if (pos <= 0) {
          li = (li + 1) % lines.length;
          note.textContent = '第 ' + (li + 1) + ' 句。';
          phase = 'type';
          pos = 0;
          t = setTimeout(step, 640);
          return;
        }
        t = setTimeout(step, 40);
      }
      function skip() {
        if (t) { clearTimeout(t); t = null; }
        li = (li + 1) % lines.length;
        note.textContent = '第 ' + (li + 1) + ' 句。';
        phase = 'type';
        pos = 0;
        txt.textContent = '';
        t = setTimeout(step, 60);
      }
      btn.addEventListener('click', skip);
      f.box.appendChild(box);
      f.box.appendChild(note);
      f.box.appendChild(btn);
      stage.appendChild(f.wrap);
      step();
      return function () {
        btn.removeEventListener('click', skip);
        if (t) { clearTimeout(t); t = null; }
      };
    }
  });

  /* --------------------------------------------------------------- 16 */
  add({
    key: 'boot',
    title: '启动一个不存在的游戏',
    tip: '引擎、着色器、反作弊都在加载，只有游戏还没加载。',
    mount: function (stage) {
      var f = frame(this);
      var screen = el('div', 'bd-boot');
      var head = el('div', 'bd-boot-head');
      head.appendChild(el('span', 'bd-boot-dot'));
      head.appendChild(el('span', 'bd-boot-name', 'marvis-engine.exe'));
      var status = el('span', 'bd-boot-status', '正在启动');
      head.appendChild(status);
      var log = el('div', 'bd-boot-log');
      var foot = el('div', 'bd-boot-foot');
      var bar = el('div', 'bd-boot-bar');
      var fill = el('div', 'bd-boot-fill');
      var pct = el('span', 'bd-boot-pct', '0%');
      bar.appendChild(fill);
      foot.appendChild(bar);
      foot.appendChild(pct);
      var big = el('div', 'bd-boot-big', '');
      screen.appendChild(head);
      screen.appendChild(log);
      screen.appendChild(foot);
      screen.appendChild(big);
      var btn = el('button', 'bd-btn', '进入游戏');
      var hint = el('p', 'bd-note bd-mute', '别按太快，它还要加载一会儿。');
      var phase = 'loading';
      var dialog = null;
      var timers = [];

      function later(fn, ms) {
        var id = setTimeout(function () {
          if (!screen.isConnected) { return; }
          fn();
        }, ms);
        timers.push(id);
      }
      function clearTimers() {
        for (var i = 0; i < timers.length; i++) { clearTimeout(timers[i]); }
        timers.length = 0;
      }
      function line(text) {
        log.appendChild(el('div', 'bd-boot-line', text));
        if (log.children.length > 80) { log.removeChild(log.children[0]); }
        log.scrollTop = log.scrollHeight;
      }
      function setP(v) {
        fill.style.width = v + '%';
        pct.textContent = v + '%';
      }
      function hideDialog() {
        if (dialog && dialog.parentNode) { dialog.parentNode.removeChild(dialog); }
        dialog = null;
      }
      function plan() {
        var q = [];
        function push(text, p, d) {
          q.push({ text: text, p: p, d: d });
        }
        push('Marvis Engine 5.2.1 (build 20261125) · 正在启动', 4, 300);
        push('检测显示适配器…', 8, 420);
        push('初始化渲染后端：Vulkan 1.3', 13, 380);
        push('分配显存 4096 MB … 完成', 17, 300);
        push('编译着色器 0/1584', 20, 200);
        for (var i = 1; i <= 4; i++) {
          push('编译着色器 ' + (i * 396) + '/1584', 20 + i * 4, 380);
        }
        push('加载纹理包 assets.pak (7.4 GB)', 40, 420);
        push('解码音频流 48 kHz … 完成', 46, 300);
        push('初始化物理子系统', 52, 360);
        push('启动反作弊驱动 · 检查中', 58, 480);
        push('反作弊未发现问题（它没有认真看）', 63, 320);
        push('读取存档槽位 1 … 空', 68, 300);
        push('连接游戏服务器', 74, 420);
        push('握手成功，正在同步世界状态', 82, 420);
        push('加载地图区块 37/38', 90, 420);
        push('预编译后处理管线', 95, 380);
        push('准备就绪，99%', 99, 500);
        return q;
      }
      function showDialog() {
        if (dialog) { return; }
        dialog = el('div', 'bd-boot-dialog');
        dialog.appendChild(el('div', 'bd-boot-dlg-title', 'Marvis Engine 没有响应'));
        dialog.appendChild(el('div', 'bd-boot-dlg-text', '该程序正在等待一个数据包，它不知道还要等多久。'));
        var row = el('div', 'bd-boot-dlg-row');
        var w = el('button', 'bd-dlg-btn', '等待');
        var c = el('button', 'bd-dlg-btn bd-dlg-btn--ghost', '关闭程序');
        row.appendChild(w);
        row.appendChild(c);
        dialog.appendChild(row);
        screen.appendChild(dialog);
        w.addEventListener('click', function () {
          hideDialog();
          line('你选择了等待。它没有因此变快。');
        });
        c.addEventListener('click', function () {
          hideDialog();
          line('程序已关闭。它其实一直没有启动过。');
          over('关闭了。里面什么都没有。');
        });
      }
      function stall() {
        status.textContent = '等待响应';
        var msgs = [
          '正在等待服务器最后一个数据包…',
          '等待中 · 已用 3 秒',
          '重试 1/3 …',
          '重试 2/3 …',
          '重试 3/3 …',
          '这不是你的网络问题。'
        ];
        var k = 0;
        function tick() {
          if (k >= msgs.length) { finish(); return; }
          line(msgs[k]);
          k++;
          if (k === 2) { showDialog(); }
          later(tick, 1150);
        }
        tick();
      }
      function finish() {
        hideDialog();
        setP(100);
        status.textContent = '就绪';
        line('启动完成。');
        phase = 'ready';
        btn.textContent = '进入游戏';
        hint.textContent = '按一下，游戏就在里面。';
      }
      function over(text) {
        clearTimers();
        hideDialog();
        phase = 'ended';
        screen.classList.add('is-black');
        big.textContent = text;
        btn.textContent = '重新启动';
        hint.textContent = '重新启动也不会有什么不同。';
      }
      function enter() {
        if (phase === 'ready') {
          over('其实没有这个游戏。');
          return;
        }
        if (phase === 'ended') {
          start();
          return;
        }
        line('还没加载完。');
      }
      function start() {
        clearTimers();
        hideDialog();
        log.innerHTML = '';
        big.textContent = '';
        screen.classList.remove('is-black');
        setP(0);
        status.textContent = '正在启动';
        phase = 'loading';
        btn.textContent = '进入游戏';
        hint.textContent = '别按太快，它还要加载一会儿。';
        var q = plan();
        var i = 0;
        function step() {
          if (i >= q.length) { stall(); return; }
          var s = q[i++];
          line(s.text);
          setP(s.p);
          later(step, s.d);
        }
        step();
      }
      btn.addEventListener('click', enter);
      f.box.appendChild(screen);
      f.box.appendChild(btn);
      f.box.appendChild(hint);
      stage.appendChild(f.wrap);
      start();
      return function () {
        btn.removeEventListener('click', enter);
        clearTimers();
        hideDialog();
      };
    }
  });

  /* --------------------------------------------------------------- 17 */
  add({
    key: 'chaos',
    title: '两个混沌摆画一条线',
    tip: '一个摆给出横坐标，另一个给出纵坐标。两个摆各转各的，线画成什么样全看这一个系统。',
    mount: function (stage) {
      var f = frame(this);
      var box = el('div', 'bd-chaos-box');
      var canvas = el('canvas', 'bd-chaos');
      var note = el('p', 'bd-note', '');
      var veil = el('div', 'bd-chaos-veil');
      var vTitle = el('p', 'bd-chaos-veil-t', '先停一下');
      var vSub = el('p', 'bd-chaos-veil-s', '');
      var btns = el('div', 'bd-chaos-btns');
      var btnGo = el('button', 'bd-btn', '继续绘制');
      var btnNew = el('button', 'bd-ghost', '重新随机');
      btns.appendChild(btnGo);
      btns.appendChild(btnNew);
      veil.appendChild(vTitle);
      veil.appendChild(vSub);
      veil.appendChild(btns);
      box.appendChild(canvas);
      box.appendChild(veil);
      f.box.appendChild(box);
      f.box.appendChild(note);
      stage.appendChild(f.wrap);

      var ctx = canvas.getContext('2d');
      var dpr = window.devicePixelRatio || 1;
      var H = 1 / 240;      /* 物理步长（秒） */
      var SPAN = 15;        /* 每段绘制时长（秒） */
      var DECIM = 2;        /* 两个物理步取一个点 */
      var LIMIT = 2400;     /* 最多保留的点数 */
      var alive = true;
      var raf = 0;
      var paused = false;
      var acc = 0;
      var last = 0;
      var tick = 0;
      var pts = [];         /* 扁平数组：x1,y1,x2,y2 …，归一化到 [-1,1] */
      var pa = null;        /* X 坐标来源摆 */
      var pb = null;        /* Y 坐标来源摆 */
      var pal = { accent: '#6b7dff', line: 'rgba(120,135,180,.22)', ghost: '#8d99bd' };

      function now() {
        return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
      }

      function readPal() {
        if (!window.getComputedStyle) { return; }
        var cs = window.getComputedStyle(document.documentElement);
        var a = (cs.getPropertyValue('--t-accent') || '').replace(/^\s+|\s+$/g, '');
        var l = (cs.getPropertyValue('--t-line-2') || '').replace(/^\s+|\s+$/g, '');
        var g = (cs.getPropertyValue('--t-ink-3') || '').replace(/^\s+|\s+$/g, '');
        pal = { accent: a || '#6b7dff', line: l || 'rgba(120,135,180,.22)', ghost: g || '#8d99bd' };
      }

      function makePend() {
        var L1 = 0.34 + Math.random() * 0.3;
        return {
          m1: 0.6 + Math.random() * 1.5,
          m2: 0.4 + Math.random() * 1.3,
          L1: L1,
          L2: 1 - L1,
          a1: (Math.random() * 2 - 1) * 2.4,
          a2: (Math.random() * 2 - 1) * 2.4,
          w1: (Math.random() * 2 - 1) * 0.6,
          w2: (Math.random() * 2 - 1) * 0.6
        };
      }

      function deriv(p, s) {
        var a1 = s[0], a2 = s[1], w1 = s[2], w2 = s[3];
        var m1 = p.m1, m2 = p.m2, L1 = p.L1, L2 = p.L2;
        var d = a1 - a2;
        var den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
        var dw1 = (-9.81 * (2 * m1 + m2) * Math.sin(a1)
          - m2 * 9.81 * Math.sin(a1 - 2 * a2)
          - 2 * Math.sin(d) * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(d))) / (L1 * den);
        var dw2 = (2 * Math.sin(d) * (w1 * w1 * L1 * (m1 + m2)
          + 9.81 * (m1 + m2) * Math.cos(a1)
          + w2 * w2 * L2 * m2 * Math.cos(d))) / (L2 * den);
        return [w1, w2, dw1, dw2];
      }

      function rk4(p, h) {
        var s0 = [p.a1, p.a2, p.w1, p.w2];
        var hh = h * 0.5;
        var k1 = deriv(p, s0);
        var s1 = [s0[0] + hh * k1[0], s0[1] + hh * k1[1], s0[2] + hh * k1[2], s0[3] + hh * k1[3]];
        var k2 = deriv(p, s1);
        var s2 = [s0[0] + hh * k2[0], s0[1] + hh * k2[1], s0[2] + hh * k2[2], s0[3] + hh * k2[3]];
        var k3 = deriv(p, s2);
        var s3 = [s0[0] + h * k3[0], s0[1] + h * k3[1], s0[2] + h * k3[2], s0[3] + h * k3[3]];
        var k4 = deriv(p, s3);
        p.a1 = s0[0] + h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
        p.a2 = s0[1] + h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
        p.w1 = s0[2] + h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
        p.w2 = s0[3] + h / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]);
        if (!isFinite(p.a1) || !isFinite(p.a2) || !isFinite(p.w1) || !isFinite(p.w2)) {
          p.a1 = (Math.random() * 2 - 1) * 2.4;
          p.a2 = (Math.random() * 2 - 1) * 2.4;
          p.w1 = (Math.random() * 2 - 1) * 0.6;
          p.w2 = (Math.random() * 2 - 1) * 0.6;
        }
      }

      function pushTip() {
        var nx = pa.L1 * Math.sin(pa.a1) + pa.L2 * Math.sin(pa.a2);
        var ny = pb.L1 * Math.cos(pb.a1) + pb.L2 * Math.cos(pb.a2);
        pts.push(nx, ny);
        if (pts.length > LIMIT * 2 + 600) { pts.splice(0, 600); }
      }

      /* 两个摆的淡色姿态示意图：只作横纵坐标来源的参照，不抢轨迹线 */
      function drawMini(p, px, py, sc, label) {
        if (!p) { return; }
        var jx = px + sc * p.L1 * Math.sin(p.a1);
        var jy = py + sc * p.L1 * Math.cos(p.a1);
        var tx = jx + sc * p.L2 * Math.sin(p.a2);
        var ty = jy + sc * p.L2 * Math.cos(p.a2);
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = pal.ghost;
        ctx.fillStyle = pal.ghost;
        ctx.lineWidth = 1;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(jx, jy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(jx, jy, 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.42;
        ctx.beginPath();
        ctx.arc(tx, ty, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.5;
        ctx.font = '10px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, px, py + sc + 11);
        ctx.restore();
      }

      function render() {
        var w = canvas.clientWidth || 320;
        var h = canvas.clientHeight || 300;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = pal.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(w / 2) + .5, 0);
        ctx.lineTo(Math.round(w / 2) + .5, h);
        ctx.moveTo(0, Math.round(h / 2) + .5);
        ctx.lineTo(w, Math.round(h / 2) + .5);
        ctx.stroke();

        /* 两个摆本体：画得很淡，衬在下层 */
        var mini = Math.min(w, h) * 0.15;
        drawMini(pa, w - mini - 12, 16, mini, 'X 摆');
        drawMini(pb, mini + 12, 16, mini, 'Y 摆');

        var r = Math.min(w, h) * 0.44;
        var cx = w / 2, cy = h / 2;
        if (pts.length >= 4) {
          ctx.strokeStyle = pal.accent;
          ctx.globalAlpha = 0.82;
          ctx.lineWidth = 1.4;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx + pts[0] * r, cy + pts[1] * r);
          for (var i = 2; i < pts.length; i += 2) {
            ctx.lineTo(cx + pts[i] * r, cy + pts[i + 1] * r);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (pts.length >= 2) {
          var hx = cx + pts[pts.length - 2] * r;
          var hy = cy + pts[pts.length - 1] * r;
          ctx.fillStyle = pal.accent;
          ctx.globalAlpha = 0.2;
          ctx.beginPath();
          ctx.arc(hx, hy, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(hx, hy, 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      function resize() {
        var w = canvas.clientWidth || 320;
        var h = canvas.clientHeight || 300;
        dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        render();
      }

      function stopRaf() {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
      }

      function pause() {
        paused = true;
        stopRaf();
        vSub.textContent = '这一段画了 ' + SPAN + ' 秒，落下 ' + Math.round(pts.length / 2)
          + ' 个点。可以接着画，也可以换两个新的摆。';
        veil.classList.add('on');
        note.textContent = '已暂停 · ' + SPAN + 's / ' + SPAN + 's';
        render();
      }

      function run() {
        if (raf || !alive || paused) { return; }
        last = now();
        raf = requestAnimationFrame(draw);
      }

      function draw() {
        raf = 0;
        if (!alive || paused) { return; }
        var t = now();
        var dt = (t - last) / 1000;
        last = t;
        if (dt < 0) { dt = 0; }
        if (dt > 0.12) { dt = 0.12; }
        acc += dt;
        var steps = Math.round(dt / H);
        if (steps < 1) { steps = 1; }
        if (steps > 40) { steps = 40; }
        for (var i = 0; i < steps; i++) {
          rk4(pa, H);
          rk4(pb, H);
          if ((i + 1) % DECIM === 0) { pushTip(); }
        }
        tick++;
        if (tick % 10 === 0) { readPal(); }
        render();
        if (tick % 6 === 0) {
          note.textContent = '绘制中 · ' + acc.toFixed(1) + 's / ' + SPAN + 's';
        }
        if (acc >= SPAN) { pause(); return; }
        raf = requestAnimationFrame(draw);
      }

      function fresh() {
        stopRaf();
        pa = makePend();
        pb = makePend();
        pts = [];
        acc = 0;
        paused = false;
        veil.classList.remove('on');
        note.textContent = '绘制中 · 0.0s / ' + SPAN + 's';
        render();
      }

      function onGo() {
        if (!paused) { return; }
        paused = false;
        acc = 0;
        tick = 0;
        veil.classList.remove('on');
        note.textContent = '绘制中 · 0.0s / ' + SPAN + 's';
        run();
      }

      function onNew() {
        fresh();
        run();
      }

      readPal();
      fresh();
      resize();
      btnGo.addEventListener('click', onGo);
      btnNew.addEventListener('click', onNew);
      window.addEventListener('resize', resize);
      run();

      return function () {
        alive = false;
        stopRaf();
        btnGo.removeEventListener('click', onGo);
        btnNew.removeEventListener('click', onNew);
        window.removeEventListener('resize', resize);
      };
    }
  });

  /* ------------------------------------------------------------ 入口逻辑 */
  var stage = document.getElementById('bd-stage');
  var meta = document.getElementById('bd-meta');
  var nextBtn = document.getElementById('bd-next');
  var cleanup = null;
  var current = '';

  function show(key) {
    var idx = -1;
    for (var i = 0; i < SCENES.length; i++) {
      if (SCENES[i].key === key) { idx = i; break; }
    }
    if (idx < 0) { idx = rnd(SCENES.length); }
    if (cleanup) {
      try { cleanup(); } catch (e) { /* 忽略清理异常 */ }
      cleanup = null;
    }
    stage.innerHTML = '';
    var sc = SCENES[idx];
    current = sc.key;
    cleanup = sc.mount(stage) || null;
    if (meta) {
      meta.textContent = '第 ' + (idx + 1) + ' / ' + SCENES.length + ' 个无聊页面';
    }
    document.title = sc.title + ' · 无聊一下';
    if (location.hash.slice(1) !== sc.key) {
      try { history.replaceState(null, '', '#' + sc.key); } catch (e) { /* 沙箱内忽略 */ }
    }
  }

  function next() {
    if (!SCENES.length) { return; }
    if (SCENES.length < 2) { show(SCENES[0].key); return; }
    var key = current;
    while (key === current) { key = SCENES[rnd(SCENES.length)].key; }
    show(key);
  }

  if (nextBtn) { nextBtn.addEventListener('click', next); }
  window.addEventListener('hashchange', function () {
    var k = location.hash.slice(1);
    if (k && k !== current) { show(k); }
  });
  show(location.hash.slice(1) || '');
})();
