'use strict';

const { isIP } = require('node:net');

const SESSION_RE = /^[a-zA-Z0-9_-]{1,120}$/;
const isLoopback = ip => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip === '::1';
const validSession = id => typeof id === 'string' && SESSION_RE.test(id);

function requestTarget(raw) {
  // Keep the same path at both hops. Do not reinterpret absolute-form URLs,
  // encoded separators, repeated slashes or dot segments at the proxy.
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('#')) return null;
  const rawPath = raw.split('?', 1)[0];
  if (rawPath.includes('\\') || rawPath.includes('//')) return null;
  try {
    for (const segment of rawPath.split('/')) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || /[\\/\x00-\x1f\x7f]/.test(decoded)) return null;
    }
    return new URL(raw, 'http://webterm.invalid');
  } catch {
    return null;
  }
}

function clientIp(req) {
  const remote = req.socket.remoteAddress;
  const forwarded = req.headers['x-real-ip'];
  return (isLoopback(remote) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote) || 'unknown';
}

function requestOrigin(req, configuredOrigins, port) {
  const forwardedHttps = isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https';
  const origin = (req.socket.encrypted || forwardedHttps ? 'https://' : 'http://') + req.headers.host;
  if (configuredOrigins.has(origin)) return origin;
  if (!forwardedHttps && !req.socket.encrypted) {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      if (origin === 'http://' + host + ':' + port) return origin;
    }
  }
  return null;
}

function allowsSource(req, origin, basic, upgrade = false) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (req.headers.origin !== undefined) return req.headers.origin === origin;
  if (upgrade) return false;
  if (site === 'same-origin') return true;
  if (req.headers.referer) {
    try { return new URL(req.headers.referer).origin === origin; } catch { return false; }
  }
  return basic && req.headers['x-webterm-request'] === '1';
}

function validTtyTarget(url, upgrade) {
  if (upgrade ? url.pathname !== '/tty/ws' : !['/tty', '/tty/', '/tty/token'].includes(url.pathname)) return false;
  const args = url.searchParams.getAll('arg');
  return args.length === 0 || (args.length === 1 && validSession(args[0]));
}

module.exports = { allowsSource, clientIp, requestOrigin, requestTarget, validSession, validTtyTarget };
