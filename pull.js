// av-ontology · 共享真拉流模块：HTTP 直链 / HLS(.m3u8) / DASH(.mpd)
// 供 wasm.html 实验台与 analyze.html 分析器复用。rtsp/rtmp 等非 http(s) scheme 统一拦截：
// 浏览器与 wasm 都没有 socket，也没编入这些协议栈，需先经网关（ffmpeg / MediaMTX）转成 HLS 再拉。
(function () {
  'use strict';

  const RTSP_SCHEMES = /^(rtsp|rtmp|rtmps|rtmpe|udp|mms|srt|rist|zmtp):/i;

  // 进度显示：hint 可以是 DOM 元素（写 textContent）或回调函数
  function prog(hint, text) {
    if (!hint) return;
    if (typeof hint === 'function') hint(text);
    else hint.textContent = text;
  }

  async function fetchBytes(u, label) {
    const resp = await fetch(u);
    if (!resp.ok) throw new Error(label + ' HTTP ' + resp.status + ' ' + resp.statusText);
    const blob = await resp.blob();
    if (!blob.size) throw new Error(label + ' 拉取到 0 字节（目标服务器可能未允许跨域 CORS 访问）');
    return blob;
  }

  // HLS：拉 .m3u8，递归解析（主清单→媒体清单），逐段拉 .ts 分片，合并为完整 TS（或 MPEG-TS 容器）
  async function pullHls(masterUrl, hint) {
    const text = await (await fetch(masterUrl)).text();
    if (!/#EXTM3U/.test(text)) throw new Error('不是有效的 HLS 清单（缺少 #EXTM3U）');
    // 主清单：含 #EXT-X-STREAM-INF 且无分片 → 取第一个变体的媒体清单
    let mediaUrl = masterUrl, mediaText = text;
    if (!/#EXTINF/.test(text) && /#EXT-X-STREAM-INF/.test(text)) {
      const m = /#EXT-X-STREAM-INF:[^\n]*\n([^\n]+)/.exec(text);
      if (!m) throw new Error('HLS 主清单未找到媒体清单');
      mediaUrl = new URL(m[1].trim(), masterUrl).href;
      mediaText = await (await fetch(mediaUrl)).text();
      if (!/#EXT-X-MEDIA-SEQUENCE|#EXTINF/.test(mediaText)) throw new Error('变体清单里没有分片');
    }
    const segs = mediaText.split('\n').filter(l => l && !l.startsWith('#'));
    if (!segs.length) throw new Error('HLS 清单里没有分片（直播流无历史分片，请用 VOD 点播地址）');
    const chunks = [];
    let total = 0;
    for (let i = 0; i < segs.length; i++) {
      const segUrl = new URL(segs[i].trim(), mediaUrl).href;
      const b = await fetchBytes(segUrl, '分片 ' + (i + 1) + '/' + segs.length);
      chunks.push(await b.arrayBuffer());
      total += b.size;
      if (i % 5 === 0) prog(hint, '⏳ HLS 拉分片 ' + (i + 1) + '/' + segs.length + ' …');
    }
    return { blob: new Blob(chunks, { type: 'video/mp2t' }), total, name: 'url.ts' };
  }

  // DASH：拉 .mpd，收集 init 分段 + 全部 media 分段，按顺序拼接（假定 fMP4，逐段拼接即可被 ffmpeg 读取）。
  // 支持静态 <SegmentURL>，也支持 <SegmentTemplate>（$Number$ / $RepresentationID$ / $Bandwidth$ 模板）与 <BaseURL>。
  function resolveDashUrl(ref, base) {
    if (!ref) return null;
    try { return new URL(ref, base).href; } catch (e) { return null; }
  }
  // 解析 DASH 的时长：既接受纯数字（秒），也接受 ISO 8601 如 PT634.566S、PT1H2M3.5S
  function parseDashDuration(s) {
    if (!s) return 0;
    if (/^[\d.]+$/.test(s.trim())) return parseFloat(s);
    const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s.trim());
    if (!m) return 0;
    return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  }
  async function pullDash(mpdUrl, hint) {
    const text = await (await fetch(mpdUrl)).text();
    const base = new URL(mpdUrl);
    const chunks = []; let total = 0;
    const addSeg = async (u, tag) => {
      const b = await fetchBytes(u, tag);
      chunks.push(await b.arrayBuffer()); total += b.size;
      if (tag) prog(hint, '⏳ DASH ' + tag + ' · 已拉 ' + (total / 1e6).toFixed(1) + ' MB');
    };
    const iniRe = /<Initialization[^>]*sourceURL="([^"]+)"/gi;
    const segRe = /<SegmentURL[^>]*media="([^"]+)"/gi;
    let m, added = 0;
    // 代表轨：取第一个 Representation 的 id/bandwidth。SegmentTemplate 常定义在 AdaptationSet/Period 层，
    // 对所有 rep 生效——不能因为 rep 标签里搜不到模板就把 id 落到最后一个（那可能是音频轨，路径完全不同）。
    const reps = text.split(/<Representation\b/).slice(1);
    let target = reps.length ? reps[0] : text;
    let repId = '', repBw = '';
    if (reps.length) {
      const idm = /^[^>]*?\bid="([^"]+)"/.exec(reps[0]);
      if (idm) repId = idm[1];
      const bwm = /^[^>]*?\bbandwidth="([^"]+)"/.exec(reps[0]);
      if (bwm) repBw = bwm[1];
      for (const r of reps) {
        if (/SegmentURL|<Initialization/.test(r)) { target = r; break; }
      }
    }
    const hasRepTemplate = /SegmentTemplate|SegmentURL|<Initialization/.test(target);
    // 模板/静态分段若不在代表层，回退到全文（AdaptationSet / Period 层定义）
    let tmTarget = target;
    if (!hasRepTemplate && /SegmentTemplate/.test(text)) tmTarget = text;
    // BaseURL（相对路径）
    let baseUrl = mpdUrl;
    const bm = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(target) || /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(text);
    if (bm) baseUrl = resolveDashUrl(bm[1].trim(), base) || mpdUrl;
    const expandTpl = s => s.replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, repBw);
    // init 分段来源一：SegmentList 风格的 <Initialization sourceURL>
    const initSrc = /<Initialization/.test(target) ? target : text;
    iniRe.lastIndex = 0;
    while ((m = iniRe.exec(initSrc))) {
      const u = resolveDashUrl(m[1], baseUrl);
      if (u) { await addSeg(u, 'init 分段'); added++; }
    }
    // 静态 SegmentURL
    const segSrc = /SegmentURL/.test(target) ? target : text;
    segRe.lastIndex = 0;
    while ((m = segRe.exec(segSrc))) {
      const u = resolveDashUrl(m[1], baseUrl);
      if (u) { await addSeg(u, 'media 分段'); added++; }
    }
    // SegmentTemplate（$Number$ 等），用代表轨的 repId/repBw 展开 $RepresentationID$/$Bandwidth$
    const tm = /<SegmentTemplate\b[^>]*media="([^"]+)"[^>]*>/.exec(tmTarget) ||
               /<SegmentTemplate\b[^>]*>/.exec(tmTarget);
    if (tm) {
      // init 分段来源二：SegmentTemplate 的 initialization 属性（fMP4 缺 init 段将无法 demux）
      const initAttr = /initialization="([^"]+)"/.exec(tm[0]);
      if (initAttr) {
        const iu = resolveDashUrl(expandTpl(initAttr[1]), baseUrl);
        if (iu) { await addSeg(iu, 'init 分段'); added++; }
      }
      const tpl = tm[1] || (tm[0].match(/media="([^"]+)"/) || [])[1];
      const sT = parseInt(/startNumber="(\d+)"/.exec(tm[0])?.[1] || '1', 10);
      const dur = parseFloat(/duration="([\d.]+)"/.exec(tm[0])?.[1] || '0');
      if (tpl && dur) {
        const timescale = parseFloat(/timescale="(\d+)"/.exec(tm[0])?.[1] || '1');
        const per = parseDashDuration(/mediaPresentationDuration="([^"]+)"/.exec(text)?.[1]);
        const endNum = parseInt(/endNumber="(\d+)"/.exec(tm[0])?.[1] || '0', 10);
        const byDur = per > 0 ? Math.max(1, Math.ceil(per / (dur / timescale))) : 0;
        const count = endNum > sT ? (endNum - sT + 1) : byDur;
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            const n = sT + i;
            const u = resolveDashUrl(expandTpl(tpl).replace(/\$Number\$/g, n), baseUrl);
            if (!u) continue;
            try {
              await addSeg(u, 'media 分段 ' + (i + 1) + '/' + count); added++;
            } catch (err) {
              // 末段可能因时长取整多算而不存在，容忍跳过；中间段失败照常抛出
              if (i === count - 1) prog(hint, '⚠️ 末段 ' + n + ' 不存在，已跳过：' + (err && err.message || err));
              else throw err;
            }
          }
        }
      }
    }
    if (!added) throw new Error('DASH 清单里没有可解析的分段（可能是直播动态清单或使用了无法展开的模板，请改用 VOD 点播 .mpd）');
    return { blob: new Blob(chunks, { type: 'video/mp4' }), total, name: 'url.mp4' };
  }

  // 通用入口：按 URL 形态分发，返回 { blob, total, name }
  async function pullAny(u, hint) {
    if (RTSP_SCHEMES.test(u)) {
      throw new Error('浏览器（含 wasm）不能直连 ' + u.slice(0, u.indexOf(':') + 1) + ' —— 没有 socket，也没编入该协议。请先经网关转成 HLS：ffmpeg -i ' + u.split(':')[0] + '://… -c copy -f hls http://…/stream.m3u8，再把 http 地址填到这里真拉。');
    }
    const lower = u.toLowerCase();
    if (lower.includes('.m3u8') || lower.includes('m3u8?')) return pullHls(u, hint);
    if (lower.includes('.mpd') || lower.includes('mpd?')) return pullDash(u, hint);
    const b = await fetchBytes(u, '媒体');
    return { blob: b, total: b.size, name: 'url.' + (/\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(u)?.[1]?.toLowerCase() || 'bin') };
  }

  window.AVPull = { RTSP_SCHEMES, fetchBytes, pullHls, pullDash, pullAny };
})();
