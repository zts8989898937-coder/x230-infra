'use strict';

const http = require('http');
const { getLiveQuota, startTrafficStream } = require('./quota');

const HOST = '127.0.0.1';
const PORT = Number(process.env.QUOTA_LIVE_PORT || 3903);

startTrafficStream();
// Warm initial cache without blocking daemon startup
Promise.resolve(getLiveQuota({ force: false })).catch(() => {});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const body = JSON.stringify({ ok: true, ts: new Date().toISOString() });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/live') {
    const force = url.searchParams.get('force') === '1';
    try {
      const data = await getLiveQuota({ force });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : 'live quota error' }));
    }
    return;
  }

  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end('{"ok":false,"error":"not found"}');
});

server.listen(PORT, HOST, () => {
  console.log(`[quota-live] listening on http://${HOST}:${PORT}`);
});
