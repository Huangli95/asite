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
    tip: '一张 96 个气泡的包装纸，捏破它们，没有别的事会发生。',
    mount: function (stage) {
      var f = frame(this);
      var grid = el('div', 'bd-bubble');
      var note = el('p', 'bd-note', '已捏 0 / 96');
      var reset = el('button', 'bd-link', '换一张新的');
      f.box.appendChild(grid);
      f.box.appendChild(note);
      f.box.appendChild(reset);

      var total = 96;

      function build() {
        grid.innerHTML = '';
        for (var i = 0; i < total; i++) {
          grid.appendChild(el('span', 'bd-bub'));
        }
        note.textContent = '已捏 0 / ' + total;
      }

      function onClick(ev) {
        var t = ev.target;
        if (!t || t.className.indexOf('bd-bub') < 0) { return; }
        if (t.classList.contains('is-pop')) { return; }
        t.classList.add('is-pop');
        var done = grid.querySelectorAll('.bd-bub.is-pop').length;
        if (done >= total) {
          note.textContent = '整张都捏完了，一共 ' + total + ' 个。爽了吗？';
        } else {
          note.textContent = '已捏 ' + done + ' / ' + total;
        }
      }

      grid.addEventListener('click', onClick);
      reset.addEventListener('click', build);
      build();

      stage.appendChild(f.wrap);
      return function () { grid.removeEventListener('click', onClick); };
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
