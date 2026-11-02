/* 在线音视频分析器 —— 完全在浏览器本地解析，不依赖 main.js、不引入任何外部库。
   解析相关的核心逻辑均写成纯函数，挂在 window.AVAnalyzer（同时支持 CommonJS 导出），
   便于在无 DOM 环境下单独测试。 */
(function (root) {
  'use strict';

  /* ================= 一、通用字节工具 ================= */

  function bstr(b, o, n) {
    let s = '';
    for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }
  function u8(b, o) { return b[o] & 255; }
  function u16(b, o) { return ((b[o] & 255) << 8) | (b[o + 1] & 255); }
  function u24(b, o) { return ((b[o] & 255) << 16) | ((b[o + 1] & 255) << 8) | (b[o + 2] & 255); }
  function u32(b, o) { return (((b[o] & 255) << 24) | ((b[o + 1] & 255) << 16) | ((b[o + 2] & 255) << 8) | (b[o + 3] & 255)) >>> 0; }
  function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
  function hexStr(b, o, n) {
    const parts = [];
    for (let i = 0; i < n && o + i < b.length; i++) parts.push((b[o + i] & 255).toString(16).padStart(2, '0'));
    return parts.join(' ');
  }
  function pad2(v) { return String(v).padStart(2, '0'); }
  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function fmtMs(ms) {
    if (Number.isNaN(ms) || ms < 0) return '—';
    if (ms < 1000) return ms.toFixed(1) + ' ms';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(2) + ' s';
    const m = Math.floor(s / 60);
    return m + ' 分 ' + (s - m * 60).toFixed(2) + ' 秒';
  }
  function fmtNum(n, d) { return Number(n).toFixed(d === undefined ? 2 : d); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function isFourCC(b, o, s) { return bstr(b, o, 4) === s; }

  function concatBytes(list) {
    let n = 0;
    list.forEach(x => { n += x.length; });
    const out = new Uint8Array(n);
    let o = 0;
    list.forEach(x => { out.set(x, o); o += x.length; });
    return out;
  }
  function asciiBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }
  function beU16(v) { return new Uint8Array([(v >>> 8) & 255, v & 255]); }
  function beU24(v) { return new Uint8Array([(v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function beU32(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function beFixed88(v) { const iv = Math.round(v * 65536); return beU32(iv >>> 0); }

  /* MPEG-2 CRC32（PSI/SI 使用，多项式 0x04C11DB7，高位在前） */
  function crc32Mpeg(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= (bytes[i] & 255) << 24;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x80000000) ? (((crc << 1) ^ 0x04C11DB7) >>> 0) : ((crc << 1) >>> 0);
      }
    }
    return crc >>> 0;
  }

  /* ================= 二、内置示例合成（结构真实、体量很小） ================= */

  /* 2.1 位写入器：用于现场生成一段合法的 H.264 SPS/PPS */
  function BitWriter() { this.bytes = []; this.cur = 0; this.n = 0; }
  BitWriter.prototype.bit = function (b) {
    this.cur = (this.cur << 1) | (b & 1);
    this.n++;
    if (this.n === 8) { this.bytes.push(this.cur & 255); this.cur = 0; this.n = 0; }
  };
  BitWriter.prototype.bits = function (v, n) {
    for (let i = n - 1; i >= 0; i--) this.bit((v >>> i) & 1);
  };
  BitWriter.prototype.ue = function (v) {
    const n = Math.floor(Math.log2(v + 1));
    for (let i = 0; i < n; i++) this.bit(0);
    this.bits(v + 1, n + 1);
  };
  BitWriter.prototype.se = function (v) { this.ue(v <= 0 ? -2 * v : 2 * v - 1); };
  BitWriter.prototype.finish = function () {
    // rbsp_trailing_bits：先写停止位 1，再补零到字节对齐
    this.bit(1);
    while (this.n !== 0) this.bit(0);
    return new Uint8Array(this.bytes);
  };

  /* 插入防竞争字节：00 00 后跟 00/01/02/03 时插入 03 */
  function addEmulationPrevention(bytes) {
    const out = [];
    let zeros = 0;
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i];
      if (zeros >= 2 && v <= 3) { out.push(3); zeros = 0; }
      out.push(v);
      if (v === 0) zeros++; else zeros = 0;
    }
    return new Uint8Array(out);
  }
  function removeEmulationPrevention(bytes) {
    const out = [];
    let zeros = 0;
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i];
      if (zeros >= 2 && v === 3) { zeros = 0; continue; }
      out.push(v);
      if (v === 0) zeros++; else zeros = 0;
    }
    return new Uint8Array(out);
  }

  /* 生成 1280×720、Baseline、level 3.1 的 SPS（含 NAL 头 0x67） */
  function makeSps720() {
    const w = new BitWriter();
    w.bits(66, 8);          // profile_idc = Baseline
    w.bits(0, 8);           // constraint flags
    w.bits(31, 8);          // level_idc = 3.1
    w.ue(0);                // seq_parameter_set_id
    w.ue(0);                // log2_max_frame_num_minus4
    w.ue(0);                // pic_order_cnt_type
    w.ue(0);                // log2_max_pic_order_cnt_lsb_minus4
    w.ue(1);                // max_num_ref_frames
    w.bit(0);               // gaps_in_frame_num_value_allowed_flag
    w.ue(79);               // pic_width_in_mbs_minus1 = 80×16 = 1280
    w.ue(44);               // pic_height_in_map_units_minus1 = 45×16 = 720
    w.bit(1);               // frame_mbs_only_flag
    w.bit(1);               // direct_8x8_inference_flag
    w.bit(0);               // frame_cropping_flag
    w.bit(0);               // vui_parameters_present_flag
    const rbsp = addEmulationPrevention(w.finish());
    return concatBytes([new Uint8Array([0x67]), rbsp]);
  }
  function makePps() {
    const w = new BitWriter();
    w.ue(0);   // pic_parameter_set_id
    w.ue(0);   // seq_parameter_set_id
    w.bit(0);  // entropy_coding_mode_flag
    w.bit(0);  // bottom_field_pic_order_in_frame_present_flag
    w.ue(0);   // num_slice_groups_minus1
    w.ue(0);   // num_ref_idx_l0_default_active_minus1
    w.ue(0);   // num_ref_idx_l1_default_active_minus1
    w.bit(0);  // weighted_pred_flag
    w.bits(0, 2); // weighted_bipred_idc
    w.se(0);   // pic_init_qp_minus26
    w.se(0);   // pic_init_qs_minus26
    w.se(0);   // chroma_qp_index_offset
    w.bit(1);  // deblocking_filter_control_present_flag
    w.bit(0);  // constrained_intra_pred_flag
    w.bit(0);  // redundant_pic_cnt_present_flag
    const rbsp = addEmulationPrevention(w.finish());
    return concatBytes([new Uint8Array([0x68]), rbsp]);
  }

  /* 2.2 MP4 box 构造 */
  function box(type, payload) {
    const p = payload || new Uint8Array(0);
    return concatBytes([beU32(8 + p.length), asciiBytes(type), p]);
  }
  function fullBox(type, version, flags, payload) {
    const head = concatBytes([new Uint8Array([version & 255]), beU24(flags >>> 0)]);
    return box(type, concatBytes([head, payload || new Uint8Array(0)]));
  }
  function zeros(n) { return new Uint8Array(n); }

  function makeAvcC(sps, pps) {
    // AVCDecoderConfigurationRecord：version 1、profile/compat/level、lengthSize=4、1 组 SPS、1 组 PPS
    const head = new Uint8Array([
      1, sps[1] & 255, sps[2] & 255, sps[3] & 255,
      0xFF, 0xE1
    ]);
    const spsPart = concatBytes([beU16(sps.length), sps]);
    const ppsPart = concatBytes([new Uint8Array([1]), beU16(pps.length), pps]);
    return concatBytes([head, spsPart, ppsPart]);
  }

  function buildMp4Sample() {
    const SPS = makeSps720(), PPS = makePps();
    const avcC = makeAvcC(SPS, PPS);

    const ftyp = box('ftyp', concatBytes([
      asciiBytes('isom'), beU32(512),
      asciiBytes('isom'), asciiBytes('iso2'), asciiBytes('avc1'), asciiBytes('mp41')
    ]));

    // mvhd：timescale 1000，duration 3000 ms
    const mvhdPayload = concatBytes([
      beU32(0), beU32(0), beU32(1000), beU32(3000),
      beU32(0x00010000), beU16(0x0100), beU16(0), zeros(8),
      beU32(0x00010000), beU32(0), beU32(0), beU32(0), beU32(0x00010000),
      beU32(0), beU32(0), beU32(0), beU32(0), beU32(0x40000000),
      zeros(24), beU32(2)
    ]);
    const mvhd = fullBox('mvhd', 0, 0, mvhdPayload);

    // tkhd：track 1，1280×720（16.16 定点）
    const tkhdPayload = concatBytes([
      beU32(0), beU32(0), beU32(1), beU32(0), beU32(3000),
      zeros(8), beU16(0), beU16(0), beU16(0), beU16(0),
      beU32(0x00010000), beU32(0), beU32(0), beU32(0), beU32(0x00010000),
      beU32(0), beU32(0), beU32(0), beU32(0), beU32(0x40000000),
      beFixed88(1280), beFixed88(720)
    ]);
    const tkhd = fullBox('tkhd', 0, 3, tkhdPayload);

    // mdhd：媒体时间基 90000，时长 3 s
    const mdhd = fullBox('mdhd', 0, 0, concatBytes([
      beU32(0), beU32(0), beU32(90000), beU32(270000),
      beU16(0x55C4), beU16(0)   // language = und
    ]));
    const hdlr = fullBox('hdlr', 0, 0, concatBytes([
      beU32(0), asciiBytes('vide'), zeros(12), asciiBytes('VideoHandler'), new Uint8Array([0])
    ]));

    // avc1 视觉样本条目：78 字节固定头 + avcC
    const avc1Payload = concatBytes([
      zeros(6), beU16(1),
      zeros(16),
      beU16(1280), beU16(720),
      beU32(0x00480000), beU32(0x00480000), beU32(0), beU16(1),
      zeros(32), beU16(0x0018), beU16(0xFFFF),
      avcC
    ]);
    const stsd = fullBox('stsd', 0, 0, concatBytes([beU32(1), box('avc1', avc1Payload)]));

    // stts：90 个样本，每个 delta 3000 tick（90000/3000 = 30 fps）
    const stts = fullBox('stts', 0, 0, concatBytes([beU32(1), beU32(90), beU32(3000)]));
    // stsz：固定样本大小 1500 B
    const stsz = fullBox('stsz', 0, 0, concatBytes([beU32(1500), beU32(90)]));
    // stco：一个 chunk，偏移放在 mdat 内
    const stco = fullBox('stco', 0, 0, concatBytes([beU32(1), beU32(0)]));
    // stss：只有第 1 帧是关键帧
    const stss = fullBox('stss', 0, 0, concatBytes([beU32(1), beU32(1)]));

    const stbl = box('stbl', concatBytes([stsd, stts, stsz, stco, stss]));
    const vmhd = fullBox('vmhd', 0, 1, concatBytes([beU16(0), beU16(0), beU16(0), beU16(0)]));
    const dref = fullBox('dref', 0, 0, concatBytes([beU32(1), fullBox('url ', 0, 1, new Uint8Array(0))]));
    const dinf = box('dinf', dref);
    const minf = box('minf', concatBytes([vmhd, dinf, stbl]));
    const mdia = box('mdia', concatBytes([mdhd, hdlr, minf]));
    const trak = box('trak', concatBytes([tkhd, mdia]));
    const moov = box('moov', concatBytes([mvhd, trak]));
    const mdat = box('mdat', new Uint8Array(4000).fill(0x5A));

    // 让 stco 指向真实偏移：重新计算一次
    const beforeMdat = concatBytes([ftyp, moov]);
    const dataOffset = beforeMdat.length + 8; // mdat 头 8 字节之后即样本数据
    const stcoFixed = fullBox('stco', 0, 0, concatBytes([beU32(1), beU32(dataOffset)]));
    const stbl2 = box('stbl', concatBytes([stsd, stts, stsz, stcoFixed, stss]));
    const minf2 = box('minf', concatBytes([vmhd, dinf, stbl2]));
    const mdia2 = box('mdia', concatBytes([mdhd, hdlr, minf2]));
    const trak2 = box('trak', concatBytes([tkhd, mdia2]));
    const moov2 = box('moov', concatBytes([mvhd, trak2]));

    return {
      bytes: concatBytes([ftyp, moov2, mdat]),
      sps: SPS, pps: PPS, avcC: avcC
    };
  }

  /* 2.3 MPEG-TS 构造 */
  function tsPacket(pid, cc, pusi, payload, pcrBase) {
    const p = new Uint8Array(188);
    p[0] = 0x47;
    p[1] = (pusi ? 0x40 : 0) | ((pid >>> 8) & 0x1F);
    p[2] = pid & 255;
    const hasPcr = pcrBase !== undefined && pcrBase !== null;
    const afLen = 183 - payload.length;
    p[3] = 0x30 | (cc & 15); // adaptation + payload，无加扰
    if (afLen < 1) throw new Error('TS 包载荷过长');
    p[4] = afLen;
    p[5] = hasPcr ? 0x10 : 0x00;
    if (hasPcr) {
      const base = Math.floor(pcrBase) % 8589934592;
      const ext = 0;
      p[6] = (base / 33554432) & 255;
      p[7] = (base / 131072) & 255;
      p[8] = (base / 512) & 255;
      p[9] = (base / 2) & 255;
      p[10] = ((base & 1) << 7) | 0x7E | ((ext >>> 8) & 1);
      p[11] = ext & 255;
    }
    // 其余适配字段填充 0xFF
    for (let i = 6 + (hasPcr ? 6 : 0); i <= 4 + afLen; i++) p[i] = 0xFF;
    p.set(payload, 5 + afLen);
    return p;
  }

  function makePsiSection(tableId, body) {
    // body 从 section_length 之后开始（含 table_id_extension、version、section 号等）
    const total = 3 + body.length + 4;
    const sec = new Uint8Array(total);
    sec[0] = tableId;
    sec[1] = 0xB0 | (((total - 3) >>> 8) & 0x0F);
    sec[2] = (total - 3) & 255;
    sec.set(body, 3);
    const crc = crc32Mpeg(sec.subarray(0, total - 4));
    sec[total - 4] = (crc >>> 24) & 255;
    sec[total - 3] = (crc >>> 16) & 255;
    sec[total - 2] = (crc >>> 8) & 255;
    sec[total - 1] = crc & 255;
    return sec;
  }

  function makePat(programNumber, pmtPid) {
    const body = new Uint8Array(9);
    body[0] = 0x00; body[1] = 0x01; // transport_stream_id = 1
    body[2] = 0xC1;                 // version 0，current_next = 1
    body[3] = 0; body[4] = 0;       // section 0 / last 0
    body[5] = 0x00; body[6] = programNumber & 255;
    body[7] = 0xE0 | ((pmtPid >>> 8) & 0x1F); body[8] = pmtPid & 255;
    return makePsiSection(0x00, body);
  }

  function makePmt(programNumber, pcrPid, streams) {
    const body = new Uint8Array(9 + streams.length * 5);
    body[0] = 0x00; body[1] = programNumber & 255;
    body[2] = 0xC1; body[3] = 0; body[4] = 0;
    body[5] = 0xE0 | ((pcrPid >>> 8) & 0x1F); body[6] = pcrPid & 255;
    body[7] = 0xF0; body[8] = 0x00; // program_info_length = 0
    let o = 9;
    streams.forEach(s => {
      body[o++] = s.streamType;
      body[o++] = 0xE0 | ((s.pid >>> 8) & 0x1F);
      body[o++] = s.pid & 255;
      body[o++] = 0xF0;
      body[o++] = 0x00;
    });
    return makePsiSection(0x02, body);
  }

  function buildTsSample() {
    const SPS = makeSps720(), PPS = makePps();
    const videoPid = 0x0100, audioPid = 0x0101, pmtPid = 0x1000, pcrPid = 0x0100;
    const packets = [];
    const pat = makePat(1, pmtPid);
    packets.push(tsPacket(0, 0, true, concatBytes([new Uint8Array([0]), pat]), 0));
    const pmt = makePmt(1, pcrPid, [
      { streamType: 0x1B, pid: videoPid },
      { streamType: 0x0F, pid: audioPid }
    ]);
    packets.push(tsPacket(pmtPid, 0, true, concatBytes([new Uint8Array([0]), pmt]), 0));

    // 视频：首个包带 SPS/PPS/IDR 片段
    const slice = concatBytes([
      new Uint8Array([0, 0, 0, 1]), SPS,
      new Uint8Array([0, 0, 0, 1]), PPS,
      new Uint8Array([0, 0, 0, 1, 0x65]), new Uint8Array(60).fill(0x88)
    ]);
    let vcc = 0;
    for (let i = 0; i < 8; i++) {
      const chunk = slice.subarray(Math.floor(i * slice.length / 8), Math.floor((i + 1) * slice.length / 8));
      packets.push(tsPacket(videoPid, vcc++, i === 0, chunk, 90000 * (i * 0.5)));
    }
    // 音频：AAC（每包 20 ms 的伪装载荷）
    for (let i = 0; i < 5; i++) packets.push(tsPacket(audioPid, vcc++, i === 0, new Uint8Array(36).fill(0x21), 90000 * (i * 0.2)));
    // 空包（只有适配字段，无载荷）
    for (let i = 0; i < 2; i++) {
      const p = new Uint8Array(188); p[0] = 0x47; p[1] = 0x1F; p[2] = 0xFF; p[3] = 0x20;
      p[4] = 0x00;
      for (let k = 5; k < 188; k++) p[k] = 0xFF;
      packets.push(p);
    }
    return { bytes: concatBytes(packets), sps: SPS, pps: PPS };
  }

  /* 2.4 FLV 构造（AMF0 + AVC sequence header + AAC sequence header） */
  function amfNumber(v) {
    const b = new Uint8Array(9);
    b[0] = 0x00;
    const view = new DataView(b.buffer);
    view.setFloat64(1, v, false);
    return b;
  }
  function amfString(s) {
    return concatBytes([new Uint8Array([0x02]), beU16(s.length), asciiBytes(s)]);
  }
  function amfKey(k) {
    return concatBytes([beU16(k.length), asciiBytes(k)]);
  }
  function makeOnMetaData() {
    const props = [
      ['duration', 3],
      ['width', 1280],
      ['height', 720],
      ['framerate', 30],
      ['videocodecid', 7],
      ['audiocodecid', 10],
      ['encoder', 'AVAnalyzer Demo']
    ];
    const parts = [new Uint8Array([0x02]), beU16(10), asciiBytes('onMetaData'), new Uint8Array([0x08]), beU32(props.length)];
    props.forEach(([k, v]) => {
      parts.push(amfKey(k));
      if (typeof v === 'number') parts.push(amfNumber(v));
      else parts.push(amfString(v));
    });
    parts.push(concatBytes([new Uint8Array([0, 0, 0x09])])); // 对象结束
    return concatBytes(parts);
  }

  function flvTag(type, body, ts) {
    const head = concatBytes([
      new Uint8Array([type & 255]),
      beU24(body.length),
      beU24(ts & 0xFFFFFF),
      new Uint8Array([(ts >>> 24) & 255]),
      beU24(0)
    ]);
    const tag = concatBytes([head, body]);
    return concatBytes([tag, beU32(tag.length)]);
  }

  function buildFlvSample() {
    const SPS = makeSps720(), PPS = makePps();
    const avcC = makeAvcC(SPS, PPS);
    const header = concatBytes([asciiBytes('FLV'), new Uint8Array([1, 0x05]), beU32(9), beU32(0)]);
    const script = flvTag(18, makeOnMetaData(), 0);
    const avcBody = concatBytes([
      new Uint8Array([0x17]), // key frame + AVC
      new Uint8Array([0x00]), // AVC sequence header
      beU24(0),               // composition time
      avcC
    ]);
    const audioBody = concatBytes([
      new Uint8Array([0xAF]), // AAC、44100 Hz、16 bit、立体声
      new Uint8Array([0x00]), // AAC sequence header
      new Uint8Array([0x12, 0x10]) // ASC：AOT 2、索引 4、双声道
    ]);
    return {
      bytes: concatBytes([header, script, flvTag(9, avcBody, 0), flvTag(8, audioBody, 0)]),
      sps: SPS, pps: PPS, avcC: avcC, asc: new Uint8Array([0x12, 0x10])
    };
  }

  /* 2.5 EBML / Matroska 构造 */
  function ebmlId(idHex) {
    const clean = idHex.replace(/[^0-9A-Fa-f]/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }
  function ebmlSize(n) {
    let len = 1;
    while (len <= 8 && n >= Math.pow(2, len * 7) - 1) len++;
    const out = new Uint8Array(len);
    let v = n + Math.pow(2, len * 7); // 置上 marker 位
    for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    return out;
  }
  function ebmlEl(idHex, payload) {
    return concatBytes([ebmlId(idHex), ebmlSize(payload.length), payload]);
  }
  function ebmlUint(v) {
    const bytes = [];
    do { bytes.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0);
    return new Uint8Array(bytes);
  }
  function ebmlFloat(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, false);
    return b;
  }

  function buildMkvSample() {
    const ebmlHeader = ebmlEl('1A45DFA3', concatBytes([
      ebmlEl('4286', ebmlUint(1)),        // EBMLVersion
      ebmlEl('42F7', ebmlUint(1)),        // EBMLReadVersion
      ebmlEl('42F2', ebmlUint(4)),        // EBMLMaxIDLength
      ebmlEl('42F3', ebmlUint(8)),        // EBMLMaxSizeLength
      ebmlEl('4282', asciiBytes('matroska')), // DocType
      ebmlEl('4287', ebmlUint(4)),        // DocTypeVersion
      ebmlEl('4285', ebmlUint(2))         // DocTypeReadVersion
    ]));
    const info = ebmlEl('1549A966', concatBytes([
      ebmlEl('2AD7B1', ebmlUint(1000000)),  // TimestampScale = 1 ms
      ebmlEl('4489', ebmlFloat(3000)),      // Duration = 3000 ticks
      ebmlEl('4D80', asciiBytes('av-analyzer')), // MuxingApp
      ebmlEl('5741', asciiBytes('av-analyzer'))  // WritingApp
    ]));
    const videoTrack = ebmlEl('AE', concatBytes([
      ebmlEl('D7', ebmlUint(1)),            // TrackNumber
      ebmlEl('73C5', ebmlUint(1)),          // TrackUID
      ebmlEl('83', ebmlUint(1)),            // TrackType = video
      ebmlEl('86', asciiBytes('V_MPEG4/ISO/AVC')),
      ebmlEl('E0', concatBytes([
        ebmlEl('B0', ebmlUint(1280)),       // PixelWidth
        ebmlEl('BA', ebmlUint(720))         // PixelHeight
      ]))
    ]));
    const audioTrack = ebmlEl('AE', concatBytes([
      ebmlEl('D7', ebmlUint(2)),
      ebmlEl('73C5', ebmlUint(2)),
      ebmlEl('83', ebmlUint(2)),
      ebmlEl('86', asciiBytes('A_AAC')),
      ebmlEl('E1', concatBytes([
        ebmlEl('B5', ebmlFloat(44100)),     // SamplingFrequency
        ebmlEl('9F', ebmlUint(2))           // Channels
      ]))
    ]));
    const tracks = ebmlEl('1654AE6B', concatBytes([videoTrack, audioTrack]));
    const segment = ebmlEl('18538067', concatBytes([info, tracks]));
    return { bytes: concatBytes([ebmlHeader, segment]) };
  }

  /* 统一生成 4 个容器示例 */
  function buildSamples() {
    return {
      mp4: buildMp4Sample(),
      ts: buildTsSample(),
      flv: buildFlvSample(),
      mkv: buildMkvSample()
    };
  }

  /* ================= 三、容器识别与解析 ================= */

  function findTsSync(bytes) {
    const limit = Math.min(bytes.length - 564, 4096);
    for (let i = 0; i < limit; i++) {
      if (bytes[i] !== 0x47) continue;
      if (bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47 &&
          (i + 564 >= bytes.length || bytes[i + 564] === 0x47)) return i;
    }
    return -1;
  }

  function detectContainer(bytes) {
    if (!bytes || bytes.length === 0) return { kind: 'empty', label: '空数据' };
    if (bytes.length >= 12 && isFourCC(bytes, 4, 'ftyp')) {
      return { kind: 'mp4', label: 'MP4 / MOV（ISO BMFF）', detail: 'ftyp 品牌：' + bstr(bytes, 8, 4) };
    }
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
      return { kind: 'mkv', label: 'Matroska / WebM（EBML）', detail: 'EBML 魔数 1A 45 DF A3' };
    }
    if (bytes.length >= 9 && bstr(bytes, 0, 3) === 'FLV') {
      return { kind: 'flv', label: 'FLV（Flash Video）', detail: '版本 ' + bytes[3] };
    }
    if (bytes.length >= 12 && bstr(bytes, 0, 4) === 'RIFF') {
      const form = bstr(bytes, 8, 4);
      if (form === 'WAVE') return { kind: 'wav', label: 'WAV（RIFF/WAVE）', detail: 'PCM 波形容器' };
      if (form === 'AVI ') return { kind: 'avi', label: 'AVI（RIFF/AVI）', detail: '仅识别与顶层 chunk' };
      return { kind: 'riff', label: 'RIFF（未知子类型 ' + form + '）' };
    }
    if (bytes.length >= 4 && bstr(bytes, 0, 4) === 'OggS') {
      return { kind: 'ogg', label: 'Ogg（OggS 页）', detail: 'Ogg 封装' };
    }
    const tsOff = findTsSync(bytes);
    if (tsOff >= 0) return { kind: 'ts', label: 'MPEG-TS（188 字节包）', detail: '首个同步字节位于偏移 ' + tsOff };
    if (bytes.length >= 3 && bstr(bytes, 0, 3) === 'ID3') {
      return { kind: 'mp3', label: 'MP3（ID3 标签）', detail: '检测到 ID3 元数据' };
    }
    if (bytes.length >= 2 && (bytes[0] & 0xFF) === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
      return { kind: 'mp3', label: 'MP3（帧同步）', detail: '0xFFEx 帧头' };
    }
    return { kind: 'unknown', label: '未识别', detail: '前 16 字节：' + hexStr(bytes, 0, Math.min(16, bytes.length)) };
  }

  /* ---------- 3.1 MP4 / MOV ---------- */

  var MP4_CONTAINERS = {
    moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, edts: 1, dinf: 1,
    mvex: 1, moof: 1, traf: 1, udta: 1, ilst: 1, 'meta': 1
  };

  function mp4ChildBoxes(bytes, start, end, depth, out, parent) {
    let off = start, guard = 0;
    while (off + 8 <= end) {
      if (++guard > 50000) break;
      let size = u32(bytes, off);
      const type = bstr(bytes, off + 4, 4);
      let headerSize = 8;
      if (size === 1) {
        if (off + 16 > end) break;
        size = u64(bytes, off + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = end - off; // 延伸到父容器末尾
      }
      if (size < headerSize) break; // 畸形 size，停止当前层，防止死循环
      if (type === 'uuid') headerSize += 16;
      let realSize = size;
      if (off + size > end) { realSize = end - off; } // 截断：按剩余长度显示
      const node = {
        type, offset: off, size: realSize, headerSize, depth,
        children: [], info: '', truncated: off + size > end
      };
      if (parent) parent.children.push(node);
      out.push(node);
      const payloadStart = off + headerSize;
      const boxEnd = off + realSize;
      if (realSize >= headerSize + 8 && MP4_CONTAINERS[type]) {
        const skip = type === 'meta' ? 4 : 0; // meta 是 full box，前面有 version/flags
        if (payloadStart + skip + 8 <= boxEnd) mp4ChildBoxes(bytes, payloadStart + skip, boxEnd, depth + 1, out, node);
      } else if (type === 'stsd' && payloadStart + 8 <= boxEnd) {
        mp4ParseStsd(bytes, payloadStart, boxEnd, depth + 1, out, node);
      }
      node.info = mp4BoxInfo(bytes, node);
      off += size;
    }
  }

  function mp4ParseStsd(bytes, payloadStart, end, depth, out, parent) {
    const entryCount = u32(bytes, payloadStart + 4);
    let p = payloadStart + 8;
    for (let i = 0; i < entryCount && p + 8 <= end; i++) {
      const size = u32(bytes, p);
      const type = bstr(bytes, p + 4, 4);
      if (size < 8) break;
      const realSize = Math.min(size, end - p);
      const node = { type, offset: p, size: realSize, headerSize: 8, depth, children: [], info: '', truncated: p + size > end };
      parent.children.push(node);
      out.push(node);
      let childStart = 0;
      const isVisual = /^(avc1|avc2|avc3|avc4|hvc1|hev1|hvt1|mp4v|vp09|av01|ap4h|encv)$/.test(type);
      const isAudio = /^(mp4a|enca|Opus|fLaC|ac-3|ec-3|alac|mp3 |samr)$/.test(type);
      if (isVisual) {
        node.info = u16(bytes, p + 32) + '×' + u16(bytes, p + 34) + ' · 视觉样本条目';
        childStart = p + 8 + 78;
      } else if (isAudio) {
        const ver = u16(bytes, p + 16);
        node.info = u16(bytes, p + 24) + ' 声道 · ' + Math.round(u32(bytes, p + 32) / 65536) + ' Hz';
        childStart = p + 8 + (ver === 1 ? 44 : ver === 2 ? 64 : 28);
      }
      if (childStart && childStart + 8 <= p + realSize) {
        mp4ChildBoxes(bytes, childStart, p + realSize, depth + 1, out, node);
      } else {
        node.info = type + ' 样本条目';
      }
      p += size;
    }
  }

  function mp4Find(node, type) {
    if (!node) return null;
    if (node.type === type) return node;
    for (const c of node.children) {
      const r = mp4Find(c, type);
      if (r) return r;
    }
    return null;
  }
  function mp4FindAll(node, type) {
    const out = [];
    (function rec(n) {
      if (!n) return;
      if (n.type === type) out.push(n);
      n.children.forEach(rec);
    })(node);
    return out;
  }

  function mp4BoxInfo(bytes, n) {
    const o = n.offset, end = o + n.size;
    try {
      if (n.type === 'ftyp') return '品牌 ' + bstr(bytes, o + 8, 4) + ' · 兼容 ' + bstr(bytes, o + 16, 4);
      if (n.type === 'mvhd') {
        const v = bytes[o + 8];
        const ts = v === 1 ? u32(bytes, o + 28) : u32(bytes, o + 20);
        const dur = v === 1 ? u64(bytes, o + 32) : u32(bytes, o + 24);
        return 'timescale=' + ts + ' · duration=' + dur + ' → ' + fmtMs(dur * 1000 / (ts || 1));
      }
      if (n.type === 'tkhd') {
        const v = bytes[o + 8];
        return 'track_id=' + (v === 1 ? u32(bytes, o + 28) : u32(bytes, o + 20)) +
          ' · ' + fmtNum(u32(bytes, end - 8) / 65536, 0) + '×' + fmtNum(u32(bytes, end - 4) / 65536, 0);
      }
      if (n.type === 'mdhd') {
        const v = bytes[o + 8];
        const ts = v === 1 ? u32(bytes, o + 28) : u32(bytes, o + 20);
        const dur = v === 1 ? u64(bytes, o + 32) : u32(bytes, o + 24);
        return 'media timescale=' + ts + ' · duration=' + dur + ' tick';
      }
      if (n.type === 'hdlr') return 'handler=' + bstr(bytes, o + 16, 4);
      if (n.type === 'stsd') return '样本描述 entry_count=' + u32(bytes, o + 12);
      if (n.type === 'stts') {
        const cnt = u32(bytes, o + 12);
        let samples = 0, ticks = 0;
        for (let i = 0; i < cnt && o + 16 + i * 8 + 8 <= end; i++) {
          samples += u32(bytes, o + 16 + i * 8);
          ticks += u32(bytes, o + 16 + i * 8) * u32(bytes, o + 20 + i * 8);
        }
        return cnt + ' 组 · ' + samples + ' 样本 · ' + ticks + ' tick';
      }
      if (n.type === 'stsz') {
        const fixed = u32(bytes, o + 12);
        return 'sample_size=' + fixed + ' · count=' + u32(bytes, o + 16);
      }
      if (n.type === 'stco' || n.type === 'co64') return 'chunk 偏移 ' + u32(bytes, o + 12) + ' 个';
      if (n.type === 'stss') return '同步样本 ' + u32(bytes, o + 12) + ' 个';
      if (n.type === 'avcC') {
        return 'profile=' + bytes[o + 9] + ' · level=' + bytes[o + 11] + ' · SPS ' + (bytes[o + 13] & 0x1F) + ' 组';
      }
      if (n.type === 'hvcC') return 'HEVC profile=' + ((bytes[o + 9] & 0x1F)) + ' · level=' + bytes[o + 12];
      if (n.type === 'esds') return 'ES 描述符（内含 AudioSpecificConfig）';
      if (n.type === 'mdat') return '媒体数据 ' + fmtBytes(n.size);
      if (n.type === 'free' || n.type === 'skip') return '填充 / 可跳过';
    } catch (e) { return ''; }
    return '';
  }

  function findEsdsAsc(bytes, node) {
    // 在 esds 中扫描 0x05（DecoderSpecificInfo）描述符，读取其中的 ASC
    const start = node.offset + node.headerSize, end = node.offset + node.size;
    for (let i = start; i + 2 < end; i++) {
      if (bytes[i] !== 0x05) continue;
      let p = i + 1, len = bytes[p];
      if (len === 0x80) { len = 0; let k = 0; while (k < 4) { const b = bytes[++p]; len = (len << 7) | (b & 0x7F); if (!(b & 0x80)) break; k++; } }
      p++;
      if (len >= 2 && p + 2 <= end) return bytes.slice(p, Math.min(p + len, end));
    }
    return null;
  }

  function parseMp4(bytes) {
    const flat = [], roots = [];
    mp4ChildBoxes(bytes, 0, bytes.length, 0, flat, null);
    // 顶层节点需要单独维护（上面 out 已含全部，这里筛出 depth=0）
    flat.forEach(n => { if (n.depth === 0) roots.push(n); });
    const moov = roots.find(n => n.type === 'moov') || null;
    const result = {
      kind: 'mp4', boxes: roots, flat, tracks: [], durationMs: 0,
      brands: [], avcC: null, hvcC: null, asc: null, sps: null, pps: null, warnings: []
    };
    const ftyp = roots.find(n => n.type === 'ftyp');
    if (ftyp) for (let i = ftyp.offset + 16; i + 4 <= ftyp.offset + ftyp.size; i += 4) {
      const brand = bstr(bytes, i, 4);
      if (/^[\x20-\x7E]{4}$/.test(brand)) result.brands.push(brand);
    }

    if (moov) {
      const mvhds = mp4FindAll(moov, 'mvhd');
      if (mvhds.length) {
        const o = mvhds[0].offset, v = bytes[o + 8];
        const ts = v === 1 ? u32(bytes, o + 28) : u32(bytes, o + 20);
        const dur = v === 1 ? u64(bytes, o + 32) : u32(bytes, o + 24);
        result.durationMs = ts ? dur * 1000 / ts : 0;
      }
    }
    const traks = mp4FindAll(moov, 'trak');
    traks.forEach((trak, idx) => {
      const tkhd = mp4Find(trak, 'tkhd');
      const mdhd = mp4Find(trak, 'mdhd');
      const hdlr = mp4Find(trak, 'hdlr');
      const stsd = mp4Find(trak, 'stsd');
      const stts = mp4Find(trak, 'stts');
      const stsz = mp4Find(trak, 'stsz');
      const stss = mp4Find(trak, 'stss');
      const track = {
        index: idx + 1, trackId: 0, handler: '', codec: '', width: 0, height: 0,
        timescale: 0, duration: 0, samples: 0, fps: 0, keyframes: 0, channels: 0, sampleRate: 0
      };
      if (tkhd) {
        const v = bytes[tkhd.offset + 8];
        track.trackId = v === 1 ? u32(bytes, tkhd.offset + 28) : u32(bytes, tkhd.offset + 20);
        track.width = Math.round(u32(bytes, tkhd.offset + tkhd.size - 8) / 65536);
        track.height = Math.round(u32(bytes, tkhd.offset + tkhd.size - 4) / 65536);
      }
      if (mdhd) {
        const v = bytes[mdhd.offset + 8];
        track.timescale = v === 1 ? u32(bytes, mdhd.offset + 28) : u32(bytes, mdhd.offset + 20);
        track.duration = v === 1 ? u64(bytes, mdhd.offset + 32) : u32(bytes, mdhd.offset + 24);
      }
      if (hdlr) track.handler = bstr(bytes, hdlr.offset + 16, 4);
      if (stsd && stsd.children.length) {
        const entry = stsd.children[0];
        track.codec = entry.type;
        track.width = track.width || u16(bytes, entry.offset + 32);
        track.height = track.height || u16(bytes, entry.offset + 34);
        track.channels = u16(bytes, entry.offset + 24);
        track.sampleRate = Math.round(u32(bytes, entry.offset + 32) / 65536);
        const avcC = mp4Find(entry, 'avcC');
        const hvcC = mp4Find(entry, 'hvcC');
        const esds = mp4Find(entry, 'esds');
        if (avcC) {
          track.avcC = parseAvcC(bytes, avcC.offset + avcC.headerSize);
          result.avcC = avcC;
          if (track.avcC.sps.length) {
            result.sps = track.avcC.sps[0].bytes;
            result.pps = track.avcC.pps.length ? track.avcC.pps[0].bytes : null;
          }
        }
        if (hvcC) {
          result.hvcC = hvcC;
          track.hvcC = parseHvcC(bytes, hvcC.offset + hvcC.headerSize, hvcC.size - hvcC.headerSize);
        }
        if (esds) {
          const asc = findEsdsAsc(bytes, esds);
          if (asc) { track.asc = asc; result.asc = asc; }
        }
      }
      if (stts) {
        const cnt = u32(bytes, stts.offset + 12);
        let ticks = 0;
        for (let i = 0; i < cnt && stts.offset + 16 + i * 8 + 8 <= stts.offset + stts.size; i++) {
          track.samples += u32(bytes, stts.offset + 16 + i * 8);
          ticks += u32(bytes, stts.offset + 16 + i * 8) * u32(bytes, stts.offset + 20 + i * 8);
        }
        if (track.timescale && ticks) track.fps = track.samples * track.timescale / ticks;
      } else if (stsz) {
        track.samples = u32(bytes, stsz.offset + 16);
      }
      if (stss) track.keyframes = u32(bytes, stss.offset + 12);
      result.tracks.push(track);
    });
    if (!moov) result.warnings.push('未找到 moov：可能是分片 MP4（fMP4），需要遍历 moof 才能得到完整轨道信息');
    if (result.tracks.length && !result.durationMs) {
      const t = result.tracks[0];
      if (t.timescale && t.duration) result.durationMs = t.duration * 1000 / t.timescale;
    }
    return result;
  }

  /* ---------- 3.2 MPEG-TS ---------- */

  var TS_STREAM_TYPES = {
    0x01: 'MPEG-1 视频', 0x02: 'MPEG-2 视频', 0x03: 'MPEG-1 音频', 0x04: 'MPEG-2 音频',
    0x05: '私有数据（字幕/表格）', 0x06: '私有数据（PS/AC-3 等）', 0x07: 'MHEG',
    0x0F: 'AAC（ADTS）', 0x10: 'MPEG-4 视频', 0x11: 'AAC（LATM）', 0x15: 'ID3 元数据',
    0x1B: 'H.264 / AVC', 0x24: 'H.265 / HEVC', 0x81: 'AC-3', 0x87: 'E-AC-3',
    0x86: 'SCTE-35 提示', 0x90: 'PS 私有流', 0x91: 'PS 私有流'
  };

  function tsSectionInfo(bytes, secStart, secEnd) {
    const tableId = bytes[secStart];
    const sectionLength = (u16(bytes, secStart + 1) & 0x0FFF);
    const secLen = Math.min(3 + sectionLength, secEnd - secStart, bytes.length - secStart);
    if (secLen < 8) return null;
    const crc = crc32Mpeg(bytes.subarray(secStart, secStart + secLen));
    const info = { tableId, length: secLen, crcOk: crc === 0 };
    if (tableId === 0x00) {
      info.type = 'PAT';
      info.tableIdExt = u16(bytes, secStart + 3);
      info.programs = [];
      for (let p = secStart + 8; p + 4 <= secStart + secLen - 4; p += 4) {
        const num = u16(bytes, p);
        if (num === 0) continue;
        info.programs.push({ program: num, pid: u16(bytes, p + 2) & 0x1FFF });
      }
    } else if (tableId === 0x02) {
      info.type = 'PMT';
      info.program = u16(bytes, secStart + 3);
      info.pcrPid = u16(bytes, secStart + 8) & 0x1FFF;
      const progInfoLen = u16(bytes, secStart + 10) & 0x0FFF;
      info.streams = [];
      let p = secStart + 12 + progInfoLen;
      const end = secStart + secLen - 4;
      while (p + 5 <= end) {
        const st = bytes[p];
        const pid = u16(bytes, p + 1) & 0x1FFF;
        const esLen = u16(bytes, p + 3) & 0x0FFF;
        info.streams.push({ streamType: st, pid, name: TS_STREAM_TYPES[st] || ('未知 0x' + st.toString(16)), esInfoLength: esLen });
        p += 5 + esLen;
      }
    } else {
      info.type = 'table 0x' + tableId.toString(16).padStart(2, '0');
    }
    return info;
  }

  function parseTs(bytes, syncOff) {
    const start = (syncOff !== undefined && syncOff >= 0) ? syncOff : findTsSync(bytes);
    const res = {
      kind: 'ts', syncOffset: start >= 0 ? start : 0, packetCount: 0,
      pids: [], pat: null, pmt: null, streams: [], pcr: [], ccErrors: 0, resyncs: 0,
      payloadBytes: 0, warnings: []
    };
    const pidMap = new Map();
    const pcrList = [];
    if (start < 0) { res.warnings.push('没有找到 188 字节对齐的 0x47 同步字节'); return res; }

    for (let pos = start; pos + 188 <= bytes.length; pos += 188) {
      if (bytes[pos] !== 0x47) { res.resyncs++; continue; }
      res.packetCount++;
      const b1 = bytes[pos + 1], b2 = bytes[pos + 2], b3 = bytes[pos + 3];
      const tei = !!(b1 & 0x80);
      const pusi = !!(b1 & 0x40);
      const pid = ((b1 & 0x1F) << 8) | b2;
      const scrambling = (b3 >> 6) & 3;
      const afc = (b3 >> 4) & 3;
      const cc = b3 & 15;
      let st = pidMap.get(pid);
      if (!st) {
        st = { pid, packets: 0, payloadBytes: 0, ccErrors: 0, lastCC: null, pcrCount: 0, pusiCount: 0 };
        pidMap.set(pid, st);
      }
      st.packets++;
      if (pusi) st.pusiCount++;

      let payloadStart = pos + 4;
      let afFlags = 0, discontinuity = false, pcrValue = null;
      if (afc & 2) {
        const afLen = bytes[pos + 4];
        if (afLen > 0 && pos + 5 < bytes.length) {
          afFlags = bytes[pos + 5];
          discontinuity = !!(afFlags & 0x80);
          if ((afFlags & 0x10) && afLen >= 7) {
            const base = (bytes[pos + 6] * 33554432 + bytes[pos + 7] * 131072 + bytes[pos + 8] * 512 + bytes[pos + 9] * 2 + ((bytes[pos + 10] & 0x80) >> 7));
            const ext = ((bytes[pos + 10] & 0x7F) << 8) | bytes[pos + 11];
            pcrValue = { pid, base, ext, ms: base / 90000 * 1000 + ext / 27000 };
            pcrList.push(pcrValue);
            st.pcrCount++;
          }
        }
        payloadStart = pos + 5 + bytes[pos + 4];
      }
      const hasPayload = (afc & 1) && payloadStart < pos + 188;
      if (hasPayload) {
        st.payloadBytes += Math.max(0, pos + 188 - payloadStart);
        res.payloadBytes += Math.max(0, pos + 188 - payloadStart);
        if (st.lastCC !== null && !discontinuity && cc !== ((st.lastCC + 1) & 15)) {
          st.ccErrors++; res.ccErrors++;
        }
        st.lastCC = cc;
      }
      if (tei) st.tei = true;
      if (scrambling) st.scrambled = scrambling;

      if (pusi && hasPayload && (pid === 0 || pid === (res.pmt && res.pmt.pid))) {
        const pointer = bytes[payloadStart];
        tsHandleSection(bytes, payloadStart + 1 + pointer, pos + 188, pid, res);
      }
      // PMT 的 PID 可能在解析 PAT 之后才知道，这里对未知 PID 也尝试解析 payload 中的 0x02 表
      if (pusi && hasPayload && pid !== 0 && (!res.pmt || pid !== res.pmt.pid)) {
        const pointer = bytes[payloadStart];
        const secStart = payloadStart + 1 + pointer;
        if (secStart + 8 <= pos + 188 && bytes[secStart] === 0x02 && (u16(bytes, secStart + 1) & 0xF000) === 0xB000) {
          tsHandleSection(bytes, secStart, pos + 188, pid, res);
        }
      }
    }
    res.pids = Array.from(pidMap.values()).sort((a, b) => b.packets - a.packets);
    res.pcr = pcrList.filter((p, i, arr) => i === 0 || p.ms !== arr[i - 1].ms);
    res.pcr = res.pcr.slice(0, 2000); // 预览限制
    if (res.pat) {
      res.streams = res.pmt ? res.pmt.streams : [];
    }
    return res;
  }

  function tsHandleSection(bytes, secStart, limitEnd, pid, res) {
    if (secStart + 8 > limitEnd || secStart + 8 > bytes.length) return;
    const tableId = bytes[secStart];
    if (tableId !== 0 && tableId !== 2) return;
    const info = tsSectionInfo(bytes, secStart, limitEnd);
    if (!info) return;
    if (info.type === 'PAT' && !res.pat) {
      res.pat = info;
      if (info.programs.length) {
        res.pmt = { pid: info.programs[0].pid, program: info.programs[0].program };
      }
    } else if (info.type === 'PMT' && !res.pmtStreams) {
      res.pmtStreams = true;
      info.pid = pid;
      res.pmt = info;
      res.streams = info.streams;
    }
  }

  /* ---------- 3.3 FLV ---------- */

  function amf0Value(bytes, off, depth) {
    if (depth > 8 || off >= bytes.length) return { value: null, off };
    const t = bytes[off++];
    if (t === 0x00) {
      const v = new DataView(bytes.buffer, bytes.byteOffset + off, 8).getFloat64(0, false);
      return { value: v, off: off + 8 };
    }
    if (t === 0x01) return { value: !!bytes[off], off: off + 1 };
    if (t === 0x02) { const len = u16(bytes, off); return { value: bstr(bytes, off + 2, len), off: off + 2 + len }; }
    if (t === 0x03 || t === 0x08) {
      let count = null;
      if (t === 0x08) { count = u32(bytes, off); off += 4; }
      const obj = {};
      let guard = 0;
      while (off + 2 <= bytes.length && guard++ < 2000) {
        const klen = u16(bytes, off);
        if (klen === 0 && bytes[off + 2] === 0x09) { off += 3; break; }
        const key = bstr(bytes, off + 2, klen);
        off += 2 + klen;
        const r = amf0Value(bytes, off, depth + 1);
        obj[key] = r.value;
        off = r.off;
      }
      return { value: obj, off };
    }
    if (t === 0x05 || t === 0x06) return { value: null, off };
    if (t === 0x0A) {
      const n = u32(bytes, off); off += 4;
      const arr = [];
      for (let i = 0; i < n; i++) { const r = amf0Value(bytes, off, depth + 1); arr.push(r.value); off = r.off; }
      return { value: arr, off };
    }
    if (t === 0x0B) { const d = new DataView(bytes.buffer, bytes.byteOffset + off, 10).getFloat64(0, false); return { value: new Date(d), off: off + 10 }; }
    return { value: null, off: bytes.length };
  }

  function parseFlv(bytes) {
    const res = {
      kind: 'flv', version: 0, flags: 0, dataOffset: 0, tags: [], meta: {},
      durationMs: 0, metadataTag: null, avcC: null, asc: null, sps: null, pps: null, warnings: []
    };
    if (bytes.length < 9) { res.warnings.push('FLV 头不完整'); return res; }
    res.version = bytes[3];
    res.flags = bytes[4];
    res.dataOffset = u32(bytes, 5);
    if (res.dataOffset < 9 || res.dataOffset > bytes.length) { res.warnings.push('dataOffset 异常'); return res; }
    let off = res.dataOffset + 4; // 跳过 PreviousTagSize0
    let guard = 0;
    while (off + 11 <= bytes.length && guard++ < 5000) {
      const type = bytes[off];
      const size = u24(bytes, off + 1);
      const ts = u24(bytes, off + 4) | ((bytes[off + 7] & 255) << 24);
      const streamId = u24(bytes, off + 8);
      let realSize = size;
      if (off + 11 + size > bytes.length) realSize = bytes.length - off - 11;
      const tag = {
        type, typeName: type === 8 ? '音频' : type === 9 ? '视频' : type === 18 ? '脚本数据' : '未知',
        offset: off, size, realSize, timestamp: ts, streamId, bodyOffset: off + 11
      };
      res.tags.push(tag);
      if (realSize > 0) {
        try {
          if (type === 9) {
            const b0 = bytes[off + 11], codecId = b0 & 0x0F, frameType = b0 >> 4;
            const avcPacketType = bytes[off + 12];
            tag.codecId = codecId;
            tag.avcPacketType = avcPacketType;
            if ((codecId === 7 || codecId === 12) && avcPacketType === 0 && realSize >= 5 + 7) {
              const cc = parseAvcC(bytes, off + 11 + 5);
              tag.avcC = cc;
              if (!res.avcC) {
                res.avcC = cc;
                if (cc.sps.length) { res.sps = cc.sps[0].bytes; res.pps = cc.pps.length ? cc.pps[0].bytes : null; }
              }
            }
          } else if (type === 8) {
            const b0 = bytes[off + 11];
            const soundFormat = b0 >> 4;
            tag.soundFormat = soundFormat;
            if (soundFormat === 10 && bytes[off + 12] === 0 && realSize >= 4) {
              const asc = bytes.slice(off + 13, off + 13 + Math.min(realSize - 2, 8));
              tag.asc = asc;
              if (!res.asc) res.asc = asc;
            }
          } else if (type === 18) {
            const r1 = amf0Value(bytes, off + 11, 0);
            let metaObj = null, metaName = '';
            if (typeof r1.value === 'string') {
              metaName = r1.value;
              const r2 = amf0Value(bytes, r1.off, 0);
              if (r2.value && typeof r2.value === 'object') metaObj = r2.value;
            } else if (r1.value && typeof r1.value === 'object') {
              metaObj = r1.value;
            }
            if (metaObj) {
              tag.amf = { name: metaName, data: metaObj };
              if (metaName === 'onMetaData') res.meta = metaObj;
            }
          }
        } catch (e) { tag.error = true; }
      }
      if (res.meta && res.meta.duration) res.durationMs = Number(res.meta.duration) * 1000;
      off += 11 + realSize;
      if (off + 4 <= bytes.length) off += 4; // PreviousTagSize
    }
    if (res.meta && res.meta.width) res.width = res.meta.width;
    if (res.meta && res.meta.height) res.height = res.meta.height;
    if (res.meta && res.meta.framerate) res.fps = res.meta.framerate;
    if (!res.durationMs && res.tags.length) {
      res.durationMs = res.tags[res.tags.length - 1].timestamp;
    }
    return res;
  }

  /* ---------- 3.4 Matroska / WebM（EBML） ---------- */

  var EBML_MASTER = {
    0x1A45DFA3: 1, 0x18538067: 1, 0x114D9B74: 1, 0x1549A966: 1, 0x1654AE6B: 1,
    0xAE: 1, 0xE0: 1, 0xE1: 1, 0x1F43B675: 1, 0xA0: 1, 0xE2: 1, 0x1254C367: 1
  };
  var EBML_NAMES = {
    0x1A45DFA3: 'EBML 头', 0x18538067: 'Segment', 0x114D9B74: 'SeekHead',
    0x1549A966: 'Info', 0x2AD7B1: 'TimestampScale', 0x4489: 'Duration',
    0x4D80: 'MuxingApp', 0x5741: 'WritingApp', 0x1654AE6B: 'Tracks',
    0xAE: 'TrackEntry', 0xD7: 'TrackNumber', 0x73C5: 'TrackUID', 0x83: 'TrackType',
    0x86: 'CodecID', 0x63A2: 'CodecPrivate', 0xE0: 'Video', 0xB0: 'PixelWidth', 0xBA: 'PixelHeight',
    0xE1: 'Audio', 0xB5: 'SamplingFrequency', 0x9F: 'Channels',
    0x4282: 'DocType', 0x4286: 'EBMLVersion', 0x4287: 'DocTypeVersion',
    0x1F43B675: 'Cluster', 0xA0: 'BlockGroup', 0xA1: 'Block'
  };

  function ebmlVint(bytes, off, keepMarker) {
    if (off >= bytes.length || bytes[off] === 0) return null;
    let len = 1, mask = 0x80;
    while (len <= 8 && !(bytes[off] & mask)) { mask >>= 1; len++; }
    if (len > 8) return null;
    let value = keepMarker ? bytes[off] : (bytes[off] & (mask - 1));
    let allOnes = (bytes[off] & (mask - 1)) === (mask - 1);
    for (let i = 1; i < len; i++) {
      if (off + i >= bytes.length) return null;
      const v = bytes[off + i];
      value = value * 256 + v;
      if (v !== 255) allOnes = false;
    }
    return { len, value, unknown: !keepMarker && allOnes };
  }

  function ebmlWalk(bytes, start, end, depth, out, parent) {
    let off = start, guard = 0;
    while (off < end && guard++ < 20000) {
      const id = ebmlVint(bytes, off, true);
      if (!id) break;
      const size = ebmlVint(bytes, off + id.len, false);
      if (!size) break;
      const dataStart = off + id.len + size.len;
      const dataEnd = size.unknown ? end : Math.min(dataStart + size.value, end, bytes.length);
      const node = {
        id: id.value, name: EBML_NAMES[id.value] || ('元素 0x' + id.value.toString(16)), offset: off,
        dataStart, size: size.unknown ? dataEnd - dataStart : size.value, depth, children: [], value: null
      };
      if (EBML_MASTER[id.value] && dataStart < dataEnd) {
        ebmlWalk(bytes, dataStart, dataEnd, depth + 1, out, node);
      } else if (dataStart < dataEnd) {
        node.value = ebmlReadValue(bytes, node);
      }
      if (parent) parent.children.push(node);
      out.push(node);
      if (dataEnd <= off) break;
      off = dataEnd;
    }
  }

  function ebmlReadValue(bytes, n) {
    const s = n.dataStart, len = n.size;
    try {
      if (n.id === 0x4489 || n.id === 0xB5) {
        if (len === 4) return new DataView(bytes.buffer, bytes.byteOffset + s, 4).getFloat32(0, false);
        if (len === 8) return new DataView(bytes.buffer, bytes.byteOffset + s, 8).getFloat64(0, false);
      }
      if (n.id === 0x2AD7B1 || n.id === 0xB0 || n.id === 0xBA || n.id === 0x9F || n.id === 0xD7 || n.id === 0x83) {
        let v = 0;
        for (let i = 0; i < Math.min(len, 8); i++) v = v * 256 + bytes[s + i];
        return v;
      }
      if (n.id === 0x86 || n.id === 0x4282 || n.id === 0x4D80 || n.id === 0x5741) {
        return bstr(bytes, s, Math.min(len, 80));
      }
    } catch (e) { return null; }
    return len <= 4 ? hexStr(bytes, s, len) : hexStr(bytes, s, 4) + ' …';
  }

  function ebmlChild(node, id) {
    if (!node) return null;
    return node.children.find(c => c.id === id) || null;
  }
  function ebmlFind(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children) { const r = ebmlFind(c, id); if (r) return r; }
    return null;
  }
  function ebmlFindAll(node, id, out) {
    const list = out || [];
    if (!node) return list;
    if (node.id === id) list.push(node);
    node.children.forEach(c => ebmlFindAll(c, id, list));
    return list;
  }

  function parseMkv(bytes) {
    const flat = [], roots = [];
    ebmlWalk(bytes, 0, bytes.length, 0, flat, null);
    flat.forEach(n => { if (n.depth === 0) roots.push(n); });
    const res = {
      kind: 'mkv', tree: roots, flat, docType: '', durationMs: 0, timestampScale: 1000000,
      tracks: [], avcC: null, sps: null, pps: null, warnings: []
    };
    const header = roots.find(n => n.id === 0x1A45DFA3);
    if (header) {
      const dt = ebmlFind(header, 0x4282);
      if (dt) res.docType = String(dt.value);
    }
    const seg = roots.find(n => n.id === 0x18538067);
    const info = ebmlFind(seg, 0x1549A966);
    if (info) {
      const scale = ebmlChild(info, 0x2AD7B1);
      if (scale && typeof scale.value === 'number') res.timestampScale = scale.value;
      const dur = ebmlChild(info, 0x4489);
      if (dur && typeof dur.value === 'number') res.durationMs = dur.value * res.timestampScale / 1e6;
    }
    const tracksNode = ebmlFind(seg, 0x1654AE6B);
    if (tracksNode) {
      ebmlFindAll(tracksNode, 0xAE).forEach((te, idx) => {
        const t = { index: idx + 1, number: 0, type: 0, typeName: '', codec: '', width: 0, height: 0, sampleRate: 0, channels: 0 };
        const num = ebmlChild(te, 0xD7), type = ebmlChild(te, 0x83), codec = ebmlChild(te, 0x86);
        if (num) t.number = num.value;
        if (type) { t.type = type.value; t.typeName = type.value === 1 ? '视频' : type.value === 2 ? '音频' : type.value === 17 ? '字幕' : '类型 ' + type.value; }
        if (codec) t.codec = String(codec.value);
        const video = ebmlChild(te, 0xE0);
        if (video) {
          const w = ebmlChild(video, 0xB0), h = ebmlChild(video, 0xBA);
          if (w) t.width = w.value; if (h) t.height = h.value;
        }
        const audio = ebmlChild(te, 0xE1);
        if (audio) {
          const f = ebmlChild(audio, 0xB5), c = ebmlChild(audio, 0x9F);
          if (f) t.sampleRate = f.value; if (c) t.channels = c.value;
        }
        const priv = ebmlChild(te, 0x63A2);
        if (priv && priv.size > 5) {
          const raw = bytes.slice(priv.dataStart, priv.dataStart + Math.min(priv.size, 80));
          if (raw[0] === 1 && !res.avcC) {
            const cc = parseAvcC(raw, 0);
            t.avcC = cc; res.avcC = cc;
            if (cc.sps.length) { res.sps = cc.sps[0].bytes; res.pps = cc.pps.length ? cc.pps[0].bytes : null; }
          }
        }
        res.tracks.push(t);
      });
    }
    if (!res.docType) res.warnings.push('未读到 DocType，可能是未知 EBML 变体');
    return res;
  }

  /* ---------- 3.5 WAV / AVI / Ogg / MP3 ---------- */

  function riffChunks(bytes, start, end, depth) {
    const list = [];
    let off = start, guard = 0;
    while (off + 8 <= end && guard++ < 2000) {
      const id = bstr(bytes, off, 4);
      const size = u32(bytes, off + 4);
      const realSize = Math.min(size, end - off - 8);
      const node = { id, offset: off, size, realSize, depth, children: [] };
      if (id === 'LIST' && realSize >= 4) {
        node.listType = bstr(bytes, off + 8, 4);
        node.children = riffChunks(bytes, off + 12, off + 8 + realSize, depth + 1);
      }
      list.push(node);
      off += 8 + size + (size & 1);
    }
    return list;
  }

  function parseRiff(bytes) {
    const form = bstr(bytes, 8, 4);
    const chunks = riffChunks(bytes, 12, bytes.length, 0);
    const res = { kind: 'riff', form, chunks, warnings: [] };
    if (form === 'WAVE') {
      res.kind = 'wav';
      const fmt = chunks.find(c => c.id === 'fmt ');
      const data = chunks.find(c => c.id === 'data');
      if (fmt) {
        const o = fmt.offset + 8;
        res.audioFormat = u16(bytes, o);
        res.channels = u16(bytes, o + 2);
        res.sampleRate = u32(bytes, o + 4);
        res.byteRate = u32(bytes, o + 8);
        res.blockAlign = u16(bytes, o + 12);
        res.bitsPerSample = u16(bytes, o + 14);
        res.formatName = res.audioFormat === 1 ? 'PCM' : res.audioFormat === 3 ? 'IEEE float' : res.audioFormat === 0xFFFE ? 'WAVE_FORMAT_EXTENSIBLE' : '格式 0x' + res.audioFormat.toString(16);
      }
      if (data) res.dataSize = data.size;
      if (data && res.byteRate) res.durationMs = data.size / res.byteRate * 1000;
      if (!fmt) res.warnings.push('缺少 fmt 块');
    } else if (form === 'AVI ') {
      res.kind = 'avi';
      res.warnings.push('AVI 仅做格式识别与顶层 chunk 展示，不深入 idx1/movi');
    }
    return res;
  }

  function parseOgg(bytes) {
    const res = { kind: 'ogg', pages: 0, serials: [], version: 0, firstGranule: null, warnings: [] };
    let off = 0, guard = 0;
    while (off + 27 <= bytes.length && guard++ < 500) {
      if (bstr(bytes, off, 4) !== 'OggS') { off++; continue; }
      res.version = bytes[off + 4];
      const headerType = bytes[off + 5];
      const granule = u64(bytes, off + 6);
      const serial = u32(bytes, off + 14);
      const segs = bytes[off + 26];
      if (off + 27 + segs > bytes.length) break;
      let bodyLen = 0;
      for (let i = 0; i < segs; i++) bodyLen += bytes[off + 27 + i];
      if (res.firstGranule === null) { res.firstGranule = granule; res.firstHeaderType = headerType; }
      if (res.serials.indexOf(serial) < 0) res.serials.push(serial);
      res.pages++;
      off += 27 + segs + bodyLen;
    }
    if (!res.pages) res.warnings.push('没有解析到完整 Ogg 页');
    return res;
  }

  function parseMp3(bytes) {
    const res = { kind: 'mp3', id3: null, sampleRate: 0, version: '', layer: 0, bitrate: 0, frameCount: 0, warnings: [] };
    let off = 0;
    if (bstr(bytes, 0, 3) === 'ID3' && bytes.length >= 10) {
      const size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) | ((bytes[8] & 0x7F) << 7) | (bytes[9] & 0x7F);
      res.id3 = { version: bytes[3], flags: bytes[5], size };
      off = 10 + size;
    }
    // 找帧同步
    let p = off;
    while (p + 4 < bytes.length && !((bytes[p] & 0xFF) === 0xFF && (bytes[p + 1] & 0xE0) === 0xE0)) p++;
    res.firstFrameOffset = p;
    if (p + 4 < bytes.length) {
      const b1 = bytes[p + 1], b2 = bytes[p + 2];
      const verBits = (b1 >> 3) & 3;
      res.version = verBits === 3 ? 'MPEG-1' : verBits === 2 ? 'MPEG-2' : verBits === 0 ? 'MPEG-2.5' : '保留';
      res.layer = 4 - ((b1 >> 1) & 3);
      const brIndex = (b2 >> 4) & 15;
      const srIndex = (b2 >> 2) & 3;
      const srTable = [44100, 48000, 32000, 0];
      res.sampleRate = srTable[srIndex];
      if (res.version === 'MPEG-2') res.sampleRate /= 2;
      if (res.version === 'MPEG-2.5') res.sampleRate /= 4;
      const brTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
      res.bitrate = brTable[brIndex] || 0;
      res.frameCount = Math.max(0, Math.floor((bytes.length - p) / 417));
    }
    return res;
  }

  /* ================= 四、码流解析 ================= */

  function BitReader(bytes) {
    this.b = removeEmulationPrevention(bytes);
    this.pos = 0;
  }
  BitReader.prototype.left = function () { return this.b.length * 8 - this.pos; };
  BitReader.prototype.bit = function () {
    const byte = Math.floor(this.pos / 8);
    const bit = 7 - (this.pos % 8);
    this.pos++;
    if (byte >= this.b.length) return 0;
    return (this.b[byte] >> bit) & 1;
  };
  BitReader.prototype.bits = function (n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  };
  BitReader.prototype.ue = function () {
    let zeros = 0;
    while (zeros < 32 && this.bit() === 0) zeros++;
    if (zeros >= 32) return 0;
    return Math.pow(2, zeros) - 1 + this.bits(zeros);
  };
  BitReader.prototype.se = function () {
    const v = this.ue();
    return (v & 1) ? Math.ceil(v / 2) : -v / 2;
  };

  function skipScalingList(br, size) {
    let last = 8, next = 8;
    for (let i = 0; i < size && br.left() > 0; i++) {
      if (next !== 0) {
        const delta = br.se();
        next = (last + delta + 256) % 256;
      }
      if (next !== 0) last = next;
    }
  }

  /* 4.1 H.264 SPS（Exp-Golomb） */
  function parseSps(input) {
    const br = new BitReader(input);
    const f = {
      profileIdc: br.bits(8), constraintFlags: br.bits(8), levelIdc: br.bits(8),
      spsId: br.ue(), chromaFormatIdc: 1, separateColourPlane: false,
      bitDepthLuma: 8, bitDepthChroma: 8, log2MaxFrameNum: 4, picOrderCntType: 0,
      log2MaxPocLsb: 4, maxNumRefFrames: 0, frameMbsOnly: true, widthMbs: 0,
      heightMapUnits: 0, crop: [0, 0, 0, 0], width: 0, height: 0,
      vui: null, fps: 0, timing: null, warning: ''
    };
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(f.profileIdc) >= 0) {
      f.chromaFormatIdc = br.ue();
      if (f.chromaFormatIdc === 3) f.separateColourPlane = !!br.bit();
      f.bitDepthLuma = br.ue() + 8;
      f.bitDepthChroma = br.ue() + 8;
      br.bit(); // qpprime_y_zero_transform_bypass_flag
      if (br.bit()) {
        const lists = f.chromaFormatIdc === 3 ? 12 : 8;
        for (let i = 0; i < lists && br.left() > 0; i++) {
          if (br.bit()) skipScalingList(br, i < 6 ? 16 : 64);
        }
      }
    }
    f.log2MaxFrameNum = br.ue() + 4;
    f.picOrderCntType = br.ue();
    if (f.picOrderCntType === 0) {
      f.log2MaxPocLsb = br.ue() + 4;
    } else if (f.picOrderCntType === 1) {
      br.bit(); // delta_pic_order_always_zero_flag
      br.se();  // offset_for_non_ref_pic
      br.se();  // offset_for_top_to_bottom_field
      const n = br.ue();
      for (let i = 0; i < n && i < 256 && br.left() > 0; i++) br.se();
    }
    f.maxNumRefFrames = br.ue();
    br.bit(); // gaps_in_frame_num_value_allowed_flag
    f.widthMbs = br.ue() + 1;
    f.heightMapUnits = br.ue() + 1;
    f.frameMbsOnly = !!br.bit();
    if (!f.frameMbsOnly) br.bit(); // mb_adaptive_frame_field_flag
    br.bit(); // direct_8x8_inference_flag
    if (br.bit()) { // frame_cropping_flag
      f.crop = [br.ue(), br.ue(), br.ue(), br.ue()];
    }
    if (br.bit()) { // vui_parameters_present_flag
      f.vui = true;
      const vui = {};
      if (br.bit()) { // aspect_ratio_info_present_flag
        vui.aspectRatioIdc = br.bits(8);
        if (vui.aspectRatioIdc === 255) { vui.sarWidth = br.bits(16); vui.sarHeight = br.bits(16); }
      }
      if (br.bit()) vui.overscan = br.bit(); // overscan_info_present / appropriate
      if (br.bit()) { // video_signal_type_present_flag
        vui.videoFormat = br.bits(3);
        vui.fullRange = br.bit();
        if (br.bit()) { // colour_description_present_flag
          vui.colourPrimaries = br.bits(8);
          vui.transferCharacteristics = br.bits(8);
          vui.matrixCoefficients = br.bits(8);
        }
      }
      if (br.bit()) { br.ue(); br.ue(); } // chroma_loc_info
      if (br.bit()) { // timing_info_present_flag
        vui.numUnitsInTick = br.bits(32);
        vui.timeScale = br.bits(32);
        vui.fixedFrameRate = br.bit();
        f.timing = { numUnitsInTick: vui.numUnitsInTick, timeScale: vui.timeScale, fixedFrameRate: !!vui.fixedFrameRate };
        if (vui.numUnitsInTick > 0) f.fps = vui.timeScale / (2 * vui.numUnitsInTick);
      }
      f.vuiFields = vui;
    }
    const subWidthC = (f.chromaFormatIdc === 1 || f.chromaFormatIdc === 2) ? 2 : 1;
    const subHeightC = f.chromaFormatIdc === 1 ? 2 : 1;
    const cropUnitX = subWidthC;
    const cropUnitY = subHeightC * (2 - (f.frameMbsOnly ? 1 : 0));
    f.width = f.widthMbs * 16 - (f.crop[0] + f.crop[1]) * cropUnitX;
    f.height = (2 - (f.frameMbsOnly ? 1 : 0)) * f.heightMapUnits * 16 - (f.crop[2] + f.crop[3]) * cropUnitY;
    if (f.width <= 0 || f.height <= 0) f.warning = '解析出的宽高异常，SPS 可能被截断或并非 H.264';
    f.rawHex = hexStr(input, 0, Math.min(input.length, 64));
    return f;
  }

  /* 4.2 AVCDecoderConfigurationRecord（avcC） */
  function parseAvcC(bytes, offset) {
    const o = offset || 0;
    const res = {
      version: 0, profile: 0, compatibility: 0, level: 0, lengthSize: 4,
      sps: [], pps: [], raw: null
    };
    if (o + 7 > bytes.length) return res;
    res.version = bytes[o];
    res.profile = bytes[o + 1];
    res.compatibility = bytes[o + 2];
    res.level = bytes[o + 3];
    res.lengthSize = (bytes[o + 4] & 3) + 1;
    const numSps = bytes[o + 5] & 0x1F;
    let p = o + 6;
    for (let i = 0; i < numSps && p + 2 <= bytes.length; i++) {
      const len = u16(bytes, p); p += 2;
      if (p + len > bytes.length) break;
      res.sps.push({ length: len, bytes: bytes.slice(p, p + len) });
      p += len;
    }
    if (p < bytes.length) {
      const numPps = bytes[p] & 0xFF; p++;
      for (let i = 0; i < numPps && p + 2 <= bytes.length; i++) {
        const len = u16(bytes, p); p += 2;
        if (p + len > bytes.length) break;
        res.pps.push({ length: len, bytes: bytes.slice(p, p + len) });
        p += len;
      }
    }
    res.raw = bytes.slice(o, Math.min(bytes.length, o + 52));
    return res;
  }

  /* 4.3 Annex B 扫描：找 SPS/PPS/IDR */
  function parseAnnexB(bytes) {
    const nals = [];
    let i = 0;
    while (i + 3 < bytes.length) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) {
        const scLen = bytes[i + 2] === 1 ? 3 : 4;
        const start = i + scLen;
        let j = start;
        while (j + 3 < bytes.length) {
          if (bytes[j] === 0 && bytes[j + 1] === 0 && (bytes[j + 2] === 1 || (bytes[j + 2] === 0 && bytes[j + 3] === 1))) break;
          j++;
        }
        if (j > start) {
          const nal = bytes.slice(start, j);
          const type = nal[0] & 0x1F;
          nals.push({ type, name: nalName(type), bytes: nal });
        }
        i = j;
      } else {
        i++;
      }
    }
    if (!nals.length && bytes.length > 1) {
      // 也可能直接是单个 NAL（例如裸 SPS）
      const type = bytes[0] & 0x1F;
      nals.push({ type, name: nalName(type), bytes });
    }
    return nals;
  }
  function nalName(t) {
    return { 1: '非 IDR 片', 5: 'IDR 片', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD' }[t] || ('NAL ' + t);
  }

  /* 4.4 HEVC 的 hvcC（只解配置记录，不深入 SPS 语法） */
  function parseHvcC(bytes, offset, length) {
    const o = offset || 0;
    const end = Math.min(bytes.length, o + (length || bytes.length - o));
    const res = { version: 0, profileSpace: 0, tier: 0, profileIdc: 0, levelIdc: 0, lengthSize: 4, arrays: [], spsCount: 0, raw: null };
    if (o + 23 > end) return res;
    res.version = bytes[o];
    res.profileSpace = (bytes[o + 1] >> 6) & 3;
    res.tier = (bytes[o + 1] >> 5) & 1;
    res.profileIdc = bytes[o + 1] & 0x1F;
    res.levelIdc = bytes[o + 12];
    res.lengthSize = (bytes[o + 21] & 3) + 1;
    const numArrays = bytes[o + 22];
    let p = o + 23;
    for (let i = 0; i < numArrays && p + 3 <= end; i++) {
      const nalType = bytes[p] & 0x3F;
      const count = u16(bytes, p + 1);
      p += 3;
      const units = [];
      for (let k = 0; k < count && p + 2 <= end; k++) {
        const len = u16(bytes, p); p += 2;
        if (p + len > end) break;
        units.push({ length: len, bytes: bytes.slice(p, p + len) });
        p += len;
      }
      res.arrays.push({ nalType, count, units });
      if (nalType === 33) res.spsCount += units.length;
    }
    res.raw = bytes.slice(o, Math.min(end, o + 48));
    return res;
  }

  /* 4.5 AAC AudioSpecificConfig */
  var AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0];
  var AAC_OBJECT_TYPES = { 1: 'AAC Main', 2: 'AAC LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'SBR', 6: 'AAC Scalable', 7: 'TwinVQ', 17: 'ER AAC LC', 19: 'ER AAC LTP', 20: 'ER AAC Scalable', 22: 'ER BSAC', 23: 'ER AAC LD', 29: 'PS' };

  function parseAacAsc(bytes) {
    const br = new BitReader(bytes);
    const res = {
      audioObjectType: 0, objectName: '', samplingFrequencyIndex: 0, sampleRate: 0,
      channelConfiguration: 0, channels: 0, sbr: false, ps: false, extension: '', rawHex: hexStr(bytes, 0, Math.min(bytes.length, 16))
    };
    let aot = br.bits(5);
    if (aot === 31) aot = 32 + br.bits(6);
    res.audioObjectType = aot;
    res.objectName = AAC_OBJECT_TYPES[aot] || ('AOT ' + aot);
    let freqIndex = br.bits(4);
    let sampleRate = AAC_SAMPLE_RATES[freqIndex];
    if (freqIndex === 15) sampleRate = br.bits(24);
    res.samplingFrequencyIndex = freqIndex;
    res.sampleRate = sampleRate;
    let channelConfig = br.bits(4);
    res.channelConfiguration = channelConfig;
    res.channels = channelConfig === 7 ? 8 : channelConfig;
    if (aot === 5 || aot === 29) {
      // 显式 SBR / PS：先读扩展采样率，再读真正的核心 AOT
      res.sbr = true;
      if (aot === 29) res.ps = true;
      const extIndex = br.bits(4);
      if (extIndex === 15) br.bits(24);
      const coreAot = br.bits(5);
      res.extension = '显式 ' + (aot === 29 ? 'PS' : 'SBR') + '，核心 AOT=' + coreAot;
      aot = coreAot;
    } else if ([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].indexOf(aot) >= 0) {
      br.bit(); // frameLengthFlag
      if (br.bit()) { br.bits(14); } // dependsOnCoreCoder + coreCoderDelay
      const extFlag = br.bit();
      if (aot === 6 || aot === 20) {
        if (br.bits(3) > 0) res.extension += '分层 AOT ' + aot + '；';
      }
      if (extFlag) res.extension += '存在扩展音频对象；';
    }
    // 同步扩展 0x2B7（11 位）之后是扩展 AOT
    if (br.left() >= 16) {
      const save = br.pos;
      const sync = br.bits(11);
      if (sync === 0x2B7) {
        const extAot = br.bits(5);
        if (extAot === 5 || extAot === 29) {
          res.sbr = true;
          if (extAot === 29) res.ps = true;
          const idx = br.bits(4);
          res.extension += '同步扩展：' + (extAot === 29 ? 'PS' : 'SBR') + '，采样率索引 ' + idx + '；';
        }
      } else {
        br.pos = save;
      }
    }
    res.coreObjectType = aot;
    return res;
  }

  /* ================= 五、协议解析 ================= */

  var RTCP_NAMES = { 200: 'SR 发送者报告', 201: 'RR 接收者报告', 202: 'SDES 源描述', 203: 'BYE 结束', 204: 'APP 应用自定义', 205: 'RTPFB 传输层反馈', 206: 'PSFB 载荷层反馈' };

  function parseRtpPacket(bytes) {
    const version = bytes[0] >> 6;
    const padding = !!(bytes[0] & 0x20);
    const extension = !!(bytes[0] & 0x10);
    const csrcCount = bytes[0] & 0x0F;
    const marker = !!(bytes[1] & 0x80);
    const pt = bytes[1] & 0x7F;
    const seq = u16(bytes, 2);
    const timestamp = u32(bytes, 4);
    const ssrc = u32(bytes, 8);
    const csrc = [];
    for (let i = 0; i < csrcCount && 12 + i * 4 + 4 <= bytes.length; i++) csrc.push(u32(bytes, 12 + i * 4));
    let offset = 12 + csrcCount * 4;
    let ext = null;
    if (extension && offset + 4 <= bytes.length) {
      ext = { profile: u16(bytes, offset), words: u16(bytes, offset + 2), length: u16(bytes, offset + 2) * 4 };
      offset += 4 + ext.length;
    }
    const paddingBytes = (padding && bytes.length) ? bytes[bytes.length - 1] : 0;
    let payloadLen = Math.max(0, bytes.length - offset);
    if (padding && paddingBytes <= payloadLen) payloadLen -= paddingBytes;
    const payload = bytes.slice(offset, offset + payloadLen);
    return {
      kind: 'rtp', firstByte: bytes[0], secondByte: bytes[1],
      version, padding, extension, csrcCount, marker, pt, seq, timestamp, ssrc, csrc,
      extensionHeader: ext, payloadOffset: offset, payloadLength: payloadLen, paddingBytes,
      payload, payloadHex: hexStr(payload, 0, Math.min(32, payload.length)),
      clockRate: pt >= 96 ? '动态 PT（需 SDP 确定时钟）' : (pt === 8 ? 90000 : pt === 0 ? 8000 : '见 RFC 3551'),
      warnings: version !== 2 ? ['版本号不是 2，可能不是 RTP'] : []
    };
  }

  function parseRtcpPacket(bytes) {
    const version = bytes[0] >> 6;
    const reportCount = bytes[0] & 0x1F;
    const pt = bytes[1] & 0xFF;
    const lengthWords = u16(bytes, 2);
    const declaredBytes = (lengthWords + 1) * 4;
    const res = {
      kind: 'rtcp', version, pt, name: RTCP_NAMES[pt] || ('类型 ' + pt), reportCount,
      lengthWords, declaredBytes, padding: !!(bytes[0] & 0x20), ssrc: bytes.length >= 8 ? u32(bytes, 4) : 0,
      warnings: []
    };
    res.truncated = declaredBytes > bytes.length;
    if (pt === 200 && bytes.length >= 28) {
      res.senderInfo = {
        ntpMsw: u32(bytes, 8), ntpLsw: u32(bytes, 12),
        rtpTimestamp: u32(bytes, 16), packetCount: u32(bytes, 20), octetCount: u32(bytes, 24)
      };
      res.reports = parseRtcpReports(bytes, 28, reportCount);
    } else if (pt === 201) {
      res.reports = parseRtcpReports(bytes, 8, reportCount);
    } else if (pt === 203) {
      res.byeSsrc = [];
      let p = 4;
      for (let i = 0; i < reportCount && p + 4 <= bytes.length; i++) { res.byeSsrc.push(u32(bytes, p)); p += 4; }
    }
    if (version !== 2) res.warnings.push('版本号不是 2，可能不是 RTCP');
    return res;
  }

  function parseRtcpReports(bytes, start, count) {
    const list = [];
    for (let i = 0; i < count && start + i * 24 + 24 <= bytes.length; i++) {
      const o = start + i * 24;
      list.push({
        ssrc: u32(bytes, o),
        fractionLost: bytes[o + 4],
        cumulativeLost: (bytes[o + 5] * 65536 + bytes[o + 6] * 256 + bytes[o + 7]),
        highestSeq: u32(bytes, o + 8),
        jitter: u32(bytes, o + 12),
        lastSr: u32(bytes, o + 16),
        delaySinceLastSr: u32(bytes, o + 20)
      });
    }
    return list;
  }

  function parseRtpRtcp(bytes) {
    if (!bytes || bytes.length < 4) return { kind: 'empty', warnings: ['数据太短'] };
    if ((bytes[0] >> 6) !== 2) {
      return { kind: 'unknown', warnings: ['版本位不是 2（0b10），不是 RTP/RTCP'], rawHex: hexStr(bytes, 0, Math.min(24, bytes.length)) };
    }
    const second = bytes[1];
    if (second >= 200 && second <= 206) return parseRtcpPacket(bytes);
    return parseRtpPacket(bytes);
  }

  var SIP_METHODS = ['REGISTER', 'INVITE', 'ACK', 'BYE', 'CANCEL', 'OPTIONS', 'SUBSCRIBE', 'NOTIFY', 'MESSAGE', 'INFO', 'PRACK', 'REFER', 'UPDATE', 'PUBLISH'];
  var RTSP_METHODS = ['OPTIONS', 'DESCRIBE', 'SETUP', 'PLAY', 'PAUSE', 'TEARDOWN', 'GET_PARAMETER', 'SET_PARAMETER', 'ANNOUNCE', 'RECORD', 'REDIRECT'];

  function parseTextMessage(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) return { kind: 'empty', warnings: ['没有内容'] };
    const startLine = lines[i].trim();
    const headers = [], headerMap = {};
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') { j++; break; }
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim(), v = line.slice(idx + 1).trim();
      headers.push({ name: k, value: v });
      const key = k.toLowerCase();
      if (!headerMap[key]) headerMap[key] = v;
    }
    const body = lines.slice(j).join('\n');
    const firstToken = startLine.split(' ')[0].toUpperCase();
    let kind;
    if (/^SIP\/2\.0/.test(startLine)) kind = 'sip';
    else if (/^(RTSP|RTSP\/2\.0)\/1\.0/.test(startLine)) kind = 'rtsp';
    else if (/^RTSP\/2\.0/.test(startLine)) kind = 'rtsp';
    else if (SIP_METHODS.indexOf(firstToken) >= 0 && RTSP_METHODS.indexOf(firstToken) < 0) kind = 'sip';
    else if (RTSP_METHODS.indexOf(firstToken) >= 0) {
      const transport = headerMap['transport'] || headerMap['session'] || '';
      kind = (firstToken === 'OPTIONS' && !transport && headerMap['via']) ? 'sip' : 'rtsp';
    } else kind = 'text';

    // 起始行拆解
    let method = '', uri = '', status = '';
    if (startLine.indexOf(' ') >= 0) {
      const parts = startLine.split(/\s+/);
      if (/^\d{3}$/.test(parts[1])) { method = parts[0]; status = parts[1]; uri = parts.slice(2).join(' '); }
      else { method = parts[0]; uri = parts.slice(1).join(' '); }
    }
    const res = {
      kind, startLine, method, uri, status, headers, headerMap, body,
      messageType: status ? '响应' : '请求'
    };
    if (body && (body.indexOf('v=0') >= 0 || /application\/sdp/i.test(headerMap['content-type'] || ''))) {
      res.sdp = parseSdp(body);
    }
    return res;
  }

  function parseSdp(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '');
    const session = { attrs: [], phone: [], email: [] };
    const media = [];
    let cur = null;
    const base = {};
    lines.forEach(line => {
      const idx = line.indexOf('=');
      if (idx < 0) return;
      const t = line.slice(0, idx), v = line.slice(idx + 1);
      if (t === 'm') {
        const parts = v.split(/\s+/);
        cur = { media: parts[0], port: parts[1], proto: parts[2], formats: parts.slice(3), attrs: [], rtpmap: {}, fmtp: {}, setup: '', control: '', y: '' };
        media.push(cur);
        return;
      }
      if (t === 'a' && cur) {
        cur.attrs.push(v);
        if (v.indexOf('rtpmap:') === 0) {
          const m = v.slice(7).match(/(\d+)\s+(.+?)\/(\d+)(?:\/(\d+))?/);
          if (m) cur.rtpmap[m[1]] = { encoding: m[2], clock: m[3], channels: m[4] ? Number(m[4]) : 1 };
        } else if (v.indexOf('fmtp:') === 0) {
          const m = v.slice(5).match(/(\d+)\s+(.*)/);
          if (m) cur.fmtp[m[1]] = m[2];
        } else if (v.indexOf('setup:') === 0) {
          cur.setup = v.slice(6);
        } else if (v.indexOf('control:') === 0) {
          cur.control = v.slice(8);
        } else if (v.indexOf('ssrc:') === 0) {
          cur.ssrc = v.slice(5);
        }
      } else if (cur) {
        if (t === 'y') cur.y = v;
      } else {
        if (t === 'y') session.y = v;
        if (t === 'a') session.attrs.push(v);
        if (t === 'o') session.origin = v;
        if (t === 's') session.name = v;
        if (t === 't') session.time = v;
        if (t === 'c') session.connection = v;
        if (t === 'y') session.y = v;
        base[t] = v;
      }
    });
    return { session, media, lines, raw: base };
  }

  /* ================= 六、页面渲染与交互 ================= */

  function $(sel, rootEl) { return (rootEl || document).querySelector(sel); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function statCards(items) {
    return '<div class="ana-stats">' + items.map(it =>
      `<div class="ana-stat"><span class="ana-stat-l">${esc(it[0])}</span><span class="ana-stat-v">${esc(it[1])}</span>${it[2] ? `<span class="ana-stat-n">${esc(it[2])}</span>` : ''}</div>`
    ).join('') + '</div>';
  }
  function simpleTable(head, rows) {
    return '<div class="scroll-x"><table class="cmp ana-table"><thead><tr>' +
      head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => '<td>' + (c && c.html ? c.html : esc(c)) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }
  function warningsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="ana-warn">' + list.map(w => '<div>⚠️ ' + esc(w) + '</div>').join('') + '</div>';
  }

  /* 6.1 hex dump（带字段高亮，最多 512 字节） */
  function hexTable(bytes, base, count, fields) {
    const n = Math.min(count, 512, bytes.length - base);
    const fl = fields || [];
    const fieldAt = rel => {
      for (let i = 0; i < fl.length; i++) {
        const f = fl[i];
        if (rel >= f.s && rel < f.e) return i;
      }
      return -1;
    };
    let rows = '';
    for (let i = 0; i < n; i += 16) {
      let cells = '', ascii = '';
      for (let k = i; k < Math.min(i + 16, n); k++) {
        const fi = fieldAt(k);
        const v = bytes[base + k] & 255;
        cells += `<span class="ana-hx ${fi >= 0 ? 'f' + (fi % 8) : ''}">${pad2(v.toString(16))}</span>`;
        ascii += (v >= 32 && v < 127) ? (String.fromCharCode(v).replace(/</g, '&lt;').replace(/>/g, '&gt;')) : '·';
      }
      rows += `<div class="ana-hexrow"><span class="ana-off">${(base + i).toString(16).padStart(4, '0')}</span><span class="ana-hexbytes">${cells}</span><span class="ana-ascii">${ascii}</span></div>`;
    }
    const legend = fl.map((f, i) => `<span class="ana-lg"><i class="ana-dot f${i % 8}"></i>${esc(f.name)}</span>`).join('');
    return `<div class="ana-hex"><div class="ana-hexbar">偏移 ${base.toString(16)} · 展示 ${n} 字节${n < count ? '（截断到 512）' : ''}</div><div class="ana-hexrows">${rows}</div><div class="ana-legend">${legend}</div></div>`;
  }

  function mp4HexFields(node, bytes) {
    const f = [{ s: 0, e: node.headerSize || 8, name: 'size + type' }];
    const o = node.offset, rel = a => a - o;
    const n = node.type;
    try {
      if (n === 'ftyp') f.push({ s: rel(o + 8), e: rel(o + 12), name: 'major_brand' });
      if (n === 'mvhd') {
        const v = bytes[o + 8];
        f.push({ s: rel(o + 8), e: rel(o + 12), name: 'version/flags' });
        if (v === 1) {
          f.push({ s: rel(o + 28), e: rel(o + 32), name: 'timescale' });
          f.push({ s: rel(o + 32), e: rel(o + 40), name: 'duration' });
        } else {
          f.push({ s: rel(o + 20), e: rel(o + 24), name: 'timescale' });
          f.push({ s: rel(o + 24), e: rel(o + 28), name: 'duration' });
        }
      }
      if (n === 'tkhd') {
        const v = bytes[o + 8];
        f.push({ s: rel(o + 8), e: rel(o + 12), name: 'version/flags' });
        f.push({ s: rel(o + (v === 1 ? 28 : 20)), e: rel(o + (v === 1 ? 32 : 24)), name: 'track_id' });
        f.push({ s: rel(o + node.size - 8), e: rel(o + node.size - 4), name: 'width 16.16' });
        f.push({ s: rel(o + node.size - 4), e: rel(o + node.size), name: 'height 16.16' });
      }
      if (n === 'mdhd') {
        const v = bytes[o + 8];
        f.push({ s: rel(o + (v === 1 ? 28 : 20)), e: rel(o + (v === 1 ? 32 : 24)), name: 'timescale' });
      }
      if (n === 'stsz' || n === 'stco' || n === 'stss') f.push({ s: rel(o + 12), e: rel(o + 16), name: 'entry_count / sample_size' });
      if (n === 'stts') f.push({ s: rel(o + 12), e: rel(o + 16), name: 'entry_count' });
      if (n === 'avcC') {
        f.push({ s: rel(o + 8), e: rel(o + 9), name: 'version' });
        f.push({ s: rel(o + 9), e: rel(o + 12), name: 'profile / compat / level' });
        f.push({ s: rel(o + 13), e: rel(o + 14), name: 'numSPS' });
      }
      if (n === 'hvcC') f.push({ s: rel(o + 9), e: rel(o + 13), name: 'profile/level' });
    } catch (e) { /* 忽略字段高亮异常 */ }
    return f;
  }

  function boxTreeHtml(nodes) {
    return '<div class="ana-tree">' + nodes.map(function rec(n) {
      const kids = n.children && n.children.length
        ? '<div class="ana-kids">' + n.children.map(rec).join('') + '</div>' : '';
      const open = n.depth < 2 ? ' open' : '';
      return `<details class="ana-box" data-box="${n.__i}"${open}>
        <summary><span class="ana-caret">▸</span><b class="ana-boxtype">${esc(n.type)}</b>
        <span class="ana-boxsize">${n.size} B</span>
        ${n.truncated ? '<span class="ana-badge no">截断</span>' : ''}
        ${n.info ? `<span class="ana-boxinfo">${esc(n.info)}</span>` : ''}</summary>
        ${kids}
      </details>`;
    }).join('') + '</div>';
  }

  function renderMp4(res, bytes) {
    res.flat.forEach((n, i) => { n.__i = i; });
    if (typeof window !== 'undefined') window.__anaMp4Flat = res.flat;
    let html = statCards([
      ['时长', fmtMs(res.durationMs), 'mvhd 时间基换算'],
      ['轨道', res.tracks.length, 'trak 数量'],
      ['品牌', res.brands.slice(0, 2).join(' / ') || '—', 'ftyp'],
      ['顶层 box', res.boxes.length, '可点击查看字节']
    ]);
    if (res.tracks.length) {
      html += '<h4>轨道信息</h4>' + simpleTable(
        ['#', 'track_id', 'handler', '编码', '分辨率/音频', '样本数', '平均帧率', '关键帧', '时间基'],
        res.tracks.map(t => [
          t.index, t.trackId, t.handler || '—', t.codec || '—',
          t.width ? `${t.width}×${t.height}` : (t.channels ? `${t.channels} ch / ${t.sampleRate} Hz` : '—'),
          t.samples, t.fps ? fmtNum(t.fps, 2) + ' fps' : '—', t.keyframes || '—',
          t.timescale ? `${t.timescale} · ${t.duration} tick` : '—'
        ])
      );
    }
    if (res.sps) {
      const sps = parseSps(res.sps.subarray(1));
      html += `<div class="ana-note">从 avcC / CodecPrivate 提取到 SPS：<b>${sps.width}×${sps.height}</b>（profile ${sps.profileIdc}、level ${sps.levelIdc}）。完整字段请到「码流」标签页解析。</div>`;
    }
    html += '<h4>box 树（点击任意节点查看该 box 的十六进制）</h4>' + boxTreeHtml(res.boxes);
    html += '<div class="ana-hexslot" id="ana-hex"></div>';
    return html;
  }

  /* 6.2 MPEG-TS */
  function renderTs(res) {
    let html = statCards([
      ['同步偏移', res.syncOffset, '字节'],
      ['TS 包', res.packetCount, '188 字节/包'],
      ['PID', res.pids.length, '含空包'],
      ['CC 错误', res.ccErrors, res.resyncs ? `重同步 ${res.resyncs} 次` : '连续性计数'],
      ['PCR', res.pcr.length, '样本数']
    ]);
    if (res.pat) {
      html += '<h4>PAT（节目关联表）</h4>' + simpleTable(['program_number', 'PMT PID', 'CRC'],
        res.pat.programs.map(p => [p.program, '0x' + p.pid.toString(16).toUpperCase(), res.pat.crcOk ? { html: '<span class="ana-badge ok">OK</span>' } : { html: '<span class="ana-badge no">错误</span>' }]));
    }
    if (res.pmt && res.pmt.streams) {
      html += '<h4>PMT（节目映射表）</h4>' + simpleTable(['stream_type', 'PID', '类型', 'ES info 长度'],
        res.pmt.streams.map(s => ['0x' + s.streamType.toString(16).toUpperCase().padStart(2, '0'), '0x' + s.pid.toString(16).toUpperCase(), s.name, s.esInfoLength]));
      html += `<div class="ana-note">PCR_PID：<b>0x${res.pmt.pcrPid.toString(16).toUpperCase()}</b> · 节目号 ${res.pmt.program}</div>`;
    }
    html += '<h4>PID 统计</h4>' + simpleTable(['PID', '包数', '载荷字节', 'PUSI', 'PCR', 'CC 错误', '状态'],
      res.pids.map(p => [
        '0x' + p.pid.toString(16).toUpperCase().padStart(4, '0'), p.packets, p.payloadBytes, p.pusiCount, p.pcrCount, p.ccErrors,
        { html: p.pid === 0x1FFF ? '<span class="ana-badge">空包</span>' : p.tei ? '<span class="ana-badge no">TEI</span>' : p.scrambled ? '<span class="ana-badge warn">加扰</span>' : '<span class="ana-badge ok">正常</span>' }
      ]));

    // 单包头部位域图
    html += '<h4>单包头部字段</h4><div class="ana-bits">同步字节 + 头部 8 字节（共 32 bit）</div>' +
      '<div class="ana-bitrow">' +
      '<span class="ana-bf" style="flex:8"><b>sync</b><i>0x47</i></span>' +
      '<span class="ana-bf f1" style="flex:1"><b>TEI</b><i>0</i></span>' +
      '<span class="ana-bf f1" style="flex:1"><b>PUSI</b><i>0/1</i></span>' +
      '<span class="ana-bf f1" style="flex:1"><b>prio</b><i>0</i></span>' +
      '<span class="ana-bf f2" style="flex:13"><b>PID</b><i>13 bit</i></span>' +
      '<span class="ana-bf f3" style="flex:2"><b>scrambling</b><i>2 bit</i></span>' +
      '<span class="ana-bf f4" style="flex:2"><b>adaptation</b><i>2 bit</i></span>' +
      '<span class="ana-bf f5" style="flex:4"><b>continuity</b><i>4 bit</i></span>' +
      '</div><div class="ana-bits">字节 1 ～ 3：TEI/PUSI/priority/PID/加扰/适配/连续计数</div>';

    html += '<h4>PCR 时间折线</h4>' + pcrSvg(res.pcr);
    html += warningsHtml(res.warnings);
    return html;
  }

  function pcrSvg(pcr) {
    if (!pcr || pcr.length < 2) return '<div class="ana-empty">PCR 样本不足（至少 2 个才能画线）</div>';
    const w = 720, h = 190, pl = 52, pr = 14, pt = 14, pb = 28;
    const xs = pcr.map((p, i) => i), ys = pcr.map(p => p.ms);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const spanY = maxY - minY || 1;
    const X = i => pl + (i / (pcr.length - 1)) * (w - pl - pr);
    const Y = v => pt + (1 - (v - minY) / spanY) * (h - pt - pb);
    const pts = pcr.map((p, i) => X(i).toFixed(1) + ',' + Y(p.ms).toFixed(1)).join(' ');
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const y = pt + i * (h - pt - pb) / 4;
      grid += `<line x1="${pl}" y1="${y}" x2="${w - pr}" y2="${y}" stroke="#e2e8f0"/>`;
    }
    const ticks = pcr.map((p, i) => X(i).toFixed(1) + ',' + Y(p.ms).toFixed(1));
    return `<div class="ana-pcr"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      ${grid}
      <polyline points="${pts}" fill="none" stroke="#7c3aed" stroke-width="2.2"/>
      ${ticks.map((t, i) => i % Math.ceil(pcr.length / 8) === 0 ? `<circle cx="${t.split(',')[0]}" cy="${t.split(',')[1]}" r="3" fill="#0891b2"/>` : '').join('')}
      <text x="8" y="${pt + 10}" font-size="10" fill="#64748b">${fmtNum(maxY, 0)} ms</text>
      <text x="8" y="${h - pb}" font-size="10" fill="#64748b">${fmtNum(minY, 0)} ms</text>
      <text x="${w - pr - 30}" y="${h - 8}" font-size="10" fill="#64748b">包序号</text>
    </svg><div class="ana-bits">共 ${pcr.length} 个 PCR 样本 · 首尾间隔 ${fmtMs(maxY - minY)} · PID 0x${pcr[0].pid.toString(16).toUpperCase()}</div></div>`;
  }

  /* 6.3 FLV / MKV / WAV / AVI / 其他 */
  function renderFlv(res) {
    let html = statCards([
      ['版本', res.version, 'FLV 头'],
      ['dataOffset', res.dataOffset, '字节'],
      ['时长', fmtMs(res.durationMs), res.meta && res.meta.duration ? 'onMetaData' : '末个 tag'],
      ['tag 数', res.tags.length, '预览范围内']
    ]);
    if (res.meta && Object.keys(res.meta).length) {
      const keys = ['duration', 'width', 'height', 'framerate', 'videocodecid', 'audiocodecid', 'encoder'];
      const rows = keys.filter(k => res.meta[k] !== undefined).map(k => [k, String(res.meta[k])]);
      if (rows.length) html += '<h4>onMetaData（AMF0）</h4>' + simpleTable(['字段', '值'], rows);
    }
    if (res.avcC) {
      html += `<div class="ana-note">AVC 配置：profile ${res.avcC.profile} · level ${res.avcC.level} · lengthSize ${res.avcC.lengthSize} · SPS ${res.avcC.sps.length} 组；SPS 已提取（${res.sps ? parseSps(res.sps.subarray(1)).width : '?'}×${res.sps ? parseSps(res.sps.subarray(1)).height : '?'}）。</div>`;
    }
    if (res.asc) {
      const asc = parseAacAsc(res.asc);
      html += `<div class="ana-note">AAC ASC：${esc(asc.objectName)} · ${asc.sampleRate} Hz · ${asc.channels} 声道${asc.sbr ? ' · 含 SBR' : ''}${asc.ps ? ' · 含 PS' : ''}。</div>`;
    }
    html += '<h4>tag 列表</h4>' + simpleTable(['#', '类型', '时间戳', 'dataSize', '偏移', '解析'],
      res.tags.slice(0, 80).map((t, i) => {
        let detail = '—';
        if (t.type === 9 && t.codecId !== undefined) detail = `codecId ${t.codecId}${t.avcPacketType === 0 ? ' · AVC 序列头' : t.avcPacketType === 1 ? ' · AVC NALU' : ''}`;
        else if (t.type === 8 && t.soundFormat !== undefined) detail = `soundFormat ${t.soundFormat}${t.asc ? ' · AAC 序列头' : ''}`;
        else if (t.type === 18 && t.amf) detail = 'AMF0 对象';
        return [i + 1, t.typeName, fmtMs(t.timestamp), t.size, '0x' + t.offset.toString(16), detail];
      }));
    if (res.tags.length > 80) html += `<div class="ana-note">仅展示前 80 个 tag，共 ${res.tags.length} 个。</div>`;
    return html + warningsHtml(res.warnings);
  }

  function renderMkv(res) {
    res.flat.forEach((n, i) => { n.__i = i; });
    let html = statCards([
      ['DocType', res.docType || '—', 'EBML 头'],
      ['时长', fmtMs(res.durationMs), 'Duration × TimestampScale'],
      ['时间刻度', res.timestampScale + ' ns', 'TimestampScale'],
      ['轨道', res.tracks.length, 'TrackEntry']
    ]);
    if (res.tracks.length) {
      html += '<h4>轨道</h4>' + simpleTable(['#', 'TrackNumber', '类型', 'CodecID', '分辨率/音频'],
        res.tracks.map(t => [t.index, t.number, t.typeName || '—', t.codec || '—',
          t.width ? `${t.width}×${t.height}` : (t.channels ? `${t.channels} ch / ${t.sampleRate} Hz` : '—')]));
    }
    html += '<h4>EBML 元素树</h4><div class="ana-tree mkv">' + res.flat.filter(n => n.depth === 0).map(function rec(n) {
      const kids = n.children && n.children.length ? '<div class="ana-kids">' + n.children.map(rec).join('') + '</div>' : '';
      return `<details class="ana-box"${n.depth < 2 ? ' open' : ''}><summary><span class="ana-caret">▸</span><b class="ana-boxtype">${esc(n.name)}</b>
        <span class="ana-boxsize">${n.size} B</span>${n.value !== null && n.value !== undefined ? `<span class="ana-boxinfo">${esc(String(n.value))}</span>` : ''}</summary>${kids}</details>`;
    }).join('') + '</div>';
    return html + warningsHtml(res.warnings);
  }

  function renderRiff(res) {
    let html = statCards([
      ['子类型', res.form, 'RIFF'],
      ['chunks', res.chunks.length, '预览范围']
    ]);
    if (res.kind === 'wav') {
      html += statCards([
        ['格式', res.formatName || '—', 'fmt 块'],
        ['采样率', (res.sampleRate || 0) + ' Hz', ''],
        ['声道', res.channels || 0, ''],
        ['位深', (res.bitsPerSample || 0) + ' bit', ''],
        ['数据大小', fmtBytes(res.dataSize || 0), ''],
        ['时长', fmtMs(res.durationMs || 0), 'data / byteRate']
      ]);
    }
    html += '<h4>RIFF chunk 列表</h4>' + simpleTable(['chunk id', '偏移', '声明大小', '预览大小', '备注'],
      res.chunks.map(c => [c.id, '0x' + c.offset.toString(16), c.size, c.realSize, c.listType ? 'LIST ' + c.listType : '']));
    return html + warningsHtml(res.warnings);
  }

  function renderOther(res) {
    if (res.kind === 'ogg') {
      return statCards([['Ogg 页', res.pages, '预览范围'], ['版本', res.version, 'OggS'], ['逻辑流', res.serials.length, 'serial']]) +
        `<div class="ana-note">Ogg 的 granule position 是第一页的 ${esc(res.firstGranule)}；深入解析需要编解码器私有头（OpusHead/Vorbis 等）。</div>`;
    }
    if (res.kind === 'mp3') {
      return statCards([['ID3', res.id3 ? 'v' + res.id3.version : '无', res.id3 ? fmtBytes(res.id3.size) : ''], ['MPEG 版本', res.version || '—'], ['层', res.layer || '—'], ['采样率', (res.sampleRate || 0) + ' Hz'], ['码率', (res.bitrate || 0) + ' kbps']]) +
        '<div class="ana-note">首个帧偏移 0x' + res.firstFrameOffset.toString(16) + '；这里只做识别与头部字段，不做完整帧表。</div>';
    }
    return '<div class="ana-empty">该容器仅做识别，暂不深入解析。</div>';
  }

  /* 6.4 码流结果 */
  function fieldTable(rows) {
    return simpleTable(['字段', '值', '说明'], rows);
  }

  function renderSps(f, rawSps) {
    let html = statCards([
      ['显示分辨率', f.width + '×' + f.height, '宏块 × 裁剪'],
      ['profile_idc', f.profileIdc, 'Baseline=66 / Main=77 / High=100'],
      ['level_idc', f.levelIdc, '3.1 = 31'],
      ['帧率', f.fps ? fmtNum(f.fps, 2) + ' fps' : '—', f.timing ? 'VUI timing' : 'SPS 未带 VUI timing']
    ]);
    html += fieldTable([
      ['profile_idc', f.profileIdc, { html: '约束标志 0x' + pad2(f.constraintFlags.toString(16)) }],
      ['level_idc', f.levelIdc, '等级 = ' + (f.levelIdc / 10).toFixed(1)],
      ['seq_parameter_set_id', f.spsId, 'ue(v)'],
      ['chroma_format_idc', f.chromaFormatIdc, f.chromaFormatIdc === 1 ? '4:2:0' : f.chromaFormatIdc === 2 ? '4:2:2' : f.chromaFormatIdc === 3 ? '4:4:4' : '单色'],
      ['bit_depth', f.bitDepthLuma + ' / ' + f.bitDepthChroma, '亮度 / 色度，单位 bit'],
      ['log2_max_frame_num', f.log2MaxFrameNum, 'ue(v) + 4'],
      ['pic_order_cnt_type', f.picOrderCntType, f.picOrderCntType === 0 ? 'log2_max_pic_order_cnt_lsb=' + f.log2MaxPocLsb : '类型 ' + f.picOrderCntType],
      ['max_num_ref_frames', f.maxNumRefFrames, '参考帧数量'],
      ['pic_width_in_mbs', f.widthMbs, '宏块数 × 16 = ' + f.widthMbs * 16 + ' 像素'],
      ['pic_height_in_map_units', f.heightMapUnits, '帧高 ' + f.heightMapUnits * 16 + ' 像素'],
      ['frame_mbs_only_flag', f.frameMbsOnly ? '1' : '0', f.frameMbsOnly ? '逐行' : '可场编码'],
      ['frame_cropping', f.crop.join(' / '), '左 / 右 / 上 / 下（单位由色度格式决定）'],
      ['VUI timing', f.timing ? f.timing.timeScale + ' / ' + f.timing.numUnitsInTick : '无', f.timing ? 'time_scale / num_units_in_tick' : '']
    ]);
    html += '<h4>SPS 原始字节</h4><div class="pre code ana-raw">' + esc(hexStr(rawSps, 0, rawSps.length)) + '</div>';
    if (f.warning) html += `<div class="ana-err">${esc(f.warning)}</div>`;
    return html;
  }

  function renderAsc(a) {
    let html = statCards([
      ['对象类型', a.objectName, 'audioObjectType=' + a.audioObjectType],
      ['采样率', (a.sampleRate || 0) + ' Hz', '索引 ' + a.samplingFrequencyIndex],
      ['声道', a.channels, 'channelConfiguration=' + a.channelConfiguration],
      ['扩展', (a.sbr ? 'SBR ' : '') + (a.ps ? 'PS' : '') || '无', a.extension || '未检测到扩展']
    ]);
    html += fieldTable([
      ['audioObjectType', a.audioObjectType, '5 bit，31 时用 6 bit 转义'],
      ['samplingFrequencyIndex', a.samplingFrequencyIndex, '4 bit 查表；15 表示显式 24 bit 采样率'],
      ['sampleRate', a.sampleRate, 'Hz'],
      ['channelConfiguration', a.channelConfiguration, '4 bit；7 表示 7.1 共 8 声道'],
      ['sbr', a.sbr ? '是' : '否', 'Spectral Band Replication（谱带复制）'],
      ['ps', a.ps ? '是' : '否', 'Parametric Stereo（参数立体声）']
    ]);
    html += '<h4>ASC 原始字节</h4><div class="pre code ana-raw">' + esc(a.rawHex) + '</div>';
    return html;
  }

  function renderHvcC(h) {
    let html = statCards([
      ['profile_idc', h.profileIdc, 'general_profile_idc'],
      ['level_idc', h.levelIdc, 'general_level_idc（120 = 4.0）'],
      ['tier', h.tier ? 'High' : 'Main', 'general_tier_flag'],
      ['SPS 数', h.spsCount, '数组类型 33']
    ]);
    html += fieldTable([
      ['configurationVersion', h.version, '通常为 1'],
      ['profileSpace', h.profileSpace, '2 bit'],
      ['profile_compatibility', '—', '32 bit 兼容性标志（略）'],
      ['constraint_flags', '—', '48 bit 约束标志（略）'],
      ['lengthSizeMinusOne', h.lengthSize - 1, 'NALU 长度字段大小 = ' + h.lengthSize + ' 字节'],
      ['numOfArrays', h.arrays.length, h.arrays.map(a => '类型 ' + a.nalType + ' × ' + a.count).join('；')]
    ]);
    html += '<div class="ana-note">HEVC 的 SPS 语法比 H.264 复杂得多（含 profile_tier_level、short_term_ref_pic_set 等），本页只解析 hvcC 配置记录，不展开 SPS 内部字段。</div>';
    html += '<h4>hvcC 原始字节</h4><div class="pre code ana-raw">' + esc(hexStr(h.raw || new Uint8Array(0), 0, h.raw ? h.raw.length : 0)) + '</div>';
    return html;
  }

  /* 6.5 协议结果 */
  function chip(k, v) { return `<span class="ana-chip"><b>${esc(k)}</b>${esc(v)}</span>`; }

  function renderRtp(r) {
    let html = statCards([
      ['版本 / PT', r.version + ' / ' + r.pt, '动态 PT 常见 96～127'],
      ['序列号', r.seq, '16 bit，回绕后继续'],
      ['时间戳', r.timestamp, r.clockRate],
      ['SSRC', '0x' + r.ssrc.toString(16).toUpperCase(), '同步源标识']
    ]);
    html += '<div class="ana-chips">' +
      chip('V', r.version) + chip('P', r.padding ? 1 : 0) + chip('X', r.extension ? 1 : 0) +
      chip('CC', r.csrcCount) + chip('M', r.marker ? 1 : 0) + chip('PT', r.pt) +
      (r.csrc.length ? r.csrc.map((c, i) => chip('CSRC' + i, '0x' + c.toString(16))).join('') : '') +
      '</div>';
    html += fieldTable([
      ['V / P / X / CC', [r.version, r.padding ? 1 : 0, r.extension ? 1 : 0, r.csrcCount].join(' / '), '首字节 0x' + pad2(r.firstByte.toString(16))],
      ['M / PT', (r.marker ? 1 : 0) + ' / ' + r.pt, '标记位 + 载荷类型'],
      ['sequence number', r.seq, '每包 +1'],
      ['timestamp', r.timestamp, '90 kHz（视频）或 8 kHz（G.711）'],
      ['SSRC', '0x' + r.ssrc.toString(16).toUpperCase(), ''],
      ['CSRC', r.csrcCount ? r.csrc.map(c => '0x' + c.toString(16)).join(', ') : '无', '混音贡献源'],
      ['扩展头', r.extensionHeader ? 'profile=0x' + r.extensionHeader.profile.toString(16) + '，' + r.extensionHeader.length + ' 字节' : '无', 'X=1 时存在'],
      ['载荷偏移', r.payloadOffset + ' B', '跳过 RTP 头/CSRC/扩展'],
      ['载荷长度', r.payloadLength + ' B' + (r.padding ? '（含 ' + r.paddingBytes + ' 字节填充）' : ''), '']
    ]);
    html += '<h4>载荷前 32 字节</h4><div class="pre code ana-raw">' + esc(r.payloadHex || '（空）') + '</div>';
    html += warningsHtml(r.warnings);
    return html;
  }

  function renderRtcp(r) {
    let html = statCards([
      ['包类型', r.name, 'PT=' + r.pt],
      ['报告块', r.reportCount, 'RC 字段'],
      ['长度', r.declaredBytes + ' B', '(length+1)×4'],
      ['发送方 SSRC', '0x' + r.ssrc.toString(16).toUpperCase(), '']
    ]);
    html += '<div class="ana-chips">' + chip('V', r.version) + chip('PT', r.pt) + chip('RC', r.reportCount) + chip('length', r.lengthWords) + '</div>';
    if (r.senderInfo) {
      html += '<h4>发送者信息（SR）</h4>' + fieldTable([
        ['NTP 秒 / 小数', r.senderInfo.ntpMsw + ' / ' + r.senderInfo.ntpLsw, '网络时间协议时间戳'],
        ['RTP timestamp', r.senderInfo.rtpTimestamp, '与 RTP 包同一时钟'],
        ['packet count', r.senderInfo.packetCount, '累计发送包数'],
        ['octet count', r.senderInfo.octetCount, '累计发送字节数']
      ]);
    }
    if (r.reports && r.reports.length) {
      html += '<h4>报告块</h4>' + simpleTable(['SSRC', '丢包率', '累计丢包', '最高序列号', '抖动', 'LSR', 'DLSR'],
        r.reports.map(x => ['0x' + x.ssrc.toString(16).toUpperCase(), (x.fractionLost / 256 * 100).toFixed(2) + '%', x.cumulativeLost, x.highestSeq, x.jitter, '0x' + x.lastSr.toString(16), x.delaySinceLastSr]));
    }
    if (r.byeSsrc && r.byeSsrc.length) {
      html += '<div class="ana-note">BYE 离开的 SSRC：' + r.byeSsrc.map(s => '0x' + s.toString(16)).join(', ') + '</div>';
    }
    if (r.truncated) html += '<div class="ana-err">声明的长度超过实际字节数，数据可能被截断。</div>';
    return html + warningsHtml(r.warnings);
  }

  function renderTextMessage(r) {
    const badge = r.kind === 'sip' ? 'SIP' : r.kind === 'rtsp' ? 'RTSP' : '文本';
    let html = `<div class="ana-chips">${chip('协议', badge)}${chip('类型', r.messageType)}${chip('方法', r.method || '—')}${r.status ? chip('状态码', r.status) : ''}</div>`;
    html += '<h4>起始行</h4><div class="pre code ana-raw">' + esc(r.startLine) + '</div>';
    if (r.uri) html += `<div class="ana-note">请求 URI：<b>${esc(r.uri)}</b></div>`;
    html += '<h4>头部字段</h4>' + simpleTable(['名称', '值'], r.headers.map(h => [h.name, h.value]));
    if (r.body) html += '<h4>消息体</h4><div class="pre code ana-body">' + esc(r.body) + '</div>';
    if (r.sdp) html += '<h4>SDP</h4>' + renderSdp(r.sdp) + '<div class="pre code ana-raw">' + esc(r.body) + '</div>';
    return html;
  }

  function renderSdp(sdp) {
    let html = '<div class="ana-chips">' +
      chip('媒体节', sdp.media.length) +
      (sdp.session.name ? chip('s=', sdp.session.name) : '') +
      (sdp.session.origin ? chip('o=', sdp.session.origin) : '') +
      (sdp.session.y ? chip('y=', sdp.session.y) : '') +
      '</div>';
    sdp.media.forEach((m, i) => {
      const payloads = Object.keys(m.rtpmap);
      let rows = payloads.map(pt => [pt, m.rtpmap[pt].encoding, m.rtpmap[pt].clock + ' Hz', m.rtpmap[pt].channels || 1, m.fmtp[pt] || '—']);
      html += `<div class="ana-sdp"><div class="ana-sdp-h"><b>m=${esc(m.media + ' ' + m.port + ' ' + m.proto + ' ' + m.formats.join(' '))}</b>
        <span class="ana-badge">${esc(m.media)}</span>${m.setup ? `<span class="ana-badge warn">setup=${esc(m.setup)}</span>` : ''}</div>`;
      if (m.control) html += `<div class="ana-bits">a=control:${esc(m.control)}</div>`;
      if (m.y) html += `<div class="ana-bits">y=${esc(m.y)}（SSRC）</div>`;
      if (rows.length) html += simpleTable(['PT', 'encoding', 'clock', 'channels', 'fmtp'], rows);
      else html += `<div class="ana-bits">格式：${esc(m.formats.join(', '))}</div>`;
      html += '</div>';
    });
    return html;
  }

  /* ================= 七、示例数据与 UI ================= */

  var CONTAINER_SAMPLES = null;
  function getContainerSamples() {
    if (!CONTAINER_SAMPLES) CONTAINER_SAMPLES = buildSamples();
    return CONTAINER_SAMPLES;
  }
  function hexToBytes(txt) {
    let clean = String(txt).replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2) clean = clean.slice(0, -1);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  var PROTOCOL_EXAMPLES = {
    rtp: '80 60 12 34 00 00 0F A0 11 22 33 44 65 88 80 40 39 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00',
    rtcp: '81 C8 00 0C 11 22 33 44 E8 01 00 00 00 01 00 00 00 00 0F A0 00 00 00 0A 00 00 03 84 ' +
      '55 66 77 88 00 00 00 00 00 00 12 34 00 00 01 00 E8 01 00 00 00 00 00 10',
    sip: 'INVITE sip:34020000001320000001@3402000000 SIP/2.0\r\n' +
      'Via: SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bK1234\r\n' +
      'From: <sip:34020000001320000001@3402000000>;tag=abc\r\n' +
      'To: <sip:34020000001320000002@3402000000>\r\n' +
      'Call-ID: 123456789@192.168.1.10\r\n' +
      'CSeq: 1 INVITE\r\n' +
      'Contact: <sip:34020000001320000001@192.168.1.10:5060>\r\n' +
      'Content-Type: application/sdp\r\n' +
      'Content-Length: 220\r\n\r\n' +
      'v=0\r\no=34020000001320000001 0 0 IN IP4 192.168.1.10\r\ns=Play\r\n' +
      'c=IN IP4 192.168.1.10\r\nt=0 0\r\ny=0000000001\r\n' +
      'm=video 6000 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n' +
      'a=fmtp:96 packetization-mode=1; profile-level-id=42E01F\r\n' +
      'a=setup:active\r\na=control:track1\r\n' +
      'm=audio 6002 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/8000\r\n' +
      'a=fmtp:97 mode=AAC-hbr; config=1210\r\na=control:track2\r\n',
    rtsp: 'PLAY rtsp://192.168.1.10:554/live/track1 RTSP/1.0\r\n' +
      'CSeq: 5\r\n' +
      'Session: 12345678\r\n' +
      'Range: npt=0.000-\r\n' +
      'User-Agent: AVAnalyzer Demo\r\n\r\n'
  };

  var lastContainerBytes = null;

  function setResult(el, html) { if (el) el.innerHTML = html; }
  function showError(el, msg) {
    if (el) el.innerHTML = '<div class="ana-err">✖ ' + esc(msg) + '</div>';
  }

  function renderContainerResult(res, bytes) {
    switch (res.kind) {
      case 'mp4': return renderMp4(res, bytes);
      case 'ts': return renderTs(res);
      case 'flv': return renderFlv(res);
      case 'mkv': return renderMkv(res);
      case 'wav': case 'avi': case 'riff': return renderRiff(res);
      case 'ogg': case 'mp3': return renderOther(res);
      default: return '<div class="ana-empty">未识别的容器。可以试试 MP4 / TS / FLV / MKV 示例按钮；也支持拖入文件。</div>';
    }
  }

  function parseBuffer(bytes) {
    const det = detectContainer(bytes);
    let res = null;
    if (det.kind === 'mp4') res = parseMp4(bytes);
    else if (det.kind === 'ts') res = parseTs(bytes, det.detail && /偏移 (\d+)/.test(det.detail) ? Number(det.detail.match(/偏移 (\d+)/)[1]) : undefined);
    else if (det.kind === 'flv') res = parseFlv(bytes);
    else if (det.kind === 'mkv') res = parseMkv(bytes);
    else if (det.kind === 'wav' || det.kind === 'avi' || det.kind === 'riff') res = parseRiff(bytes);
    else if (det.kind === 'ogg') res = parseOgg(bytes);
    else if (det.kind === 'mp3') res = parseMp3(bytes);
    else res = { kind: 'unknown', warnings: [] };
    res.detected = det;
    return res;
  }

  function runContainer(bytes, label, byteLen, previewNote) {
    const status = $('#ana-status');
    const out = $('#ana-container-result');
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    try {
      const det = detectContainer(bytes);
      const res = parseBuffer(bytes);
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      lastContainerBytes = bytes;
      if (status) {
        status.innerHTML = `<div class="ana-statusbar"><span class="ana-badge ok">${esc(det.label)}</span>
          <span class="ana-meta">${esc(label)} · ${fmtBytes(byteLen)} · 解析 ${(t1 - t0).toFixed(1)} ms</span>
          <span class="ana-badge tip">文件不离开浏览器</span></div>` +
          (previewNote ? `<div class="ana-warn">${esc(previewNote)}</div>` : '');
      }
      setResult(out, renderContainerResult(res, bytes));
      if (det.kind === 'unknown') {
        showError(out, '无法识别这个文件。当前支持 MP4/MOV、MPEG-TS、FLV、Matroska/WebM、WAV、AVI、Ogg、MP3。' + (det.detail ? '（' + det.detail + '）' : ''));
      }
    } catch (err) {
      lastContainerBytes = null;
      if (status) status.innerHTML = '';
      showError(out, '解析失败：' + (err && err.message ? err.message : err));
    }
  }

  function readFileSlice(file, maxBytes) {
    return new Promise(function (resolve, reject) {
      const blob = (maxBytes && file.size > maxBytes) ? file.slice(0, maxBytes) : file;
      if (blob.arrayBuffer) {
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      } else {
        const fr = new FileReader();
        fr.onload = function () { resolve(new Uint8Array(fr.result)); };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsArrayBuffer(blob);
      }
    });
  }

  function handleFile(file, previewOnly) {
    if (!file) return;
    const max = previewOnly ? 8 * 1024 * 1024 : null;
    const note = previewOnly ? `文件较大（${fmtBytes(file.size)}），已只读取前 8 MB 做「前 8 MB 预览」；解析结果可能不完整，但文件始终留在本地。` : '';
    if (previewOnly) {
      const status = $('#ana-status');
      if (status) status.innerHTML = `<div class="ana-warn">${esc(note)}</div>`;
    }
    readFileSlice(file, max).then(function (bytes) {
      runContainer(bytes, file.name, file.size, note);
    }).catch(function (err) {
      showError($('#ana-container-result'), '读取文件失败：' + (err && err.message ? err.message : err));
    });
  }

  function initUi() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.ana-tab'));
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const tab = btn.getAttribute('data-tab');
        tabs.forEach(b => {
          const on = b === btn;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        ['container', 'codec', 'protocol'].forEach(k => {
          const pane = document.getElementById('ana-pane-' + k);
          if (pane) pane.classList.toggle('on', k === tab);
        });
      });
    });

    // 容器
    const drop = $('#ana-drop');
    const input = $('#ana-file');
    if (drop && input) {
      drop.addEventListener('click', function () { input.click(); });
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', function (e) {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f, f.size > 100 * 1024 * 1024);
      });
      input.addEventListener('change', function () {
        const f = input.files && input.files[0];
        if (f) handleFile(f, f.size > 100 * 1024 * 1024);
      });
    }
    const resetBtn = $('#ana-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      if (input) input.value = '';
      lastContainerBytes = null;
      setResult($('#ana-status'), '<span class="ana-meta">还没有选择文件。拖入音视频文件，或点击下面的内置示例。</span>');
      setResult($('#ana-container-result'), '<div class="ana-empty">解析结果会显示在这里。</div>');
    });

    document.querySelectorAll('#ana-container-samples [data-sample]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.getAttribute('data-sample');
        const s = getContainerSamples()[key];
        if (!s) return;
        const names = { mp4: '示例 MP4（ftyp + moov + avcC）', ts: '示例 MPEG-TS（PAT + PMT + H.264 PCR）', flv: '示例 FLV（onMetaData + AVC/AAC 序列头）', mkv: '示例 Matroska（EBML + Tracks）' };
        runContainer(s.bytes, names[key], s.bytes.length, '');
      });
    });

    // MP4 box 点击 → hex
    const containerOut = $('#ana-container-result');
    if (containerOut) {
      containerOut.addEventListener('click', function (e) {
        const sum = e.target.closest('summary');
        if (!sum || !lastContainerBytes) return;
        const box = sum.closest('.ana-box');
        if (!box) return;
        const idx = Number(box.getAttribute('data-box'));
        const node = window.__anaMp4Flat && window.__anaMp4Flat[idx];
        if (!node) return;
        const slot = $('#ana-hex');
        if (!slot) return;
        slot.innerHTML = '<h4>' + esc(node.type) + ' @ 0x' + node.offset.toString(16) + '</h4>' +
          hexTable(lastContainerBytes, node.offset, Math.min(node.size, 512), mp4HexFields(node, lastContainerBytes));
        slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }

    // 码流
    const codecInput = $('#ana-codec-hex');
    const codecOut = $('#ana-codec-result');
    function runCodec(mode) {
      if (!codecInput) return;
      const bytes = hexToBytes(codecInput.value);
      if (!bytes.length) { showError(codecOut, '请先粘贴十六进制字节，或点击一个示例。'); return; }
      try {
        if (mode === 'sps') {
          let avcc = null, sps = null;
          if (bytes[0] === 1 && bytes.length > 7) {
            avcc = parseAvcC(bytes);
            if (avcc.sps.length) sps = avcc.sps[0].bytes;
          } else {
            const nals = parseAnnexB(bytes);
            const s = nals.find(n => n.type === 7);
            if (s) sps = s.bytes;
            else if ((bytes[0] & 0x1F) === 7) sps = bytes;
          }
          if (!sps) { showError(codecOut, '没有在输入中找到 SPS：可以粘贴 Annex B（00 00 01 67…）、裸 SPS 或 avcC 记录。'); return; }
          if (sps.length < 4) { showError(codecOut, 'SPS 太短。'); return; }
          const f = parseSps(sps.subarray(1));
          setResult(codecOut, renderSps(f, sps) + (avcc ? '<h4>avcC 记录</h4>' + fieldTable([
            ['configurationVersion', avcc.version, ''],
            ['AVCProfileIndication', avcc.profile, '与 SPS profile_idc 一致'],
            ['profile_compatibility', avcc.compatibility, ''],
            ['AVCLevelIndication', avcc.level, ''],
            ['lengthSizeMinusOne', avcc.lengthSize - 1, 'NALU 长度 = ' + avcc.lengthSize + ' 字节'],
            ['SPS 数量', avcc.sps.length, ''],
            ['PPS 数量', avcc.pps.length, '']
          ]) : ''));
        } else if (mode === 'asc') {
          if (bytes.length < 2) { showError(codecOut, 'ASC 通常至少 2 字节。'); return; }
          setResult(codecOut, renderAsc(parseAacAsc(bytes)));
        } else {
          if (bytes.length < 23) { showError(codecOut, 'hvcC 记录至少 23 字节。'); return; }
          setResult(codecOut, renderHvcC(parseHvcC(bytes, 0, bytes.length)));
        }
      } catch (err) {
        showError(codecOut, '解析失败：' + (err && err.message ? err.message : err));
      }
    }
    ['sps', 'asc', 'hvc'].forEach(function (m, i) {
      const btn = document.getElementById('ana-btn-' + m);
      if (btn) btn.addEventListener('click', function () { runCodec(m); });
    });
    document.querySelectorAll('#ana-codec-samples [data-csp]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const t = btn.getAttribute('data-csp');
        const s = getContainerSamples();
        if (t === 'sps' && s.mp4 && s.mp4.sps) {
          const pps = s.mp4.pps;
          codecInput.value = '00 00 00 01 ' + hexStr(s.mp4.sps, 0, s.mp4.sps.length) +
            (pps ? ' 00 00 00 01 ' + hexStr(pps, 0, pps.length) : '');
        } else if (t === 'asc') {
          codecInput.value = '12 10';
        } else if (t === 'avcc') {
          codecInput.value = hexStr(s.mp4.avcC, 0, Math.min(s.mp4.avcC.length, 48));
        } else if (t === 'hvc') {
          codecInput.value = '01 01 60 00 00 00 90 00 00 00 00 00 78 F0 00 FC FD F8 F8 00 00 0F 01 21 00 01 00 0B 42 01 01 01 60 00 00 03 00 90 00';
        }
        runCodec(t === 'asc' ? 'asc' : t === 'hvc' ? 'hvc' : 'sps');
      });
    });
    const codecClear = $('#ana-codec-clear');
    if (codecClear) codecClear.addEventListener('click', function () {
      if (codecInput) codecInput.value = '';
      setResult(codecOut, '<div class="ana-empty">粘贴 SPS / ASC / hvcC 后点击上方按钮。</div>');
    });

    // 协议
    const protoInput = $('#ana-proto-input');
    const protoOut = $('#ana-proto-result');
    function runProto() {
      if (!protoInput) return;
      const raw = protoInput.value.trim();
      if (!raw) { showError(protoOut, '请粘贴十六进制报文或 SIP/RTSP/SDP 文本，或点击一个示例。'); return; }
      try {
        if (/^[0-9a-fA-F\s:]+$/.test(raw) && /[0-9a-fA-F]/.test(raw)) {
          const bytes = hexToBytes(raw);
          if (!bytes.length) { showError(protoOut, '十六进制内容为空。'); return; }
          const r = parseRtpRtcp(bytes);
          if (r.kind === 'rtp') setResult(protoOut, '<div class="ana-note">识别为 <b>RTP</b>（版本 2、PT ' + r.pt + '）</div>' + renderRtp(r));
          else if (r.kind === 'rtcp') setResult(protoOut, '<div class="ana-note">识别为 <b>RTCP ' + esc(r.name) + '</b></div>' + renderRtcp(r));
          else setResult(protoOut, renderRtp(r) + warningsHtml(r.warnings));
        } else {
          const r = parseTextMessage(raw);
          setResult(protoOut, renderTextMessage(r));
        }
      } catch (err) {
        showError(protoOut, '解析失败：' + (err && err.message ? err.message : err));
      }
    }
    const protoParse = $('#ana-proto-parse');
    if (protoParse) protoParse.addEventListener('click', runProto);
    document.querySelectorAll('#ana-proto-samples [data-proto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-proto');
        if (protoInput) protoInput.value = PROTOCOL_EXAMPLES[k] || '';
        runProto();
      });
    });
    const protoClear = $('#ana-proto-clear');
    if (protoClear) protoClear.addEventListener('click', function () {
      if (protoInput) protoInput.value = '';
      setResult(protoOut, '<div class="ana-empty">支持 RTP/RTCP 十六进制，以及 SIP/RTSP/SDP 文本。</div>');
    });
  }

  /* ================= 八、导出（便于无 DOM 环境测试） ================= */

  var API = {
    detectContainer, parseMp4, parseTs, parseFlv, parseMkv, parseRiff, parseOgg, parseMp3,
    parseSps, parseAvcC, parseAnnexB, parseHvcC, parseAacAsc,
    parseRtpRtcp, parseTextMessage, parseSdp,
    buildSamples, hexToBytes, hexStr, crc32Mpeg, fmtMs
  };

  if (typeof root !== 'undefined' && root) root.AVAnalyzer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi);
    else initUi();
  }
})(typeof window !== 'undefined' ? window : globalThis);
