'use strict';

const http = require('http');
const { requestTarget } = require('./request-policy');
const { getLiveQuota, startTrafficStream } = require('./quota');

const HOST = '127.0.0.1';
const PORT = Number(process.env.QUOTA_LIVE_PORT || 3903);

startTrafficStream();
// Warm initial cache without blocking daemon startup, and keep quota fresh in background
Promise.resolve(getLiveQuota({ force: false })).catch(() => {});
setInterval(() => {
  Promise.resolve(getLiveQuota({ force: false })).catch(() => {});
}, 60 * 1000);

const server = http.createServer({ headersTimeout: 10000 }, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = requestTarget(req.url);
  // The HK PHP backend and local health checks use loopback HTTP. This port has no browser API.
  if (!url || !/^(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/.test(req.headers.host || '') ||
      req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
    res.writeHead(403);
    return res.end('{"ok":false,"error":"untrusted request"}');
  }

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
      res.end(JSON.stringify({ ok: false, error: 'live quota error' }));
    }
    return;
  }

  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end('{"ok":false,"error":"not found"}');
});

server.maxConnections = 32;
server.listen(PORT, HOST, () => {
  console.log(`[quota-live] listening on http://${HOST}:${PORT}`);
});
