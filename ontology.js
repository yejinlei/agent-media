// 音视频本体图谱：无依赖力导向图（可拖拽 / 悬停 / 分组过滤 / 点击跳转）
(function () {
  'use strict';

  const GROUPS = {
    concept: { name: '核心概念', color: '#7c3aed', light: '#ede9fe' },
    container: { name: '封装容器', color: '#0891b2', light: '#ecfeff' },
    vcodec: { name: '视频编码', color: '#e11d48', light: '#fff1f2' },
    acodec: { name: '音频编码', color: '#f59e0b', light: '#fffbeb' },
    protocol: { name: '传输协议', color: '#10b981', light: '#ecfdf5' },
    hw: { name: '硬件加速', color: '#6366f1', light: '#eef2ff' },
    tool: { name: '工具链', color: '#64748b', light: '#f1f5f9' }
  };

  const NODES = [
    { id: 'media', label: '音视频媒体', g: 'concept', r: 15, url: '#intro' },
    { id: 'container', label: '容器', g: 'concept', r: 12, url: 'container/' },
    { id: 'vcodec', label: '视频编码', g: 'concept', r: 12, url: 'codec/' },
    { id: 'acodec', label: '音频编码', g: 'concept', r: 12, url: 'codec/' },
    { id: 'protocol', label: '协议', g: 'concept', r: 12, url: 'protocol/' },
    { id: 'hw', label: '硬件加速', g: 'concept', r: 12, url: 'hwaccel/' },
    { id: 'pipeline', label: '处理流水线', g: 'concept', r: 10, url: '#pipeline' },

    { id: 'mp4', label: 'MP4', g: 'container', r: 9, url: 'container/#mp4' },
    { id: 'ts', label: 'MPEG-TS', g: 'container', r: 9, url: 'container/#ts' },
    { id: 'mkv', label: 'MKV', g: 'container', r: 8, url: 'container/#mkv' },
    { id: 'flv', label: 'FLV', g: 'container', r: 8, url: 'container/#flv' },
    { id: 'webm', label: 'WebM', g: 'container', r: 7, url: 'container/#webm' },
    { id: 'mov', label: 'MOV', g: 'container', r: 7, url: 'container/#mov' },

    { id: 'h264', label: 'H.264', g: 'vcodec', r: 10, url: 'codec/#h264' },
    { id: 'h265', label: 'H.265', g: 'vcodec', r: 9, url: 'codec/#h265' },
    { id: 'av1', label: 'AV1', g: 'vcodec', r: 9, url: 'codec/#av1' },
    { id: 'vp9', label: 'VP9', g: 'vcodec', r: 7, url: 'codec/#vp9' },
    { id: 'vvc', label: 'VVC', g: 'vcodec', r: 6, url: 'codec/#vvc' },
    { id: 'prores', label: 'ProRes', g: 'vcodec', r: 6, url: 'codec/#prores' },

    { id: 'aac', label: 'AAC', g: 'acodec', r: 9, url: 'codec/#aac' },
    { id: 'opus', label: 'Opus', g: 'acodec', r: 8, url: 'codec/#opus' },
    { id: 'mp3', label: 'MP3', g: 'acodec', r: 6, url: 'codec/#audio-others' },
    { id: 'ac3', label: 'AC-3', g: 'acodec', r: 6, url: 'codec/#audio-others' },
    { id: 'flac', label: 'FLAC', g: 'acodec', r: 6, url: 'codec/#audio-others' },
    { id: 'pcm', label: 'PCM', g: 'acodec', r: 6, url: 'codec/#audio-others' },

    { id: 'rtmp', label: 'RTMP', g: 'protocol', r: 9, url: 'protocol/#rtmp' },
    { id: 'rtsp', label: 'RTSP', g: 'protocol', r: 8, url: 'protocol/#rtsp' },
    { id: 'rtp', label: 'RTP', g: 'protocol', r: 6, url: 'protocol/#rtsp' },
    { id: 'srt', label: 'SRT', g: 'protocol', r: 8, url: 'protocol/#srt' },
    { id: 'hls', label: 'HLS', g: 'protocol', r: 9, url: 'protocol/#hls' },
    { id: 'dash', label: 'DASH', g: 'protocol', r: 8, url: 'protocol/#dash' },
    { id: 'webrtc', label: 'WebRTC', g: 'protocol', r: 9, url: 'protocol/#webrtc' },
    { id: 'httpflv', label: 'HTTP-FLV', g: 'protocol', r: 6, url: 'protocol/#httpflv' },

    { id: 'nvenc', label: 'NVENC', g: 'hw', r: 8, url: 'hwaccel/#nvidia' },
    { id: 'qsv', label: 'QSV', g: 'hw', r: 8, url: 'hwaccel/#intel' },
    { id: 'vaapi', label: 'VAAPI', g: 'hw', r: 8, url: 'hwaccel/#linux' },
    { id: 'vt', label: 'VideoToolbox', g: 'hw', r: 7, url: 'hwaccel/#apple' },
    { id: 'amf', label: 'AMF', g: 'hw', r: 7, url: 'hwaccel/#amd' },
    { id: 'd3d11', label: 'D3D11VA', g: 'hw', r: 7, url: 'hwaccel/#windows' },

    { id: 'ffmpeg', label: 'FFmpeg', g: 'tool', r: 9, url: '#quickstart' },
    { id: 'gstreamer', label: 'GStreamer', g: 'tool', r: 7, url: '#quickstart' },
    { id: 'obs', label: 'OBS', g: 'tool', r: 7, url: '#quickstart' },
    { id: 'srs', label: 'SRS', g: 'tool', r: 6, url: 'protocol/#rtmp' },
    { id: 'mediamtx', label: 'MediaMTX', g: 'tool', r: 6, url: 'protocol/#rtsp' },
    { id: 'shaka', label: 'Shaka', g: 'tool', r: 6, url: 'protocol/#dash' }
  ];

  const LINKS = [
    ['media', 'container', '包含'], ['media', 'vcodec', '包含'], ['media', 'acodec', '包含'],
    ['media', 'protocol', '包含'], ['media', 'hw', '包含'], ['media', 'pipeline', '包含'],
    ['container', 'mp4', '实例'], ['container', 'ts', '实例'], ['container', 'mkv', '实例'],
    ['container', 'flv', '实例'], ['container', 'webm', '实例'], ['container', 'mov', '实例'],
    ['vcodec', 'h264', '实例'], ['vcodec', 'h265', '实例'], ['vcodec', 'av1', '实例'],
    ['vcodec', 'vp9', '实例'], ['vcodec', 'vvc', '实例'], ['vcodec', 'prores', '实例'],
    ['acodec', 'aac', '实例'], ['acodec', 'opus', '实例'], ['acodec', 'mp3', '实例'],
    ['acodec', 'ac3', '实例'], ['acodec', 'flac', '实例'], ['acodec', 'pcm', '实例'],
    ['protocol', 'rtmp', '实例'], ['protocol', 'rtsp', '实例'], ['protocol', 'srt', '实例'],
    ['protocol', 'hls', '实例'], ['protocol', 'dash', '实例'], ['protocol', 'webrtc', '实例'],
    ['protocol', 'httpflv', '实例'],
    ['hw', 'nvenc', '实例'], ['hw', 'qsv', '实例'], ['hw', 'vaapi', '实例'],
    ['hw', 'vt', '实例'], ['hw', 'amf', '实例'], ['hw', 'd3d11', '实例'],
    ['rtsp', 'rtp', '基于'], ['hls', 'ts', '切片'], ['dash', 'mp4', '切片'],
    ['httpflv', 'flv', '封装'], ['rtmp', 'flv', '封装'], ['webrtc', 'rtp', '基于'],
    ['mp4', 'h264', '封装'], ['mp4', 'aac', '封装'], ['ts', 'h264', '封装'],
    ['ts', 'aac', '封装'], ['mkv', 'h265', '封装'], ['mkv', 'opus', '封装'],
    ['flv', 'h264', '封装'], ['flv', 'aac', '封装'], ['webm', 'vp9', '封装'],
    ['webm', 'opus', '封装'], ['mov', 'prores', '封装'],
    ['nvenc', 'h264', '加速'], ['nvenc', 'h265', '加速'], ['nvenc', 'av1', '加速'],
    ['qsv', 'h264', '加速'], ['qsv', 'h265', '加速'], ['vaapi', 'h264', '加速'],
    ['vaapi', 'h265', '加速'], ['vt', 'h264', '加速'], ['vt', 'h265', '加速'],
    ['amf', 'h264', '加速'], ['amf', 'h265', '加速'], ['d3d11', 'h264', '解码'],
    ['ffmpeg', 'pipeline', '编排'], ['gstreamer', 'pipeline', '编排'],
    ['obs', 'rtmp', '推流'], ['srs', 'rtmp', '服务'], ['mediamtx', 'rtsp', '服务'],
    ['mediamtx', 'srt', '服务'], ['shaka', 'dash', '打包'], ['shaka', 'hls', '打包']
  ];

  function init() {
    const wrap = document.getElementById('ontology-graph');
    if (!wrap) return;
    const canvas = wrap.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const legend = document.getElementById('onto-legend');
    const info = document.getElementById('onto-info');
    const resetBtn = document.getElementById('onto-reset');
    let W = 0, H = 0, dpr = window.devicePixelRatio || 1;
    let filter = null, hover = null, drag = null;
    let alpha = 1;

    const nodes = NODES.map((n, i) => {
      const ang = (i / NODES.length) * Math.PI * 2;
      return {
        ...n, x: 0, y: 0, vx: 0, vy: 0,
        deg: 0, _ang: ang
      };
    });
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    const links = LINKS.map(([a, b, rel]) => ({ a: byId[a], b: byId[b], rel })).filter(l => l.a && l.b);
    links.forEach(l => { l.a.deg++; l.b.deg++; });

    function resize() {
      const rect = wrap.getBoundingClientRect();
      W = Math.max(320, rect.width); H = 520;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = W / 2, cy = H / 2;
      nodes.forEach(n => {
        if (!n._init) {
          n.x = cx + Math.cos(n._ang) * (150 + Math.random() * 90);
          n.y = cy + Math.sin(n._ang) * (120 + Math.random() * 60);
          n._init = true;
        }
      });
      alpha = 1;
    }

    function tick() {
      const cx = W / 2, cy = H / 2;
      // 斥力
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          if (d < 260) {
            const f = (260 - d) / d * 0.03;
            dx *= f; dy *= f;
            a.vx -= dx; a.vy -= dy; b.vx += dx; b.vy += dy;
          }
        }
      }
      // 弹簧
      links.forEach(l => {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const target = 106;
        const f = (d - target) / d * 0.022;
        l.a.vx += dx * f; l.a.vy += dy * f;
        l.b.vx -= dx * f; l.b.vy -= dy * f;
      });
      // 向心 + 阻尼
      nodes.forEach(n => {
        n.vx += (cx - n.x) * 0.0022;
        n.vy += (cy - n.y) * 0.0022;
        n.vx *= 0.86; n.vy *= 0.86;
        n.x += n.vx; n.y += n.vy;
        const pad = 70;
        n.x = Math.max(pad, Math.min(W - pad, n.x));
        n.y = Math.max(pad + 18, Math.min(H - pad, n.y));
      });
      alpha *= 0.985;
      if (alpha > 0.12) requestAnimationFrame(tick);
      draw();
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      // 网格背景
      ctx.strokeStyle = '#eef2f7'; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      links.forEach(l => {
        const dim = filter && l.a.g !== filter && l.b.g !== filter;
        const hi = hover && (l.a === hover || l.b === hover);
        ctx.strokeStyle = dim ? '#e2e8f0' : hi ? '#7c3aed' : '#cbd5e1';
        ctx.globalAlpha = dim ? 0.35 : hi ? 0.9 : 0.55;
        ctx.lineWidth = hi ? 1.8 : 1;
        ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke();
        ctx.globalAlpha = 1;
      });

      nodes.forEach(n => {
        const g = GROUPS[n.g];
        const dim = filter && n.g !== filter;
        const on = hover === n;
        ctx.globalAlpha = dim ? 0.25 : 1;
        // 阴影圈
        if (on) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6, 0, 7); ctx.fillStyle = g.light; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fillStyle = g.color; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
        // 标签
        ctx.font = `${on ? '700 12px' : '500 10px'} -apple-system, "Segoe UI", "PingFang SC", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = dim ? '#94a3b8' : on ? '#0f172a' : '#334155';
        ctx.fillText(n.label, n.x, n.y + n.r + 13);
        ctx.globalAlpha = 1;
      });

      if (hover) drawRefs(hover);
    }

    function drawRefs(n) {
      ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      LINKS.forEach(([a, b, rel]) => {
        if (!(a === n.id || b === n.id)) return;
        const o = byId[a === n.id ? b : a];
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(o.x, o.y); ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function hit(p) {
      let best = null, bd = 1e9;
      nodes.forEach(n => {
        const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
        if (d < (n.r + 8) ** 2 && d < bd) { bd = d; best = n; }
      });
      return best;
    }

    canvas.addEventListener('pointermove', e => {
      const p = pos(e);
      if (drag) {
        if (Math.abs(p.x - drag.x) > 3 || Math.abs(p.y - drag.y) > 3) drag.moved = true;
        drag.node.x = p.x; drag.node.y = p.y;
        drag.node.vx = 0; drag.node.vy = 0;
        alpha = Math.max(alpha, 0.6);
        draw(); return;
      }
      const h = hit(p);
      if (h !== hover) {
        hover = h;
        canvas.style.cursor = h ? 'pointer' : 'grab';
        if (h) {
          const rels = LINKS.filter(([a, b]) => a === h.id || b === h.id)
            .map(([a, b, rel]) => {
              const o = byId[a === h.id ? b : a];
              return `${rel} → ${o.label}`;
            }).slice(0, 6);
          info.innerHTML = `<b>${h.label}</b> <span class="tag tag-p" style="margin-left:.2rem">${GROUPS[h.g].name}</span><br><span style="color:#64748b">${rels.join(' · ') || '孤立节点'}</span>`;
        } else {
          info.innerHTML = '拖拽节点可以重排图谱；点击节点跳转到对应专题。悬停查看关系。';
        }
        draw();
      }
    });
    canvas.addEventListener('pointerdown', e => {
      const h = hit(pos(e));
      if (h) {
        const p = pos(e);
        drag = { node: h, x: p.x, y: p.y, moved: false };
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointerup', e => {
      if (drag && !drag.moved && drag.node.url) {
        const url = drag.node.url;
        drag = null;
        window.location.href = url;
        return;
      }
      drag = null;
    });
    canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; draw(); } });

    if (legend) {
      legend.innerHTML = Object.entries(GROUPS).map(([k, g]) =>
        `<button class="btn-mini" data-g="${k}" style="border-color:${g.color}40;background:${g.light};color:${g.color};margin:.12rem"><span style="display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:${g.color};margin-right:.3rem"></span>${g.name}</button>`
      ).join('') + `<button class="btn-mini" data-g="" style="margin:.12rem">全部</button>`;
      legend.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          filter = btn.dataset.g || null;
          legend.querySelectorAll('button').forEach(b => b.style.outline = b === btn ? '2px solid #7c3aed' : '');
          alpha = Math.max(alpha, 0.4);
          draw();
        });
      });
    }
    if (resetBtn) resetBtn.addEventListener('click', () => {
      filter = null; hover = null;
      nodes.forEach((n, i) => {
        const ang = (i / nodes.length) * Math.PI * 2;
        n.x = W / 2 + Math.cos(ang) * 170; n.y = H / 2 + Math.sin(ang) * 140;
        n.vx = n.vy = 0;
      });
      alpha = 1; tick();
    });

    window.addEventListener('resize', () => { resize(); draw(); });
    resize();
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
