// Service Worker для потокового сохранения больших файлов на диск.
// Страница передаёт сюда куски файла через MessageChannel, а браузер
// получает их как обычную загрузку (attachment) и пишет прямо на диск,
// не накапливая весь файл в памяти.

const jobs = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'prepare' && e.ports && e.ports[0]) {
    jobs.set(d.id, { name: d.name, size: d.size, port: e.ports[0] });
    e.ports[0].postMessage('ready');
  }
});

function contentDisposition(name) {
  const safe = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return "attachment; filename*=UTF-8''" + safe;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const m = url.pathname.match(/\/__dl\/([^/]+)$/);
  if (!m) return;

  const job = jobs.get(m[1]);
  if (!job) {
    e.respondWith(new Response('Not found', { status: 404 }));
    return;
  }
  jobs.delete(m[1]);

  const stream = new ReadableStream({
    start(controller) {
      job.port.onmessage = (ev) => {
        const d = ev.data;
        try {
          if (d instanceof ArrayBuffer) {
            controller.enqueue(new Uint8Array(d));
          } else if (d && d.type === 'end') {
            controller.close();
          } else if (d && d.type === 'abort') {
            controller.error(new Error('aborted'));
          }
          // 'ping' — просто поддерживает жизнь воркера
        } catch (_) { /* поток уже закрыт */ }
      };
    },
    cancel() {
      // пользователь отменил загрузку в менеджере загрузок браузера
      try { job.port.postMessage({ type: 'cancelled' }); } catch (_) {}
    },
  });

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(job.name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (job.size > 0) headers['Content-Length'] = String(job.size);

  e.respondWith(new Response(stream, { headers }));
});
