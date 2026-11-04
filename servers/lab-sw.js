// av-ontology 直播实验台 · Service Worker 源站
// 作用：拦截同源 fetch(/servers/lab-hls/*)，用「服务器」标签页推送过来的
// HLS 清单与 fMP4 分段响应请求——字面意义的「浏览器内 HTTP 源站」。
// 页面与 SW 通信：navigator.serviceWorker.controller.postMessage(...)
// （多标签页共用同一个 SW 实例，「服务器」角色标签页负责推送清单与分段）
//   { t:'mf',  text }   覆盖当前 m3u8 清单
//   { t:'seg', name, buf } 存一个分段（init.mp4 / seg-N.m4s）
//   { t:'clear' }        清空源站
const MANIFEST_NAME = 'live.m3u8';
const segments = new Map(); // name -> ArrayBuffer
let manifest = '';

self.addEventListener('install', e => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.t === 'mf') manifest = String(m.text || '');
  else if (m.t === 'seg') segments.set(String(m.name), m.buf);
  else if (m.t === 'clear') { segments.clear(); manifest = ''; }
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (!url.pathname.endsWith('/lab-hls/live.m3u8') &&
      !url.pathname.includes('/lab-hls/')) return; // 其余请求走网络
  e.respondWith((async () => {
    const name = url.pathname.split('/lab-hls/')[1] || '';
    if (name === MANIFEST_NAME) {
      if (!manifest) return new Response('#EXTM3U\n#EXT-X-ENDLIST\n', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' } });
      return new Response(manifest, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' } });
    }
    const buf = segments.get(name);
    if (!buf) return new Response('segment not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    return new Response(buf, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } });
  })());
});
