 # 音视频本体论研究站（av-ontology）

一个**纯静态、零依赖**的中文音视频技术站点：用标准、原理、代码、图示和互动动画，把容器、编解码、协议、FFmpeg、GStreamer、GB28181、浏览器播流整条链路讲清楚。

在线访问：**https://yejinlei.github.io/agent-media/**

## 本地预览

```bash
cd agent-media
python -m http.server 8099
# 打开 http://127.0.0.1:8099/
```

> 直接双击 HTML 也能看大部分内容，但 WASM 实验台需要 HTTP 环境。

## 页面一览

| 页面 | 内容 |
|---|---|
| `index.html` | 站点地图与学习路径 |
| `container/` | MP4 / TS / FLV / MKV 容器格式 |
| `codec/` | H.264 / HEVC / AV1 / AAC 编解码 |
| `protocol/` | RTSP / RTP / RTMP / HLS / WebRTC 协议 |
| `hwaccel/` | 硬件加速（VAAPI / NVENC / QSV 等） |
| `ffmpeg/` | FFmpeg 五层流水线与命令原理 |
| `gstreamer.html` | GStreamer pipeline / caps / 时钟 |
| `gb28181.html` | GB28181 国标 SIP 流程与 PS 封装 |
| `player.html` | 浏览器播流（WHEP / HLS / FLV） |
| `servers/` | SRS / ZLMediaKit / MediaMTX 等服务器 |
| `wasm.html` | ffmpeg.wasm 实验台（本地 core，离线可用） |
| `analyze.html` | **在线分析器：浏览器本地解析容器 / 码流 / 协议** |
| `solutions/` | 七类场景的选型决策 |

## 在线分析器（analyze.html）

在浏览器里把音视频文件拆开看，**文件不离开浏览器**（无后端、无上传）。

### 三个标签页

| 标签页 | 输入 | 能解析什么 |
|---|---|---|
| 📦 容器 | 拖入 MP4 / MOV / TS / FLV / MKV / WebM / WAV / AVI / Ogg / MP3 | MP4 递归 box 树（点节点看 hex）、TS 的 PAT/PMT/PCR/CC、FLV tag 与 onMetaData、MKV EBML 树 |
| 🎞️ 码流 | 粘贴十六进制（SPS / avcC / hvcC / AAC ASC） | H.264 SPS 全字段（Exp-Golomb）、AAC 对象类型/采样率/声道、HEVC hvcC |
| 📡 协议 | 粘贴 RTP/RTCP 十六进制，或 SIP/RTSP/SDP 文本 | RTP/RTCP 头字段、SIP/RTSP 起始行与头部、SDP 分节 |

每个标签页都带**内置示例**（MP4、TS、FLV、MKV、1280×720 SPS、AAC ASC、RTP H.264、RTCP SR、SIP INVITE、RTSP PLAY），不选文件也能看到完整解析效果。

### 三步上手

1. **拿字节**：本地文件直接拖；参数集用 `ffprobe -show_streams` / `ffmpeg -bsf:v trace_headers` 导出；网络报文用 Wireshark 复制 Hex Stream / TCP Stream。
2. **从外到内看**：格式判定 → 结构骨架（box 树 / PAT-PMT）→ 轨道参数 → 点 hex 对照字段。
3. **对照判断**：先用内置示例建立“健康数据”的直觉，再看自己文件的差异。

页面内的「使用指南与实战示例」章节有完整的场景对照表（直播卡顿、黑屏花屏、起播慢、国标对接）。

### 能力边界

- 大文件（>100 MB）只读前 8 MB 预览，并明确提示。
- HEVC SPS 内部语法、fMP4 样本索引重建、DRM 解密不做；见页面「能力边界与隐私」。

## 技术说明

- 纯 HTML / CSS / JavaScript，无构建步骤、无外部框架。
- `vendor/ffmpeg/` 内置 `@ffmpeg/core 0.12.6`（约 30 MB），WASM 实验台离线可用，本地优先、CDN 兜底。
- GitHub Pages 直接发布根目录，`.nojekyll` 关闭 Jekyll 处理。

## License

MIT
