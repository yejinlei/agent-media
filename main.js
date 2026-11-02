// liveinonetools · 共享脚本：目录高亮 / 标签页 / 位流查看器 / 协议时序动画 / GOP 可视化
(function () {
  'use strict';

  /* ========== 目录高亮 ========== */
  function initToc() {
    const toc = document.querySelector('aside.toc nav');
    if (!toc) return;
    const links = [...toc.querySelectorAll('a[href^="#"]')];
    const secs = links.map(a => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
    const visible = () => secs.filter(s => s.offsetParent !== null);
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--p').trim() || '#7c3aed';
    const light = getComputedStyle(document.documentElement).getPropertyValue('--p-l').trim() || '#f5f3ff';
    function upd() {
      const y = window.scrollY + 130;
      const list = visible();
      let cur = list[0];
      for (const s of list) { if (s.offsetTop <= y) cur = s; }
      links.forEach(a => {
        const on = cur && a.getAttribute('href') === '#' + cur.id;
        a.classList.toggle('on', !!on);
        a.style.color = on ? primary : '';
        a.style.background = on ? light : '';
        a.style.borderLeftColor = on ? primary : '';
        a.style.fontWeight = on ? '600' : '';
      });
    }
    window.addEventListener('scroll', upd, { passive: true });
    upd();
  }

  /* ========== 标签页 ========== */
  function initTabs() {
    document.querySelectorAll('.tabs').forEach(tg => {
      const panels = [];
      let sib = tg.nextElementSibling;
      while (sib && sib.classList.contains('tab-pnl')) { panels.push(sib); sib = sib.nextElementSibling; }
      function activate(k) {
        tg.querySelectorAll('.tab').forEach(b => {
          const on = b.dataset.t === k;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panels.forEach(pn => pn.classList.toggle('on', pn.dataset.p === k));
        // 标签切换后重建尚未初始化的可视化
        panels.forEach(pn => {
          if (pn.classList.contains('on')) pn.querySelectorAll('[data-lazy-viz]').forEach(initViz);
        });
      }
      tg.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activate(btn.dataset.t)));
      // 支持 #mp4 这样的深链接直接切换到对应标签
      const hash = (location.hash || '').replace('#', '');
      const target = hash && tg.querySelector(`.tab[data-t="${hash}"]`);
      const initial = target || tg.querySelector('.tab.on') || tg.querySelector('.tab');
      if (initial) activate(initial.dataset.t);
      // 目录点击 / 浏览器前进后退时同步切换标签并滚到对应区块
      window.addEventListener('hashchange', () => {
        const h = (location.hash || '').replace('#', '');
        const btn = tg.querySelector(`.tab[data-t="${h}"]`);
        if (btn) {
          activate(h);
          setTimeout(() => { const s = document.getElementById(h); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
        }
      });
    });
  }

  /* ========== 位流 / 字节查看器 ========== */
  function parseHex(input) {
    if (Array.isArray(input)) return input.map(x => x & 255);
    const s = String(input || '');
    return (s.match(/[0-9a-fA-F]{2}/g) || []).map(h => parseInt(h, 16));
  }

  function HexViewer(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.bytes = parseHex(this.opt.bytes);
    this.fields = this.opt.fields || [];
    this.perRow = this.opt.perRow || 16;
    this.active = -1;
    this.render();
  }

  HexViewer.prototype.render = function () {
    const o = this.opt, b = this.bytes;
    const rows = [];
    for (let i = 0; i < b.length; i += this.perRow) rows.push(i);
    const hx = (v, fieldIdx, i) => `<span class="hx ${fieldIdx >= 0 ? 'f' + (fieldIdx % 8) : ''}" data-i="${i}" data-f="${fieldIdx}" title="${this.fieldTitle(fieldIdx)}">${v.toString(16).padStart(2, '0')}</span>`;
    let body = '';
    rows.forEach(start => {
      let cells = '', ascii = '';
      for (let i = start; i < Math.min(start + this.perRow, b.length); i++) {
        const f = this.fieldAt(i);
        cells += hx(b[i], f, i);
        ascii += (b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : '·');
      }
      body += `<div class="hex-row"><span class="off">${start.toString(16).padStart(4, '0')}</span><span class="bs">${cells}</span><span style="color:#94a3b8;margin-left:.5rem;letter-spacing:.05em">${ascii}</span></div>`;
    });
    const legend = this.fields.map((f, k) => `<button data-f="${k}"><span class="dot" style="background:${this.fieldColor(k)}"></span>${f.name}<span style="color:#94a3b8">${f.bits ? ' · ' + f.bits : ''}</span></button>`).join('');
    this.el.innerHTML = `<div class="hexv">
      <div class="hexv-bar">
        <span class="ti">${o.title || '字节视图'} · ${b.length} bytes</span>
        <span>
          <button class="btn-mini" data-act="prev">← 上一字段</button>
          <button class="btn-mini" data-act="next">下一字段 →</button>
        </span>
      </div>
      <div class="hexrows">${body}</div>
      <div class="hexv-legend">${legend}</div>
      <div class="hexv-info">${o.hint || '点击图例或“下一字段”，查看每个字段的含义。'}</div>
    </div>`;
    const root = this.el;
    root.querySelectorAll('.hexv-legend button').forEach(btn => {
      btn.addEventListener('click', () => this.setActive(+btn.dataset.f));
    });
    root.querySelectorAll('.hx').forEach(sp => {
      sp.addEventListener('mouseenter', () => this.info(+sp.dataset.f, false));
      sp.addEventListener('mouseleave', () => { if (this.active < 0) this.info(-1, false); });
    });
    root.querySelector('[data-act="prev"]').addEventListener('click', () => this.step(-1));
    root.querySelector('[data-act="next"]').addEventListener('click', () => this.step(1));
  };

  HexViewer.prototype.fieldAt = function (i) {
    for (let k = 0; k < this.fields.length; k++) {
      const f = this.fields[k];
      if (i >= f.start && i <= f.end) return k;
    }
    return -1;
  };
  HexViewer.prototype.fieldColor = function (k) {
    const colors = ['#fde68a', '#bfdbfe', '#bbf7d0', '#fbcfe8', '#ddd6fe', '#fed7aa', '#bae6fd', '#e2e8f0'];
    return colors[k % colors.length];
  };
  HexViewer.prototype.fieldTitle = function (k) {
    if (k < 0) return '';
    const f = this.fields[k];
    return f.name + (f.bits ? ' (' + f.bits + ')' : '');
  };
  HexViewer.prototype.setActive = function (k) {
    this.active = k;
    const root = this.el;
    root.querySelectorAll('.hx').forEach(sp => sp.classList.toggle('on', +sp.dataset.f === k));
    root.querySelectorAll('.hexv-legend button').forEach(btn => {
      btn.style.background = +btn.dataset.f === k ? '#f1f5f9' : '';
      btn.style.fontWeight = +btn.dataset.f === k ? '700' : '';
    });
    this.info(k, true);
  };
  HexViewer.prototype.step = function (d) {
    const n = this.fields.length;
    if (!n) return;
    let k = this.active + d;
    if (k < 0) k = n - 1;
    if (k >= n) k = 0;
    this.setActive(k);
  };
  HexViewer.prototype.info = function (k, pin) {
    const box = this.el.querySelector('.hexv-info');
    if (!box) return;
    if (k < 0 || !this.fields[k]) {
      box.innerHTML = this.opt.hint || '悬停字节或点击图例，查看字段含义。';
      return;
    }
    const f = this.fields[k];
    const raw = this.bytes.slice(f.start, f.end + 1).map(v => v.toString(16).padStart(2, '0')).join(' ');
    box.innerHTML = `<b>${f.name}</b>${f.bits ? ` <span class="muted">(${f.bits})</span>` : ''} · 偏移 <span class="mono">0x${f.start.toString(16)}–0x${f.end.toString(16)}</span> · 原始字节 <span class="mono">${raw || '—'}</span><br>${f.note || ''}`;
  };
  HexViewer.prototype.highlightOnly = function () { };
  HexViewer.fromElement = function (el) {
    let opt = {};
    try { opt = JSON.parse(el.dataset.opts || '{}'); } catch (e) { opt = {}; }
    return new HexViewer(el, opt);
  };

  /* ========== 协议时序动画 ========== */
  function SeqAnimator(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.steps = this.opt.steps || [];
    this.actors = this.opt.actors || ['Client', 'Server'];
    this.idx = -1;
    this.timer = null;
    this.render();
  }
  SeqAnimator.prototype.render = function () {
    const o = this.opt, st = this.steps, n = st.length;
    const H = 96 + n * 40;
    const left = 118, right = 610;
    const xs = this.actors.map((_, i) => this.actors.length === 1 ? 360 : left + i * ((right - left) / (this.actors.length - 1)));
    let svg = `<svg viewBox="0 0 720 ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${o.title || '协议交互时序'}">`;
    this.actors.forEach((a, i) => {
      svg += `<rect x="${xs[i] - 62}" y="10" width="124" height="32" rx="6" fill="#f5f3ff" stroke="#c4b5fd"/>
        <text x="${xs[i]}" y="31" text-anchor="middle" font-size="13" font-weight="700" fill="#5b21b6">${a}</text>
        <line x1="${xs[i]}" y1="42" x2="${xs[i]}" y2="${H - 14}" stroke="#cbd5e1" stroke-dasharray="4 4"/>`;
    });
    st.forEach((s, i) => {
      const y = 74 + i * 40, x1 = xs[s.from], x2 = xs[s.to];
      const dir = x2 >= x1 ? 1 : -1;
      const endX = x2 - dir * 4;
      const col = s.color || '#7c3aed';
      svg += `<g class="seq-step" data-i="${i}" opacity=".28">
        <line x1="${x1}" y1="${y}" x2="${endX}" y2="${y}" stroke="${col}" stroke-width="1.8"/>
        <polygon points="${endX},${y} ${endX - dir * 8},${y - 5} ${endX - dir * 8},${y + 5}" fill="${col}"/>
        <text x="${(x1 + x2) / 2}" y="${y - 7}" text-anchor="middle" font-size="11.5" fill="#334155">${s.label}</text>
        <circle cx="${x1}" cy="${y}" r="3" fill="${col}"/>
      </g>`;
    });
    svg += `<text x="700" y="${H - 4}" text-anchor="end" font-size="10" fill="#94a3b8">liveinonetools</text></svg>`;
    this.el.innerHTML = `<div class="seq">
      <div class="seq-bar">
        <span class="ti">${o.title || '交互时序'}</span>
        <button class="btn-mini" data-act="play">▶ 播放</button>
        <button class="btn-mini" data-act="step">⏭ 单步</button>
        <button class="btn-mini" data-act="reset">↺ 重置</button>
        <span class="muted" style="font-size:.76rem">${this.steps.length} 步</span>
      </div>
      <div class="seq-stage">${svg}</div>
      <div class="seq-note">${o.hint || '点击“播放”观看完整交互过程，或单步查看每条消息。'}</div>
    </div>`;
    const root = this.el;
    root.querySelector('[data-act="play"]').addEventListener('click', () => this.play());
    root.querySelector('[data-act="step"]').addEventListener('click', () => this.step());
    root.querySelector('[data-act="reset"]').addEventListener('click', () => this.reset());
    this.update();
  };
  SeqAnimator.prototype.update = function () {
    const root = this.el;
    root.querySelectorAll('.seq-step').forEach(g => {
      const on = +g.dataset.i === this.idx;
      g.setAttribute('opacity', on ? '1' : (+g.dataset.i < this.idx ? '.55' : '.22'));
      g.style.filter = on ? 'drop-shadow(0 0 3px rgba(124,58,237,.45))' : '';
    });
    const note = root.querySelector('.seq-note');
    if (this.idx >= 0 && this.steps[this.idx]) {
      note.innerHTML = `<b>第 ${this.idx + 1}/${this.steps.length} 步 · ${this.steps[this.idx].label}</b><br>${this.steps[this.idx].detail || ''}`;
    } else {
      note.textContent = this.opt.hint || '点击“播放”观看完整交互过程，或单步查看每条消息。';
    }
  };
  SeqAnimator.prototype.step = function () {
    if (this.idx < this.steps.length - 1) { this.idx++; this.update(); }
    else { this.stop(); }
  };
  SeqAnimator.prototype.play = function () {
    this.stop();
    if (this.idx >= this.steps.length - 1) this.idx = -1;
    this.update();
    this.timer = setInterval(() => this.step(), this.opt.speed || 900);
  };
  SeqAnimator.prototype.stop = function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } };
  SeqAnimator.prototype.reset = function () { this.stop(); this.idx = -1; this.update(); };
  SeqAnimator.fromElement = function (el) {
    let opt = {};
    try { opt = JSON.parse(el.dataset.opts || '{}'); } catch (e) { opt = {}; }
    return new SeqAnimator(el, opt);
  };

  /* ========== GOP / PTS-DTS 可视化 ========== */
  function GopViewer(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = Object.assign({ gop: 12, bframes: 2, fps: 25, frames: 24 }, opt || {});
    this.sel = -1;
    this.render();
  }
  GopViewer.prototype.pattern = function (gop, bf) {
    const t = [];
    if (gop <= 0) return ['I'];
    t.push('I');
    if (bf === 0) {
      for (let i = 1; i < gop; i++) t.push('P');
    } else {
      let sinceP = 0;
      for (let i = 1; i < gop; i++) {
        if (sinceP === bf) { t.push('P'); sinceP = 0; }
        else { t.push('B'); sinceP++; }
      }
    }
    return t;
  };
  GopViewer.prototype.render = function () {
    const gop = this.opt.gop, bf = this.opt.bframes, base = this.pattern(gop, bf);
    const fr = this.opt.frames;
    const disp = [];
    for (let i = 0; i < fr; i++) disp.push(base[i % base.length]);
    // 解码顺序：每个 P 帧提前到它前面的 B 帧之前
    const dec = [];
    let i = 0;
    while (i < disp.length) {
      if (disp[i] === 'I' || disp[i] === 'P') {
        dec.push({ t: disp[i], d: i });
        i++;
      } else {
        let j = i;
        const bs = [];
        while (j < disp.length && disp[j] === 'B') { bs.push({ t: 'B', d: j }); j++; }
        dec.push(...bs);
        i = j;
      }
    }
    const note = () => {
      if (this.sel < 0) return '点击任意帧：查看它依赖哪一帧、seek 需要解码多少帧。';
      let k = this.sel, back = 0;
      while (k >= 0 && disp[k] !== 'I') { k--; back++; }
      return `第 ${this.sel + 1} 帧（${disp[this.sel]} 帧）：依赖左侧最近的 I 帧（第 ${k + 1} 帧）。seek 到这里平均需要从 I 帧解码 <b>${back + 1}</b> 帧；GOP 越长，随机访问代价越大。`;
    };
    const strip = (arr, label, dts) => `<div style="font-size:.78rem;color:var(--muted);margin-top:.5rem">${label}</div>
      <div class="gop-strip">${arr.map((f, idx) => {
        const t = typeof f === 'string' ? f : f.t;
        const d = typeof f === 'string' ? idx : f.d;
        return `<div class="gfr ${t.toLowerCase()} ${this.sel === d ? 'on' : ''}" data-d="${d}" title="显示序 #${d + 1} · ${t} 帧"><span>${t}</span><small>${dts ? 'DTS' : 'PTS'}${(dts ? idx : d) + 1}</small></div>`;
      }).join('')}</div>`;
    this.el.innerHTML = `<div class="gop">
      <div class="gop-legend"><span><i style="background:#ddd6fe"></i>I 帧（关键帧）</span><span><i style="background:#bfdbfe"></i>P 帧（前向）</span><span><i style="background:#a7f3d0"></i>B 帧（双向）</span></div>
      <div class="ctrl" style="display:grid;grid-template-columns:repeat(3,1fr);gap:.8rem;margin:.7rem 0">
        <div><label>GOP 长度：<b>${gop}</b> 帧</label><input type="range" min="4" max="30" step="1" value="${gop}" data-k="gop"></div>
        <div><label>连续 B 帧：<b>${bf}</b></label><input type="range" min="0" max="3" step="1" value="${bf}" data-k="bframes"></div>
        <div><label>帧率：<b>${this.opt.fps}</b> fps</label><input type="range" min="15" max="60" step="1" value="${this.opt.fps}" data-k="fps"></div>
      </div>
      ${strip(disp, '显示顺序 / 播放顺序（PTS，B 帧会重排）', false)}
      ${strip(dec, '解码顺序 / 码流顺序（DTS，参考帧必须先解）', true)}
      <div class="seq-note" style="margin-top:.6rem">${note()}</div>
      <div class="callout callout-i" style="margin:.8rem 0 0"><span class="ic">💡</span><span>GOP=${gop}、${bf} 连续 B 帧时，一个 GOP 约 ${(gop / this.opt.fps).toFixed(2)} 秒；关键帧间隔 ${gop} 帧。直播通常 1–2 秒一个 I 帧，点播可以用更长 GOP 换码率。</span></div>
    </div>`;
    const root = this.el;
    root.querySelectorAll('input[type=range]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.k;
        this.opt[k] = +inp.value;
        this.render();
      });
    });
    root.querySelectorAll('.gfr').forEach(f => {
      f.addEventListener('click', () => { this.sel = +f.dataset.d; this.render(); });
    });
  };
  GopViewer.fromElement = function (el) {
    let opt = {};
    try { opt = JSON.parse(el.dataset.opts || '{}'); } catch (e) { opt = {}; }
    return new GopViewer(el, opt);
  };

  /* ========== 量化 / DCT 互动演示 ========== */
  const DCT_C = [1 / Math.SQRT2, 1, 1, 1, 1, 1, 1, 1];
  const DCT_COS = [];
  for (let x = 0; x < 8; x++) {
    DCT_COS[x] = [];
    for (let u = 0; u < 8; u++) DCT_COS[x][u] = Math.cos((2 * x + 1) * u * Math.PI / 16);
  }
  const Q_LUMA = [
    [16, 11, 10, 16, 24, 40, 51, 61],
    [12, 12, 14, 19, 26, 58, 60, 55],
    [14, 13, 16, 24, 40, 57, 69, 56],
    [14, 17, 22, 29, 51, 87, 80, 62],
    [18, 22, 37, 56, 68, 109, 103, 77],
    [24, 35, 55, 64, 81, 104, 113, 92],
    [49, 64, 78, 87, 103, 121, 120, 101],
    [72, 92, 95, 98, 112, 100, 103, 99]
  ];
  function dct8(b) {
    const o = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) s += b[x][y] * DCT_COS[x][u] * DCT_COS[y][v];
      o[u][v] = 0.25 * DCT_C[u] * DCT_C[v] * s;
    }
    return o;
  }
  function idct8(c) {
    const o = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) s += DCT_C[u] * DCT_C[v] * c[u][v] * DCT_COS[x][u] * DCT_COS[y][v];
      o[x][y] = 0.25 * s;
    }
    return o;
  }

  function QuantDemo(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.qp = this.opt.qp == null ? 26 : this.opt.qp;
    this.preset = this.opt.preset || 'edge';
    this.render();
  }
  QuantDemo.prototype.source = function () {
    const b = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      if (this.preset === 'flat') b[x][y] = 128 + 4 * Math.sin((x + y) / 2);
      else if (this.preset === 'detail') b[x][y] = 128 + 55 * Math.sin(x * 0.9) + 42 * Math.cos(y * 1.2) + ((x + y) % 3) * 8;
      else b[x][y] = x < 4 ? 36 + x * 4 : 196 - y * 5;
      b[x][y] = Math.max(0, Math.min(255, b[x][y]));
    }
    return b;
  };
  QuantDemo.prototype.render = function () {
    this.el.innerHTML = `<div class="quant">
      <div class="quant-bar">
        <div class="q-ctl"><label>量化参数 QP：<b>${this.qp}</b></label><input type="range" min="0" max="51" step="1" value="${this.qp}" data-k="qp"></div>
        <div class="q-ctl"><label>宏块内容</label>
          <select data-k="preset">
            <option value="edge"${this.preset === 'edge' ? ' selected' : ''}>强边缘（文字/物体边界）</option>
            <option value="detail"${this.preset === 'detail' ? ' selected' : ''}>高频纹理（草地/毛发）</option>
            <option value="flat"${this.preset === 'flat' ? ' selected' : ''}>平坦区域（天空/墙面）</option>
          </select>
        </div>
        <div class="q-ctl"><button class="btn-mini" data-act="reset">↺ 重置 QP=26</button></div>
      </div>
      <div class="quant-grid">
        <div><div class="q-lab">原始 8×8 像素</div><canvas class="q-cv" data-k="src" width="8" height="8"></canvas></div>
        <div><div class="q-lab">反量化 + IDCT 重建</div><canvas class="q-cv" data-k="dst" width="8" height="8"></canvas></div>
        <div><div class="q-lab">量化后的 DCT 系数</div><div class="qgrid" data-k="coef"></div></div>
      </div>
      <div class="seq-note" data-k="note"></div>
    </div>`;
    const root = this.el;
    root.querySelector('[data-k="qp"]').addEventListener('input', e => { this.qp = +e.target.value; this.update(); });
    root.querySelector('[data-k="preset"]').addEventListener('change', e => { this.preset = e.target.value; this.update(); });
    root.querySelector('[data-act="reset"]').addEventListener('click', () => { this.qp = 26; root.querySelector('[data-k="qp"]').value = 26; this.update(); });
    this.update();
  };
  QuantDemo.prototype.update = function () {
    const root = this.el;
    if (!root) return;
    const src = this.source();
    const coef = dct8(src);
    const qs = Math.pow(2, (this.qp - 4) / 6);
    const qc = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const rec = Array.from({ length: 8 }, () => new Array(8).fill(0));
    let nz = 0, maxv = 1;
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
      const step = Q_LUMA[u][v] * qs;
      qc[u][v] = Math.round(coef[u][v] / step);
      rec[u][v] = qc[u][v] * step;
      if (qc[u][v] !== 0) nz++;
      maxv = Math.max(maxv, Math.abs(qc[u][v]));
    }
    const back = idct8(rec);
    let mse = 0;
    const draw = (key, mat) => {
      const cv = root.querySelector(`[data-k="${key}"]`);
      const g = cv.getContext('2d');
      const img = g.createImageData(8, 8);
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
        const v = Math.max(0, Math.min(255, Math.round(mat[x][y])));
        const i = (x * 8 + y) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    };
    draw('src', src); draw('dst', back);
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) mse += (src[x][y] - back[x][y]) ** 2;
    mse /= 64;
    const psnr = mse < 0.01 ? '∞' : (10 * Math.log10(255 * 255 / mse)).toFixed(2);
    let cells = '';
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
      const v0 = qc[u][v];
      const a = Math.abs(v0) / maxv;
      const bg = v0 === 0 ? '#f1f5f9' : v0 > 0 ? `rgba(124,58,237,${0.12 + a * 0.68})` : `rgba(8,145,178,${0.12 + a * 0.68})`;
      cells += `<span class="qcell" style="background:${bg}" title="F(${u},${v}) = ${qc[u][v]}">${v0}</span>`;
    }
    root.querySelector('[data-k="coef"]').innerHTML = cells;
    const bits = nz * 5 + 6;
    root.querySelector('[data-k="note"]').innerHTML =
      `<b>QP ${this.qp}</b> · 量化步长 ≈ ${qs.toFixed(2)} · 非零系数 <b>${nz}/64</b> · 估计 ${bits} bit / 64 样本（${(bits / 64).toFixed(2)} bpp） · 重建 PSNR <b>${psnr} dB</b><br>` +
      `QP 越大 → 量化步长越大 → 非零系数越少 → 码率越低、块效应越明显。这就是“码率–质量”旋钮；编码器再通过率失真优化（RDO）在 QP 与 λ 之间做选择。`;
  };
  QuantDemo.fromElement = function (el) {
    let o = {}; try { o = JSON.parse(el.dataset.opts || '{}'); } catch (e) { }
    return new QuantDemo(el, o);
  };

  /* ========== 色度采样 4:4:4 / 4:2:2 / 4:2:0 ========== */
  function ChromaDemo(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.modes = [
      { id: '444', name: '4:4:4', fx: 1, fy: 1 },
      { id: '422', name: '4:2:2', fx: 2, fy: 1 },
      { id: '420', name: '4:2:0', fx: 2, fy: 2 },
      { id: '411', name: '4:1:1', fx: 4, fy: 1 }
    ];
    this.mode = this.modes[2];
    this.grid = false;
    this.render();
    this.update();
  }
  ChromaDemo.prototype.pattern = function (w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const bars = ['#e11d48', '#f59e0b', '#10b981', '#0891b2', '#7c3aed', '#f472b6', '#facc15'];
    bars.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * w / bars.length, 0, w / bars.length + 1, h * 0.62); });
    const lg = g.createLinearGradient(0, h * 0.62, w, h);
    lg.addColorStop(0, '#0f172a'); lg.addColorStop(.5, '#64748b'); lg.addColorStop(1, '#f8fafc');
    g.fillStyle = lg; g.fillRect(0, h * 0.62, w, h * 0.38);
    g.beginPath(); g.arc(w * 0.3, h * 0.3, h * 0.2, 0, 7); g.fillStyle = '#fef3c7'; g.fill();
    g.beginPath(); g.arc(w * 0.7, h * 0.32, h * 0.16, 0, 7); g.fillStyle = '#22d3ee'; g.fill();
    return g.getImageData(0, 0, w, h);
  };
  ChromaDemo.prototype.render = function () {
    this.el.innerHTML = `<div class="chroma">
      <div class="chroma-bar">
        <span class="ti">色度子采样：人眼对亮度敏感、对色度迟钝</span>
        ${this.modes.map(m => `<button class="btn-mini" data-m="${m.id}"${m === this.mode ? ' style="background:var(--p);color:#fff;border-color:var(--p)"' : ''}>${m.name}</button>`).join('')}
        <button class="btn-mini" data-act="grid">${this.grid ? '隐藏' : '显示'}采样格</button>
      </div>
      <div class="chroma-pair">
        <div><div class="q-lab">原始 RGB（每个像素都有色度）</div><canvas data-k="a" width="320" height="180"></canvas></div>
        <div><div class="q-lab" data-k="bl">重建（色度按块平均）</div><canvas data-k="b" width="320" height="180"></canvas></div>
      </div>
      <div class="seq-note" data-k="note"></div>
    </div>`;
    const root = this.el;
    root.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
      this.mode = this.modes.find(m => m.id === b.dataset.m);
      this.render(); this.update();
    }));
    root.querySelector('[data-act="grid"]').addEventListener('click', () => { this.grid = !this.grid; this.render(); this.update(); });
  };
  ChromaDemo.prototype.update = function () {
    const root = this.el; if (!root) return;
    const w = 320, h = 180;
    const src = this.pattern(w, h);
    const ca = root.querySelector('[data-k="a"]'), cb = root.querySelector('[data-k="b"]');
    ca.getContext('2d').putImageData(src, 0, 0);
    const fx = this.mode.fx, fy = this.mode.fy;
    const cw = Math.ceil(w / fx), chh = Math.ceil(h / fy);
    const yA = new Float32Array(w * h), cbA = new Float32Array(cw * chh), crA = new Float32Array(cw * chh);
    const cnt = new Float32Array(cw * chh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      const Cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      const Cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
      yA[y * w + x] = Y;
      const k = Math.floor(y / fy) * cw + Math.floor(x / fx);
      cbA[k] += Cb; crA[k] += Cr; cnt[k]++;
    }
    for (let k = 0; k < cw * chh; k++) { cbA[k] /= cnt[k] || 1; crA[k] /= cnt[k] || 1; }
    const out = cb.getContext('2d').createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = Math.floor(y / fy) * cw + Math.floor(x / fx);
      const Y = yA[y * w + x], Cb = cbA[k] - 128, Cr = crA[k] - 128;
      let r = Y + 1.402 * Cr, g = Y - 0.344136 * Cb - 0.714136 * Cr, b = Y + 1.772 * Cb;
      const i = (y * w + x) * 4;
      out.data[i] = Math.max(0, Math.min(255, r)); out.data[i + 1] = Math.max(0, Math.min(255, g)); out.data[i + 2] = Math.max(0, Math.min(255, b)); out.data[i + 3] = 255;
    }
    cb.getContext('2d').putImageData(out, 0, 0);
    const g2 = cb.getContext('2d');
    if (this.grid) {
      g2.strokeStyle = 'rgba(15,23,42,.28)'; g2.lineWidth = 1;
      for (let x = 0; x <= w; x += fx) { g2.beginPath(); g2.moveTo(x, 0); g2.lineTo(x, h); g2.stroke(); }
      for (let y = 0; y <= h; y += fy) { g2.beginPath(); g2.moveTo(0, y); g2.lineTo(w, y); g2.stroke(); }
    }
    const bpp = 8 + 8 / fx + 8 / fy;
    const mbps = bpp * 1920 * 1080 * 30 / 1e6;
    root.querySelector('[data-k="bl"]').textContent = `重建（${this.mode.name} 色度按 ${fx}×${fy} 块平均）`;
    root.querySelector('[data-k="note"]').innerHTML =
      `<b>${this.mode.name}</b>：亮度保持全分辨率，色度每 ${fx}×${fy} 个像素共享 1 组 Cb/Cr。8 bit 下约 <b>${bpp} bpp</b>；1080p30 原始约 <b>${mbps.toFixed(0)} Mbps</b>（未压缩）。` +
      `4:2:0 是 H.264/HEVC/AV1 消费级编码的默认格式（宽高需为偶数）；4:2:2/4:4:4 多用于演播室、绿幕抠像与专业编码。`;
  };
  ChromaDemo.fromElement = function (el) {
    let o = {}; try { o = JSON.parse(el.dataset.opts || '{}'); } catch (e) { }
    return new ChromaDemo(el, o);
  };

  /* ========== 封装开销动画：MP4 / TS / MKV / FLV ========== */
  function MuxDemo(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.target = this.opt.target || 'ts';
    this.frameSize = this.opt.frameSize || 2400;
    this.frames = 12;
    this.idx = -1;
    this.timer = null;
    this.render();
  }
  MuxDemo.prototype.calc = function () {
    const fs = this.frameSize;
    const n = this.frames;
    if (this.target === 'ts') {
      const per = Math.ceil(fs / 184);
      return { unit: 'TS packet', header: 4, per, body: per * 184, total: per * 188, overhead: per * 188 - fs, note: '每个 188 字节 TS 包只有 184 字节有效载荷（另 4 字节为包头，含 PID/连续计数）' };
    }
    if (this.target === 'mp4') {
      return { unit: 'sample', header: 4, per: 1, body: fs, total: fs + 8 + Math.round(120 / n), overhead: 8 + Math.round(120 / n), note: 'fMP4 每个 sample 在 stsz 中占 4 字节；每个 fragment 另有 moof 索引开销' };
    }
    if (this.target === 'mkv') {
      return { unit: 'block', header: 14, per: 1, body: fs, total: fs + 14 + Math.round(120 / n), overhead: 14 + Math.round(120 / n), note: 'Matroska Block 头约 10–20 字节；Cluster 级时间码/长度额外摊销' };
    }
    return { unit: 'FLV tag', header: 11, per: 1, body: fs, total: fs + 15, overhead: 15, note: 'FLV 每个 tag 有 11 字节头 + 4 字节 PreviousTagSize；音频/视频各成 tag' };
  };
  MuxDemo.prototype.render = function () {
    const t = this.target;
    this.el.innerHTML = `<div class="mux">
      <div class="mux-bar">
        <span class="ti">一帧 → 容器封装单元（切换目标观察开销）</span>
        ${[['mp4', 'MP4'], ['ts', 'MPEG-TS'], ['mkv', 'MKV'], ['flv', 'FLV']].map(([k, n]) => `<button class="btn-mini" data-t="${k}"${k === t ? ' style="background:var(--p);color:#fff;border-color:var(--p)"' : ''}>${n}</button>`).join('')}
      </div>
      <div class="mux-ctl">
        <label>单帧编码后大小：<b data-k="fs"></b> 字节</label>
        <input type="range" min="500" max="6000" step="50" value="${this.frameSize}" data-k="size">
        <button class="btn-mini" data-act="play">▶ 逐帧封装</button>
        <button class="btn-mini" data-act="reset">↺ 重置</button>
      </div>
      <div class="mux-strip" data-k="strip"></div>
      <div class="mux-packets" data-k="packets"></div>
      <div class="seq-note" data-k="note"></div>
    </div>`;
    const root = this.el;
    root.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => { this.target = b.dataset.t; this.render(); }));
    root.querySelector('[data-k="size"]').addEventListener('input', e => { this.frameSize = +e.target.value; this.render(); });
    root.querySelector('[data-act="play"]').addEventListener('click', () => this.play());
    root.querySelector('[data-act="reset"]').addEventListener('click', () => { this.stop(); this.idx = -1; this.update(); });
    this.update();
  };
  MuxDemo.prototype.update = function () {
    const root = this.el; if (!root) return;
    const c = this.calc();
    root.querySelector('[data-k="fs"]').textContent = this.frameSize;
    let cells = '';
    for (let i = 0; i < this.frames; i++) {
      const on = i <= this.idx;
      cells += `<div class="mux-frame${on ? ' on' : ''}${i === this.idx ? ' cur' : ''}"><span>${i % 4 === 0 ? 'I' : i % 2 ? 'B' : 'P'}</span><small>#${i + 1}</small></div>`;
    }
    root.querySelector('[data-k="strip"]').innerHTML = cells;
    const shown = Math.max(0, this.idx + 1);
    const packets = Math.min(c.per * this.frames, 220);
    let p = '';
    for (let i = 0; i < packets; i++) {
      const frameIdx = Math.floor(i / c.per);
      const on = frameIdx <= this.idx;
      p += `<span class="mux-pkt${on ? ' on' : ''}" title="frame #${frameIdx + 1} · ${c.unit}"></span>`;
    }
    root.querySelector('[data-k="packets"]').innerHTML = `<div class="mux-pk-lab">${c.unit} × ${c.per} / 帧（已显示 ${shown ? Math.min(shown, this.frames) * c.per : 0} 个）</div><div class="mux-pk">${p}</div>`;
    const ratio = c.overhead / this.frameSize * 100;
    const hour = c.overhead * 30 * 3600 / 1e6;
    root.querySelector('[data-k="note"]').innerHTML =
      `<b>${c.unit}</b>：每帧 ${this.frameSize} B → ${c.per} 个单元，封装后 ${c.total} B，额外 <b>${c.overhead} B</b>（<b>${ratio.toFixed(1)}%</b>）。按 30 fps 计，1 小时多占 <b>${hour.toFixed(1)} MB</b>。<br>${c.note}`;
  };
  MuxDemo.prototype.play = function () {
    this.stop(); if (this.idx >= this.frames - 1) this.idx = -1;
    this.timer = setInterval(() => {
      this.idx++; this.update();
      if (this.idx >= this.frames - 1) this.stop();
    }, 420);
  };
  MuxDemo.prototype.stop = function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } };
  MuxDemo.fromElement = function (el) {
    let o = {}; try { o = JSON.parse(el.dataset.opts || '{}'); } catch (e) { }
    return new MuxDemo(el, o);
  };

  /* ========== ABR 码率阶梯 / 带宽自适应 ========== */
  const ABR_LADDERS = {
    live: [
      { n: '240p', k: 300 }, { n: '360p', k: 600 }, { n: '480p', k: 1000 },
      { n: '720p', k: 2000 }, { n: '1080p', k: 4500 }
    ],
    conf: [
      { n: '180p', k: 150 }, { n: '360p', k: 500 }, { n: '540p', k: 900 }, { n: '720p', k: 1500 }
    ],
    vod: [
      { n: '240p', k: 250 }, { n: '360p', k: 500 }, { n: '480p', k: 900 },
      { n: '720p', k: 1800 }, { n: '1080p', k: 4000 }, { n: '1440p', k: 8000 }
    ]
  };
  function AbrSim(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.ladder = ABR_LADDERS[this.opt.ladder] || ABR_LADDERS.live;
    this.bw = this.opt.bw || 6;
    this.base = this.bw;
    this.t = 0;
    this.timer = null;
    this.prev = null;
    this.render();
  }
  AbrSim.prototype.render = function () {
    this.el.innerHTML = `<div class="abr">
      <div class="abr-bar"><span class="ti">${this.opt.title || 'ABR 自适应码率'}</span>
        <button class="btn-mini" data-act="play">▶ 模拟带宽波动</button>
        <button class="btn-mini" data-act="reset">↺ 重置</button>
      </div>
      <div class="abr-ctl"><label>可用带宽：<b data-k="bw"></b> Mbps</label><input type="range" min="0.3" max="18" step="0.1" value="${this.bw}" data-k="slider"></div>
      <div class="abr-bars" data-k="bars"></div>
      <div class="abr-log" data-k="log"></div>
      <div class="seq-note" data-k="note"></div>
    </div>`;
    const root = this.el;
    root.querySelector('[data-k="slider"]').addEventListener('input', e => {
      this.bw = +e.target.value; this.base = this.bw; this.stop(); this.t = 0; this.prev = null; this.update();
    });
    root.querySelector('[data-act="play"]').addEventListener('click', () => this.play());
    root.querySelector('[data-act="reset"]').addEventListener('click', () => {
      this.stop(); this.t = 0; this.bw = this.base; this.prev = null;
      root.querySelector('[data-k="slider"]').value = this.bw;
      root.querySelector('[data-k="log"]').innerHTML = '';
      this.update();
    });
    this.update();
  };
  AbrSim.prototype.pick = function () {
    const usable = this.bw * 0.9;
    let sel = this.ladder[0];
    for (const r of this.ladder) if (r.k <= usable) sel = r;
    return { sel, usable, stall: this.ladder[0].k > usable };
  };
  AbrSim.prototype.update = function () {
    const root = this.el; if (!root) return;
    const { sel, usable, stall } = this.pick();
    root.querySelector('[data-k="bw"]').textContent = this.bw.toFixed(1);
    const max = this.ladder[this.ladder.length - 1].k;
    root.querySelector('[data-k="bars"]').innerHTML = this.ladder.map(r => {
      const on = r === sel;
      const h = 24 + (r.k / max) * 96;
      return `<div class="abr-col${on ? ' on' : ''}" style="height:${h}px"><span>${r.n}</span><small>${r.k}k</small></div>`;
    }).join('');
    root.querySelector('[data-k="note"]').innerHTML = stall
      ? `<b>带宽不足</b>：可用 ${usable.toFixed(1)} Mbps 低于最低档 ${this.ladder[0].k}k → 必然卡顿。应降低码率、缩短 GOP 或启用更激进的压缩。`
      : `<b>选中 ${sel.n}（${sel.k} kbps）</b>：可用带宽 ${usable.toFixed(1)} Mbps，余量 ${(usable - sel.k).toFixed(0)} kbps。切换发生在播放器缓冲区健康、且新码率持续可用时；切换点通常对齐 IDR 帧。`;
    if (this.prev && this.prev !== sel.n) {
      root.querySelector('[data-k="log"]').innerHTML += `<span>t=${(this.t * .3).toFixed(1)}s：${this.prev} → ${sel.n}</span>`;
    }
    this.prev = sel.n;
  };
  AbrSim.prototype.play = function () {
    this.stop(); this.t = 0; this.prev = null;
    this.el.querySelector('[data-k="log"]').innerHTML = '';
    this.timer = setInterval(() => {
      this.t++;
      this.bw = Math.max(0.3, Math.min(18, this.base * (1 + 0.55 * Math.sin(this.t / 6) + 0.18 * Math.sin(this.t / 2.3))));
      this.el.querySelector('[data-k="slider"]').value = this.bw;
      this.update();
      if (this.t > 90) this.stop();
    }, 300);
  };
  AbrSim.prototype.stop = function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } };
  AbrSim.fromElement = function (el) {
    let o = {}; try { o = JSON.parse(el.dataset.opts || '{}'); } catch (e) { }
    return new AbrSim(el, o);
  };

  /* ========== 零拷贝 / 硬件流水线动画 ========== */
  function ZeroCopy(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.mode = 'copy';
    this.width = 1920;
    this.height = 1080;
    this.fps = 30;
    this.play = true;
    this.progress = 0;
    this.raf = null;
    this.render();
    this.loop();
  }
  ZeroCopy.prototype.render = function () {
    const nodesAll = [
      { n: '采集/解码', x: 8 }, { n: '系统内存', x: 25 }, { n: 'GPU 显存', x: 42 },
      { n: '编码器', x: 59 }, { n: '系统内存', x: 76 }, { n: '封装/网络', x: 92 }
    ];
    const path = this.mode === 'copy' ? nodesAll : nodesAll.filter(n => n.n !== '系统内存');
    this.nodes = path;
    const svgW = 760, svgH = 130;
    let svg = `<svg viewBox="0 0 ${svgW} ${svgH}" class="zc-svg">`;
    path.forEach((n, i) => {
      const x = 30 + i * ((svgW - 60) / (path.length - 1));
      n.px = x;
      svg += `<rect x="${x - 46}" y="34" width="92" height="34" rx="6" fill="${n.n === 'GPU 显存' ? '#ede9fe' : '#f8fafc'}" stroke="${n.n === 'GPU 显存' ? '#c4b5fd' : '#cbd5e1'}"/>
        <text x="${x}" y="56" text-anchor="middle" font-size="11" fill="#334155">${n.n}</text>`;
      if (i < path.length - 1) {
        const x2 = 30 + (i + 1) * ((svgW - 60) / (path.length - 1));
        svg += `<line x1="${x + 46}" y1="51" x2="${x2 - 46}" y2="51" stroke="${this.mode === 'copy' && (n.n === '系统内存' || path[i + 1].n === '系统内存') ? '#e11d48' : '#10b981'}" stroke-width="2"/>`;
      }
    });
    svg += `<text x="30" y="105" font-size="10" fill="#94a3b8">${this.mode === 'copy' ? '每帧 2 次 CPU↔GPU 拷贝（红色）' : '零拷贝：帧始终留在 GPU 显存（绿色）'}</text></svg>`;
    this.el.innerHTML = `<div class="zc">
      <div class="zc-bar"><span class="ti">CPU ↔ GPU 数据通路</span>
        <button class="btn-mini" data-m="copy"${this.mode === 'copy' ? ' style="background:var(--r);color:#fff;border-color:var(--r)"' : ''}>传统拷贝</button>
        <button class="btn-mini" data-m="zero"${this.mode === 'zero' ? ' style="background:var(--g);color:#fff;border-color:var(--g)"' : ''}>零拷贝 / hw_frames_ctx</button>
        <button class="btn-mini" data-act="toggle">⏯ 暂停/继续</button>
      </div>
      <div class="zc-stage">${svg}<div class="zc-dots" data-k="dots"></div></div>
      <div class="zc-ctl">
        <label>分辨率<select data-k="res"><option value="1280x720">720p</option><option value="1920x1080" selected>1080p</option><option value="3840x2160">4K</option></select></label>
        <label>帧率：<b data-k="fps">30</b> fps<input type="range" min="15" max="60" step="1" value="30" data-k="fpsr"></label>
      </div>
      <div class="seq-note" data-k="note"></div>
    </div>`;
    const root = this.el;
    root.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { this.mode = b.dataset.m; this.render(); }));
    root.querySelector('[data-act="toggle"]').addEventListener('click', () => { this.play = !this.play; if (this.play) this.loop(); });
    root.querySelector('[data-k="res"]').addEventListener('change', e => {
      const [w, h] = e.target.value.split('x').map(Number); this.width = w; this.height = h; this.updateStats();
    });
    root.querySelector('[data-k="fpsr"]').addEventListener('input', e => { this.fps = +e.target.value; root.querySelector('[data-k="fps"]').textContent = this.fps; this.updateStats(); });
    root.querySelector('[data-k="res"]').value = this.width + 'x' + this.height;
    this.makeDots();
    this.updateStats();
  };
  ZeroCopy.prototype.makeDots = function () {
    const box = this.el.querySelector('[data-k="dots"]');
    box.innerHTML = '';
    this.dots = [];
    const n = this.mode === 'copy' ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'zc-dot' + (this.mode === 'copy' ? ' copy' : '');
      box.appendChild(d);
      this.dots.push({ el: d, t: i / n });
    }
  };
  ZeroCopy.prototype.loop = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    const step = () => {
      if (this.play) {
        this.progress += 0.004;
        if (this.progress > 1) this.progress -= 1;
        const stage = this.el.querySelector('.zc-stage');
        if (stage && this.dots) {
          const w = stage.clientWidth;
          this.dots.forEach((d, i) => {
            const t = (this.progress + i / this.dots.length) % 1;
            const pos = t * (this.nodes.length - 1);
            const k = Math.min(this.nodes.length - 2, Math.floor(pos));
            const f = pos - k;
            const x1 = 30 + k * ((760 - 60) / (this.nodes.length - 1));
            const x2 = 30 + (k + 1) * ((760 - 60) / (this.nodes.length - 1));
            const x = (x1 + (x2 - x1) * f) / 760 * w;
            d.el.style.transform = `translate(${x}px, ${51 / 130 * stage.clientHeight}px)`;
          });
        }
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };
  ZeroCopy.prototype.updateStats = function () {
    const root = this.el; if (!root) return;
    const bytes = this.width * this.height * 1.5;
    const copies = this.mode === 'copy' ? 2 : 0;
    const traffic = bytes * copies * this.fps / 1e6;
    const pcie = traffic / 15750 * 100;
    root.querySelector('[data-k="note"]').innerHTML =
      `YUV420 8bit 单帧 <b>${(bytes / 1e6).toFixed(2)} MB</b>；${this.fps} fps 下${copies ? ` 2 次往返拷贝产生 <b>${traffic.toFixed(0)} MB/s</b>（约 PCIe 3.0 x16 带宽的 ${pcie.toFixed(0)}%）` : ' <b>0 MB/s</b> 主机内存↔显存拷贝，帧以 AVHWFrame 引用直接在显存中传递'}。<br>` +
      `零拷贝的关键：解码器输出 <code>hw_frames_ctx</code> → 滤镜 <code>scale_cuda/scale_vaapi</code> 留在显存 → 编码器直接消费 <code>AV_PIX_FMT_CUDA/VAAPI</code>；只在必要时 <code>hwdownload</code> 回 CPU。`;
  };
  ZeroCopy.fromElement = function (el) {
    let o = {}; try { o = JSON.parse(el.dataset.opts || '{}'); } catch (e) { }
    return new ZeroCopy(el, o);
  };

  /* ========== GStreamer 流水线搭建器 ========== */
  const GST_HW = {
    sw:    { el: 'x264enc',    label: '软件 x264',    tip: '通用、可移植；CPU 占用高，1080p 多路时容易成为瓶颈。' },
    vaapi: { el: 'vah264enc',  label: 'VAAPI（Intel/AMD）', tip: 'Linux 通用硬件后端；需要 VA-API 驱动，帧可留在显存（DMABuf）。' },
    nvenc: { el: 'nvh264enc',  label: 'NVENC（NVIDIA）', tip: 'NVIDIA 独立编码单元；多路能力强，注意驱动与显存。' },
    qsv:   { el: 'qsvh264enc', label: 'QSV（Intel）',   tip: 'Intel iGPU 的 Quick Sync；低功耗，笔记本友好。' }
  };

  const GST_PRESETS = [
    {
      id: 'test', name: '① 测试图 → 窗口', tag: '30 秒上手',
      desc: '不接摄像头、不读文件，先确认 GStreamer 装好了、显示后端能用。这是所有排障的第一步：把问题缩小到最小可运行流水线。',
      elements: [
        { n: 'videotestsrc', p: 'pattern=smpte', caps: 'video/x-raw, format=RGB, 1920×1080, 30/1', note: '<b>源元件（src element）</b>：自己产生数据，没有输入 pad。它按 30 fps 生成 SMPTE 彩条，时间戳由内部时钟推进。真实场景里换成 v4l2src / rtspsrc / filesrc。' },
        { n: 'videoconvert', caps: 'video/x-raw, format=BGRx 或平台首选格式', note: '<b>转换元件</b>：视频格式的“翻译官”。上游给 RGB，下游可能只吃 BGRx / NV12；videoconvert 负责改像素排列。它只转换，不缩放——缩放要用 videoscale。' },
        { n: 'autovideosink', caps: '任意可显示格式', note: '<b>接收元件（sink element）</b>：数据在这里离开流水线。autovideosink 会按平台自动选择 xvimagesink / d3d11videosink / glimagesink / waylandsink。sync=true（默认）表示按流水线时钟准时显示。' }
      ]
    },
    {
      id: 'camera', name: '② 摄像头录制 MP4', tag: '采集 + 编码 + 封装',
      desc: '一条典型的“采集 → 转换 → 编码 → 封装 → 落盘”链路。切换编码后端，可以直观看到同一条流水线如何从 CPU 编码换成 GPU 编码。',
      elements: [
        { n: 'v4l2src', p: 'device=/dev/video0', caps: 'video/x-raw, format=YUY2, 1280×720, 30/1', note: '<b>Linux 摄像头源</b>：通过 V4L2 读取设备。它属于 live source（实时源），时钟由设备驱动推动，生产速度不受流水线控制。Windows 对应 ksvideosrc，macOS 对应 avfvideosrc。' },
        { n: 'videoconvert', caps: 'video/x-raw, format=I420', note: '把摄像头输出（常见 YUY2 / NV12）转成编码器接受的 I420。转换发生在 CPU 内存里；如果整条链都支持 DMABuf，可以省掉这次拷贝。' },
        { n: 'x264enc', p: 'speed-preset=veryfast tune=zerolatency bitrate=4000 key-int-max=30', swappable: true, hwProps: 'bitrate=4000 key-int-max=30', caps: 'video/x-h264, profile=high, stream-format=avc, alignment=au', note: '<b>编码器</b>：把原始帧压成 H.264 码流。key-int-max=30 表示最多 30 帧一个关键帧（30 fps 下即 1 秒），直接影响延迟与随机访问。切换上方“编码后端”可换成 VAAPI / NVENC / QSV。' },
        { n: 'h264parse', caps: 'video/x-h264, stream-format=avc, alignment=au', note: '<b>解析器（parser）</b>：不做解码，只整理码流结构。它把 SPS/PPS 与切片组织成完整访问单元，并在 avc / byte-stream 两种格式之间转换——封装器对格式很挑剔。' },
        { n: 'mp4mux', caps: 'video/quicktime（MP4/MOV）', note: '<b>封装器（muxer）</b>：给码流加时间轴、索引与轨道结构。MP4 需要可 seek 的 moov，因此 mp4mux 会先在内存/临时文件里攒数据，收到 EOS 后才写索引——突然断电会得到损坏文件。' },
        { n: 'filesink', p: 'location=cam.mp4', caps: '字节流', note: '<b>文件接收端</b>：把封装后的字节写到磁盘。它不关心格式，只是消费者。调试时可换成 fakesink（丢弃数据但保留时序），用来判断瓶颈在编码还是在写盘。' }
      ]
    },
    {
      id: 'rtsp', name: '③ 播放 RTSP 摄像头', tag: '解协议 + 解码 + 显示',
      desc: 'RTSP 不是“一个元件”能解决的：rtspsrc 负责信令与收包，depay 把 RTP 包还原成码流，parser 整理结构，decoder 还原图像。这条链也是 GB28181 播放的底层路径。',
      elements: [
        { n: 'rtspsrc', p: 'location=rtsp://192.168.1.64/Streaming/Channels/101 latency=200', caps: 'application/x-rtp（每个轨道一个 pad）', note: '<b>动态 pad 的来源</b>：rtspsrc 在 DESCRIBE/SETUP 之后才知道有几路音视频，所以它的 src pad 是“有时才出现”的（sometimes pad）。gst-launch 会自动接；写代码时必须监听 pad-added 并手动 link。latency=200 是抖动缓冲（毫秒），调小延迟低但更容易卡。' },
        { n: 'rtph264depay', caps: 'video/x-h264, stream-format=byte-stream', note: '<b>解包（depayloader）</b>：把 RTP 里拆开的 H.264 分片按序号拼回完整 NAL。丢包时这里最先报错；它也会处理 marker 位与时间戳换算。' },
        { n: 'h264parse', caps: 'video/x-h264, stream-format=avc 或 byte-stream', note: '整理访问单元，补 SPS/PPS，保证解码器拿到完整参数集。很多“花屏/黑屏”其实是 parse 阶段参数集缺失。' },
        { n: 'avdec_h264', caps: 'video/x-raw, format=I420', note: '<b>软件解码器</b>：libavcodec 的 H.264 解码。若平台有硬解，可换成 vaapih264dec / nvh264dec / qsvh264dec；它们在显存里输出，后续用 glimagesink 或 dmabuf 显示。' },
        { n: 'videoconvert', caps: 'video/x-raw, format=平台首选', note: '解码器输出 I420，显示端可能偏好 BGRx / NV12。转换一次即可；能走零拷贝时这一步应换成 glcolorconvert 或直接让 sink 吃 DMABuf。' },
        { n: 'autovideosink', caps: '可显示格式', note: '按平台自动选窗口。若画面比例不对，通常是 SAR/DAR 没被尊重；用 videoscale 或 capsfilter 明确像素宽高比。' }
      ]
    },
    {
      id: 'hls', name: '④ 文件 → HLS 切片', tag: '点播 / 直播分发',
      desc: '把本地 MP4 解封装、解码、重编码，再切成 HLS 分片。注意：解码和重编码都可省略（直接 h264parse → hlssink3），是否重编码取决于你要不要改码率/分辨率。',
      elements: [
        { n: 'filesrc', p: 'location=input.mp4', caps: '字节流', note: '文件源不是 live source：它可以一次性读得比实时快，因此流水线需要 queue 与限速机制，否则会瞬间吃掉内存。' },
        { n: 'qtdemux', caps: 'video/x-h264 / audio/x-m4a（按轨道分 pad）', note: '<b>解封装器（demuxer）</b>：读 MP4 的 box 结构，把每条轨道拆成独立码流。它的 src pad 同样是动态的，轨道数量在读到 moov 后才知道。' },
        { n: 'h264parse', caps: 'video/x-h264, alignment=au', note: '整理访问单元。切 HLS 时必须保证每个分片从关键帧开始，parser 与编码器的 GOP 设置共同决定这一点。' },
        { n: 'avdec_h264', caps: 'video/x-raw, format=I420', note: '如果只是“换封装、不换编码”，这一步和后面的编码器都可以删掉，CPU 省一个数量级。' },
        { n: 'videoconvert', caps: 'video/x-raw, format=I420', note: '统一像素格式，避免编码器协商失败。' },
        { n: 'x264enc', p: 'speed-preset=veryfast bitrate=3000 key-int-max=48', swappable: true, hwProps: 'bitrate=3000 key-int-max=48', caps: 'video/x-h264, profile=high', note: 'key-int-max=48（24 fps 下 2 秒）配合 hlssink3 的 target-duration，让分片边界尽量对齐 IDR。' },
        { n: 'h264parse', caps: 'video/x-h264, stream-format=avc', note: 'HLS 的 TS/fMP4 分片需要正确的 SPS/PPS；parser 确保每个关键帧前参数集可用。' },
        { n: 'hlssink3', p: 'location=seg%05d.ts playlist-location=index.m3u8 target-duration=4', caps: 'HLS 分片 + m3u8', note: '<b>HLS 接收端</b>：按目标时长切分片、写 playlist。target-duration 只是目标值，真实分片要等关键帧，因此 GOP 必须与它配合。' }
      ]
    },
    {
      id: 'push', name: '⑤ 低延迟推流到 RTSP 服务器', tag: 'MediaMTX / 监控上行',
      desc: '摄像头 → 硬件编码 → RTP 打包 → 推到 RTSP 服务器。和“播放 RTSP”方向相反，但元件几乎对称：pay 对应 depay，sink 对应 src。',
      elements: [
        { n: 'v4l2src', p: 'device=/dev/video0 io-mode=dmabuf', caps: 'video/x-raw(memory:DMABuf), NV12', note: 'io-mode=dmabuf 让摄像头直接把帧写进显存/共享缓冲区，避免一次 CPU 拷贝。并非所有驱动都支持；失败时退回 mmap。' },
        { n: 'videoconvert', caps: 'video/x-raw, format=I420', note: '如果编码器能直接吃 DMABuf，这一步可以省掉；否则这里会发生隐式下载（hwdownload），零拷贝就断了。' },
        { n: 'x264enc', p: 'speed-preset=ultrafast tune=zerolatency bitrate=2500 key-int-max=30', swappable: true, hwProps: 'bitrate=2500 key-int-max=30', caps: 'video/x-h264, stream-format=avc', note: '低延迟三件套：zerolatency 关闭 lookahead/B 帧，key-int-max=30 保证 1 秒一个关键帧，码率按上行带宽留 30% 余量。' },
        { n: 'h264parse', p: 'config-interval=-1', caps: 'video/x-h264, stream-format=avc', note: 'config-interval=-1 让 SPS/PPS 随每个关键帧发送，接收端中途加入也能解码。直播/监控场景几乎必开。' },
        { n: 'rtspclientsink', p: 'location=rtsp://127.0.0.1:8554/cam', caps: 'RTSP / RTP', note: '<b>RTSP 客户端接收端</b>（gst-rtsp-server 提供）：它主动向服务器 ANNOUNCE/SETUP/RECORD。服务器端 MediaMTX 会把这条流再分发给 HLS/WHEP/RTMP 观众。' }
      ]
    },
    {
      id: 'webrtc', name: '⑥ WebRTC 双向（需要应用代码）', tag: '超低延迟',
      desc: 'gst-launch 能搭出媒体链，但 WebRTC 还需要信令：交换 SDP、收集 ICE、处理 DTLS。所以最后一段 webrtcbin 必须由应用代码驱动，不能只靠命令行。',
      elements: [
        { n: 'videotestsrc', p: 'is-live=true', caps: 'video/x-raw, format=RGB, 640×480, 30/1', note: 'is-live=true 告诉流水线“这是实时源”，从而启用时钟同步与延迟补偿。' },
        { n: 'videoconvert', caps: 'video/x-raw, format=I420', note: 'VP8 编码器接受 I420。' },
        { n: 'vp8enc', p: 'deadline=1 cpu-used=4 keyframe-max-dist=30', caps: 'video/x-vp8', note: 'VP8 是 WebRTC 的基线视频编码，浏览器兼容性最好；deadline=1 表示实时模式（质量为速度让路）。' },
        { n: 'rtpvp8pay', p: 'picture-id-mode=15-bit', caps: 'application/x-rtp, encoding-name=VP8, payload=96', note: '把 VP8 帧打成 RTP 包。payloader 会按 MTU 分片，并写入序号与时间戳。' },
        { n: 'webrtcbin', p: 'name=sendrecv stun-server=stun://stun.l.google.com:19302', caps: 'DTLS-SRTP / ICE', note: '<b>webrtcbin</b> 是“协议栈元件”：它把 RTP 包变成 ICE/DTLS/SRTP 流。你需要用 request pad（sink_%u）接它，并监听 on-negotiation-needed、on-ice-candidate 信号，通过信令服务器交换 SDP。' }
      ]
    }
  ];

  function GstBuilder(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.preset = GST_PRESETS.find(p => p.id === this.opt.preset) || GST_PRESETS[0];
    this.backend = 'sw';
    this.idx = -1;
    this.timer = null;
    this.render();
  }
  GstBuilder.prototype.cmd = function () {
    const hw = this.backend !== 'sw';
    return 'gst-launch-1.0 ' + this.preset.elements.map(e => {
      let n = e.n, p = e.p || '';
      if (e.swappable && hw) {
        n = GST_HW[this.backend].el;
        p = e.hwProps || 'bitrate=4000 key-int-max=30';
      }
      return n + (p ? ' ' + p : '');
    }).join(' ! ');
  };
  GstBuilder.prototype.render = function () {
    const root = this.el;
    const presets = GST_PRESETS.map(p =>
      `<button class="gst-p" data-p="${p.id}"${p === this.preset ? ' aria-pressed="true"' : ''}>${p.name}<span>${p.tag}</span></button>`
    ).join('');
    const chain = this.preset.elements.map((e, i) => {
      const hwEl = e.swappable && this.backend !== 'sw';
      const name = hwEl ? GST_HW[this.backend].el : e.n;
      const props = hwEl ? (e.hwProps || '') : (e.p || '');
      return `<div class="gst-el" data-i="${i}">
        <small>#${i + 1}</small>
        <b>${name}</b>
        ${props ? `<code>${props}</code>` : '<code class="muted">（无属性）</code>'}
        ${e.caps ? `<div class="gst-caps">${e.caps}</div>` : ''}
      </div>` + (i < this.preset.elements.length - 1 ? '<span class="gst-ar">→</span>' : '');
    }).join('');
    const hwSelect = `<label>编码后端
      <select data-k="hw">${Object.keys(GST_HW).map(k =>
        `<option value="${k}"${k === this.backend ? ' selected' : ''}>${GST_HW[k].label}</option>`).join('')}
      </select></label>`;
    root.innerHTML = `<div class="gst">
      <div class="gst-presets">${presets}</div>
      <div class="gst-bar">
        <span class="ti">流水线视图 · 点击元件看解释</span>
        <button class="btn-mini" data-act="play">▶ 走一遍数据</button>
        <button class="btn-mini" data-act="copy">⧉ 复制命令</button>
      </div>
      <div class="gst-chain">${chain}</div>
      <pre class="code gst-cmd">${this.cmd()}</pre>
      <div class="gst-ctl">
        ${hwSelect}
        <span class="small gst-hwtip">${GST_HW[this.backend].tip}</span>
      </div>
      <div class="seq-note gst-note" data-k="note"></div>
    </div>`;
    root.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => {
      const p = GST_PRESETS.find(x => x.id === b.dataset.p);
      if (p) { this.stop(); this.preset = p; this.idx = -1; this.render(); }
    }));
    root.querySelectorAll('.gst-el').forEach(b => b.addEventListener('click', () => {
      this.stop(); this.idx = +b.dataset.i; this.update();
    }));
    root.querySelector('[data-k="hw"]').addEventListener('change', e => {
      this.backend = e.target.value; this.idx = -1; this.render();
    });
    root.querySelector('[data-act="play"]').addEventListener('click', () => this.play());
    root.querySelector('[data-act="copy"]').addEventListener('click', e => {
      const t = this.cmd();
      const done = () => { e.target.textContent = '✓ 已复制'; setTimeout(() => { e.target.textContent = '⧉ 复制命令'; }, 1200); };
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, done);
      else {
        const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (err) { }
        ta.remove(); done();
      }
    });
    this.update();
  };
  GstBuilder.prototype.update = function () {
    const root = this.el; if (!root) return;
    const els = root.querySelectorAll('.gst-el');
    els.forEach((b, i) => b.classList.toggle('on', i === this.idx));
    const e = this.preset.elements[this.idx];
    root.querySelector('[data-k="note"]').innerHTML =
      e ? `<b>#${this.idx + 1} ${e.n}</b>：${e.note}`
        : `<b>怎么读这条链？</b>${this.preset.desc}<br><span class="small">提示：GStreamer 的方向永远是 src pad → sink pad；数据从左向右流，事件（EOS、SEEK）可以逆流而上。</span>`;
  };
  GstBuilder.prototype.play = function () {
    if (this.timer) { this.stop(); this.idx = -1; this.update(); return; }
    this.idx = 0; this.update();
    this.timer = setInterval(() => {
      this.idx++;
      if (this.idx >= this.preset.elements.length) { this.stop(); this.idx = -1; this.update(); return; }
      this.update();
    }, 850);
  };
  GstBuilder.prototype.stop = function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } };
  GstBuilder.fromElement = function (el) {
    let o = {}; try { o = JSON.parse(el.dataset.opts || '{}'); } catch (e) { }
    return new GstBuilder(el, o);
  };

  /* ========== 浏览器流播放器（WHEP / HLS / FLV） ========== */
  const SP_RULES = [
    { id: 'whep', re: /\/whep(\?|$)|mode=whep/i, label: 'WHEP（WebRTC）' },
    { id: 'hls', re: /\.m3u8(\?|$)|\/hls\//i, label: 'HLS（m3u8）' },
    { id: 'flv', re: /\.flv(\?|$)/i, label: 'HTTP-FLV' },
    { id: 'rtsp', re: /^rtsp(s)?:\/\//i, label: 'RTSP（需网关）' },
    { id: 'rtmp', re: /^rtmp(s)?:\/\//i, label: 'RTMP（需网关）' },
    { id: 'file', re: /\.(mp4|webm|ogg|m4v)(\?|$)/i, label: '普通文件' }
  ];

  function detectStream(url) {
    const s = String(url || '').trim();
    if (!s) return { id: 'none', label: '等待输入' };
    return SP_RULES.find(r => r.re.test(s)) || { id: 'unknown', label: '无法识别' };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const old = document.querySelector(`script[src="${src}"]`);
      if (old) { old.dataset.loaded === '1' ? resolve() : old.addEventListener('load', resolve, { once: true }); return; }
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
      s.addEventListener('error', () => reject(new Error('脚本加载失败：' + src)), { once: true });
      document.head.appendChild(s);
    });
  }

  function StreamPlayer(el, opt) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    this.opt = opt || {};
    this.pc = null; this.hls = null; this.flv = null; this.whepUrl = null;
    this.render();
  }
  StreamPlayer.prototype.log = function (msg, kind) {
    const box = this.el.querySelector('[data-k="log"]');
    if (!box) return;
    const cls = kind === 'err' ? 'color:#e11d48' : kind === 'ok' ? 'color:#047857' : '';
    box.innerHTML += `<div style="${cls}">[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}</div>`;
    box.scrollTop = box.scrollHeight;
  };
  StreamPlayer.prototype.meta = function (html) {
    const b = this.el.querySelector('[data-k="meta"]');
    if (b) b.innerHTML = html;
  };
  StreamPlayer.prototype.render = function () {
    const root = this.el;
    root.innerHTML = `<div class="sp">
      <div class="sp-bar">
        <input type="text" data-k="url" value="${this.opt.url || ''}" placeholder="rtsp://… · rtmp://… · https://…/index.m3u8 · …/live.flv · …/whep">
        <button class="btn-mini" data-act="play">▶ 播放</button>
        <button class="btn-mini" data-act="stop">■ 停止</button>
        <span class="badge-ok" data-k="kind">等待输入</span>
      </div>
      <div class="sp-stage"><video data-k="video" playsinline muted controls></video>
        <div class="sp-hint" data-k="hint">粘贴一个流地址。RTSP / RTMP 不能直连，页面会给出网关方案。</div>
      </div>
      <div class="small" data-k="meta" style="margin-top:.5rem"></div>
      <div class="sp-log" data-k="log"></div>
    </div>`;
    const input = root.querySelector('[data-k="url"]');
    const kind = root.querySelector('[data-k="kind"]');
    const upd = () => {
      const t = detectStream(input.value);
      kind.textContent = t.label;
      kind.className = t.id === 'rtsp' || t.id === 'rtmp' ? 'badge-no' : 'badge-ok';
      if (t.id === 'rtsp' || t.id === 'rtmp') {
        root.querySelector('[data-k="hint"]').innerHTML =
          `<b>${t.label}</b> 浏览器不能直接打开：它没有任意 TCP 连接能力。<br>请用网关转成 WHEP / HLS / FLV，见页面下方“网关配方”。`;
      } else if (t.id === 'whep') {
        root.querySelector('[data-k="hint"]').innerHTML = 'WHEP：原生 RTCPeerConnection 直接收流，延迟通常 &lt; 1 秒。';
      } else if (t.id === 'hls') {
        root.querySelector('[data-k="hint"]').innerHTML = 'HLS：Safari 原生播放；其他浏览器自动加载 hls.js。';
      } else if (t.id === 'flv') {
        root.querySelector('[data-k="hint"]').innerHTML = 'HTTP-FLV：自动加载 mpegts.js，延迟一般 1–3 秒。';
      } else {
        root.querySelector('[data-k="hint"]').innerHTML = '粘贴一个流地址。RTSP / RTMP 不能直连，页面会给出网关方案。';
      }
    };
    input.addEventListener('input', upd);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') this.play(); });
    if (this.opt.url) upd();
    root.querySelector('[data-act="play"]').addEventListener('click', () => this.play());
    root.querySelector('[data-act="stop"]').addEventListener('click', () => this.stop());
  };
  StreamPlayer.prototype.play = async function () {
    const url = this.el.querySelector('[data-k="url"]').value.trim();
    const v = this.el.querySelector('[data-k="video"]');
    const t = detectStream(url);
    this.log(`识别为：${t.label}`, 'ok');
    if (!url) { this.log('地址为空', 'err'); return; }
    if (t.id === 'rtsp' || t.id === 'rtmp') {
      this.meta('浏览器无法直连，需要网关。见下方“网关配方”。');
      this.log('已拦截：缺少浏览器侧可用的传输层', 'err');
      return;
    }
    this.stop(true);
    try {
      if (t.id === 'whep') await this.playWhep(url, v);
      else if (t.id === 'hls') await this.playHls(url, v);
      else if (t.id === 'flv') await this.playFlv(url, v);
      else if (t.id === 'file') { v.src = url; await v.play(); this.log('直接使用 video 元素播放文件'); }
      else this.log('无法识别地址类型。WHEP 地址通常以 /whep 结尾，HLS 以 .m3u8 结尾。', 'err');
    } catch (e) {
      this.log('播放失败：' + (e && e.message ? e.message : e), 'err');
    }
  };
  StreamPlayer.prototype.playWhep = async function (url, v) {
    this.log('创建 RTCPeerConnection（recvonly）…');
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc = pc;
    const stream = new MediaStream();
    v.srcObject = stream;
    pc.ontrack = ev => { stream.addTrack(ev.track); this.log('收到轨道：' + ev.track.kind, 'ok'); };
    pc.onconnectionstatechange = () => {
      this.log('连接状态：' + pc.connectionState, pc.connectionState === 'failed' ? 'err' : 'ok');
      if (pc.connectionState === 'connected') this.meta('WHEP 已连接 · 延迟通常在 200–800 ms');
    };
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const to = setTimeout(res, 3000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(to); res(); }
      });
    });
    this.log('POST SDP offer → ' + url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', 'Accept': 'application/sdp' },
      body: pc.localDescription.sdp
    });
    if (!res.ok) throw new Error(`WHEP 返回 HTTP ${res.status}（404 路径错 / 405 未开 WHEP / 401 需鉴权）`);
    this.whepUrl = res.headers.get('Location') || url;
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    this.log('SDP 协商完成，等待媒体…', 'ok');
    await v.play().catch(() => this.log('自动播放被拦截，请点击视频控件', 'err'));
  };
  StreamPlayer.prototype.playHls = async function (url, v) {
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url; await v.play(); this.log('使用浏览器原生 HLS（Safari）', 'ok');
      this.meta('HLS 原生播放 · 延迟通常 6–20 秒');
      return;
    }
    this.log('加载 hls.js…');
    await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js');
    if (!window.Hls || !window.Hls.isSupported()) throw new Error('hls.js 不可用');
    const h = new window.Hls({ lowLatencyMode: true, enableWorker: true });
    this.hls = h;
    h.loadSource(url); h.attachMedia(v);
    h.on(window.Hls.Events.MANIFEST_PARSED, () => { v.play(); this.log('HLS 清单解析完成', 'ok'); });
    h.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal) this.log('HLS 错误：' + d.details, 'err'); });
    this.meta('hls.js · 低延迟模式已开启');
  };
  StreamPlayer.prototype.playFlv = async function (url, v) {
    this.log('加载 mpegts.js…');
    await loadScript('https://cdn.jsdelivr.net/npm/mpegts.js@1/dist/mpegts.js');
    if (!window.mpegts || !window.mpegts.isSupported()) throw new Error('mpegts.js 不可用');
    const p = window.mpegts.createPlayer({ type: 'flv', url, isLive: true, hasAudio: true });
    this.flv = p;
    p.attachMediaElement(v); p.load();
    p.on(window.mpegts.Events.ERROR, (t, d) => this.log('FLV 错误：' + t + ' ' + d, 'err'));
    await v.play();
    this.log('FLV 拉流已启动', 'ok');
    this.meta('mpegts.js · 延迟通常 1–3 秒');
  };
  StreamPlayer.prototype.stop = function (quiet) {
    const v = this.el.querySelector('[data-k="video"]');
    if (this.pc) {
      try { this.pc.close(); } catch (e) { }
      if (this.whepUrl) fetch(this.whepUrl, { method: 'DELETE' }).catch(() => { });
      this.pc = null; this.whepUrl = null;
    }
    if (this.hls) { try { this.hls.destroy(); } catch (e) { } this.hls = null; }
    if (this.flv) { try { this.flv.destroy(); } catch (e) { } this.flv = null; }
    if (v) { v.pause(); v.removeAttribute('src'); v.srcObject = null; v.load(); }
    if (!quiet) this.log('已停止并释放资源');
  };
  StreamPlayer.fromElement = function (el) {
    let o = {}; try { o = JSON.parse(el.dataset.opts || '{}'); } catch (e) { }
    return new StreamPlayer(el, o);
  };

  /* ========== 统一初始化入口 ========== */
  function initViz(el) {
    if (!el || el.dataset.vizInit) return;
    el.dataset.vizInit = '1';
    const v = el.dataset.viz;
    if (v === 'hex') HexViewer.fromElement(el);
    else if (v === 'seq') SeqAnimator.fromElement(el);
    else if (v === 'gop') GopViewer.fromElement(el);
    else if (v === 'quant') QuantDemo.fromElement(el);
    else if (v === 'chroma') ChromaDemo.fromElement(el);
    else if (v === 'mux') MuxDemo.fromElement(el);
    else if (v === 'abr') AbrSim.fromElement(el);
    else if (v === 'zerocopy') ZeroCopy.fromElement(el);
    else if (v === 'gst') GstBuilder.fromElement(el);
    else if (v === 'stream') StreamPlayer.fromElement(el);
  }

  window.HexViewer = HexViewer;
  window.SeqAnimator = SeqAnimator;
  window.GopViewer = GopViewer;

  function init() {
    initToc();
    initTabs();
    // 非标签页内的可视化立即初始化
    document.querySelectorAll('[data-lazy-viz]').forEach(el => {
      if (el.closest('.tab-pnl')) return; // 由标签页激活时初始化
      initViz(el);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
