const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { parseTerminalHistory, parseNativeMenu } = require('./history-parser');
const readCodexHistory = require('./codex-history').createCodexHistoryReader();

const { loadConfig, readPrivateConfig } = require('./runtime-config');
const { allowsSource, clientIp, requestOrigin, requestTarget, validSession, validTtyTarget } = require('./request-policy');

const PORT = Number(process.env.WEBTERM_PORT ?? 3902);
const TTY_HOST = '127.0.0.1', TTY_PORT = Number(process.env.WEBTERM_TTY_PORT ?? 3901);
const PASS = process.env.WEBTERM_PASS || '<REDACTED_SEE_SECRETS>';
const privateConfig = readPrivateConfig();
const { user: USER, password, host } = loadConfig({
  ...process.env,
  WEBTERM_PASS: PASS === '<REDACTED_SEE_SECRETS>' ? undefined : PASS
}, privateConfig);
const origins = new Set(process.env.WEBTERM_ORIGINS?.split(',') || privateConfig.origins || []);
const AUTH_BUF = Buffer.from('Basic ' + Buffer.from(USER + ':' + password).toString('base64'));
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');
const PASTE_DIR = path.join(os.homedir(), 'agent-share', 'pastes');
const UPLOAD_DIR = path.join(os.homedir(), 'agent-share', 'uploads');
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const WALL_DIR = path.join(os.homedir(), 'Pictures', 'Wallpapers');
const MAX_WALL_BYTES = 8 * 1024 * 1024;
const WALL_EXTS = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const WALL_PRIORITY = ['anime_car_sunset.webp', 'arknights_frostleaf.webp', 'pixel_girl_starry_night.webp', 'anime_station_train_girl.webp', 'blue_night_fishbowl.webp'];
const wallMemCache = new Map();

const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUTH_FAIL_MAX = 15;
const AUTH_LOCK_MS = 15 * 60 * 1000;
const authFailures = new Map();

function authLocked(ip) {
  const rec = authFailures.get(ip);
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  if (Date.now() - rec.first > AUTH_FAIL_WINDOW_MS && (!rec.until || rec.until <= Date.now())) {
    authFailures.delete(ip);
    return false;
  }
  return false;
}

function noteAuthFail(ip) {
  const now = Date.now();
  let rec = authFailures.get(ip);
  if (!rec || now - rec.first > AUTH_FAIL_WINDOW_MS) rec = { count: 0, first: now, until: 0 };
  rec.count++;
  if (rec.count >= AUTH_FAIL_MAX) rec.until = now + AUTH_LOCK_MS;
  if (!authFailures.has(ip) && authFailures.size >= 4096) authFailures.delete(authFailures.keys().next().value);
  authFailures.set(ip, rec);
}

const AUTH_COOKIE_NAME = 'wt_auth';
const AUTH_COOKIE_MAX_AGE_SEC = 30 * 24 * 3600;
const configuredCookieKey = process.env.WEBTERM_COOKIE_KEY || privateConfig.cookieKey;
if (configuredCookieKey !== undefined && !/^[a-fA-F0-9]{64}$/.test(configuredCookieKey)) {
  throw new Error('WEBTERM_COOKIE_KEY must contain 64 hexadecimal characters.');
}
const AUTH_COOKIE_SECRET = configuredCookieKey ? Buffer.from(configuredCookieKey, 'hex') : crypto.randomBytes(32);

function signAuthCookie(ts) {
  const payload = String(ts);
  const sig = crypto.createHmac('sha256', AUTH_COOKIE_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function parseCookie(header, name) {
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return '';
}

function okBasic(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return false;
  const b = Buffer.from(h);
  if (b.length !== AUTH_BUF.length) return false;
  return crypto.timingSafeEqual(b, AUTH_BUF);
}

function okCookie(req) {
  const val = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
  if (!val) return false;
  const dot = val.indexOf('.');
  if (dot <= 0) return false;
  const tsStr = val.slice(0, dot);
  const ts = Number(tsStr);
  if (!/^\d{13}$/.test(tsStr) || ts <= 0) return false;
  const ageSec = (Date.now() - ts) / 1000;
  if (ageSec < -300 || ageSec > AUTH_COOKIE_MAX_AGE_SEC) return false;
  const expected = signAuthCookie(tsStr);
  const a = Buffer.from(val);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeAuthCookie(origin) {
  const isHttps = origin.startsWith('https:');
  return (
    AUTH_COOKIE_NAME + '=' + signAuthCookie(Date.now()) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + AUTH_COOKIE_MAX_AGE_SEC +
    (isHttps ? '; Secure' : '')
  );
}

function authorize(req) {
  const ip = clientIp(req);
  const basic = okBasic(req);
  const cookie = okCookie(req);
  // Invalid attempts never lock out a correctly authenticated client.
  if (basic || cookie) return { basic, cookie };
  if (authLocked(ip)) return { status: 429 };
  noteAuthFail(ip);
  return { status: 401 };
}

const sseClients = new Set();
const MAX_EVENT_CLIENTS = 32;
let indexVer = '';
let lastMtime = 0;

function calcVer(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

function refreshIndexVer(notify = true) {
  try {
    const st = fs.statSync(INDEX_PATH);
    if (st.size === 0) return;
    if (notify && st.mtimeMs === lastMtime && indexVer) return;
    const buf = fs.readFileSync(INDEX_PATH);
    if (!buf.length) return;
    const next = calcVer(Buffer.concat([buf, Buffer.from(TTY_PATCH_SNIPPET)]));
    lastMtime = st.mtimeMs;
    if (next !== indexVer) {
      indexVer = next;
      if (notify) {
        const msg = 'data: ' + indexVer + '\n\n';
        for (const res of sseClients) {
          if (!res.writableNeedDrain) res.write(msg);
        }
      }
    }
  } catch (e) {}
}

let watchTimer = null;
try {
  const indexWatcher = fs.watch(ROOT, (_, name) => {
    if (name && name !== 'index.html') return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => refreshIndexVer(true), 80);
  });
  indexWatcher.on('error', () => indexWatcher.close());
} catch (e) {}
setInterval(() => refreshIndexVer(true), 2000).unref();
setInterval(() => {
  for (const res of sseClients) {
    if (!res.writableNeedDrain) res.write(': ping\n\n');
  }
}, 25000).unref();

let indexHtmlCache = { ver: '', rawBuf: null, gzBuf: null };
function serveIndex(req, res) {
  const sendCached = entry => {
    const useGzip = Boolean(entry.gzBuf && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || '')));
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Vary': 'Accept-Encoding'
    };
    if (useGzip) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(useGzip ? entry.gzBuf : entry.rawBuf);
  };
  if (indexVer && indexHtmlCache.ver === indexVer && indexHtmlCache.rawBuf) {
    return sendCached(indexHtmlCache);
  }
  fs.readFile(INDEX_PATH, 'utf8', (e, html) => {
    if (e) { res.writeHead(500); return res.end('index missing'); }
    const ver = calcVer(Buffer.concat([Buffer.from(html), Buffer.from(TTY_PATCH_SNIPPET)]));
    indexVer = ver;
    const body = html.replace('</head>', '<meta name="wt-ver" content="' + ver + '">\n</head>');
    const rawBuf = Buffer.from(body, 'utf8');
    let gzBuf = null;
    try { gzBuf = zlib.gzipSync(rawBuf, { level: 6 }); } catch (err) {}
    indexHtmlCache = { ver, rawBuf, gzBuf };
    sendCached(indexHtmlCache);
  });
}

function handleEvents(req, res) {
  if (sseClients.size >= MAX_EVENT_CLIENTS) return sendJson(res, 503, { error: 'too many event streams' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 1500\n');
  res.write('data: ' + indexVer + '\n\n');
  sseClients.add(res);
  res.once('close', () => sseClients.delete(res));
}

const TTY_THEME_STYLE = '<style id="wt-tokyo-style">html,body,.terminal,.xterm,.xterm-viewport,.xterm-screen{background:transparent!important;background-color:transparent!important}</style>';
const TTY_PATCH_SNIPPET = TTY_THEME_STYLE + '<script>(function(){function isVis(){return !document.hidden&&window.innerWidth>=100&&window.innerHeight>=60;}var NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.__wtSocket=this;window.__wtClosedAt=0;this.addEventListener("close",function(){window.__wtClosedAt=Date.now();});}send(data){try{if(!isVis()){var txt="";if(typeof data==="string"&&data[0]==="1")txt=data.slice(1);else if(data instanceof Uint8Array&&data[0]===49)txt=new TextDecoder().decode(data.subarray(1));else if(data instanceof ArrayBuffer){var u=new Uint8Array(data);if(u[0]===49)txt=new TextDecoder().decode(u.subarray(1));}if(txt){var r=JSON.parse(txt);if(r&&((r.columns|0)<20||(r.rows|0)<4))return;}}}catch(e){}return super.send(data);}};document.addEventListener("click",function(e){var el=e.target;if(el&&el.textContent&&el.textContent.indexOf("Reconnect")!==-1){location.reload();}},true);document.addEventListener("visibilitychange",function(){if(isVis()&&window.__wtSocket&&window.__wtSocket.readyState>=2){location.reload();}});window.addEventListener("pageshow",function(){if(isVis()&&window.__wtSocket&&window.__wtSocket.readyState>=2){location.reload();}});var TOKYO={background:"rgba(0,0,0,0)",foreground:"#f1ece3",cursor:"#ee9833",cursorAccent:"#0a0a0c",selectionBackground:"rgba(238,152,51,0.28)",black:"#0a0a0c",red:"#e2708f",green:"#98b88c",yellow:"#ee9833",blue:"#83b8ca",magenta:"#b8a1c9",cyan:"#cbb38f",white:"#d8d2c7",brightBlack:"#5b6064",brightRed:"#e2708f",brightGreen:"#98b88c",brightYellow:"#ee9833",brightBlue:"#83b8ca",brightMagenta:"#b8a1c9",brightCyan:"#cbb38f",brightWhite:"#f1ece3"};var o=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(t,l,p){if(t==="beforeunload")return;return o.call(this,t,l,p);};var jp=JSON.parse;JSON.parse=function(s,r){var v=jp.call(this,s,r);if(v&&typeof v==="object"&&!Array.isArray(v)&&("rendererType" in v||"disableLeaveAlert" in v)){v.rendererType="dom";v.scrollback=600;v.disableLeaveAlert=true;v.macOptionClickForcesSelection=true;v.macOptionIsMeta=true;v.allowTransparency=true;v.theme=TOKYO;}return v;};function cleanTxt(txt){return String(txt||"").replace(/[ \\t]+(?=\\r?\\n|$)/g,"");}function copyFallback(txt,silent){txt=cleanTxt(txt);if(!txt)return false;var ok=false;try{var ta=document.createElement("textarea");ta.value=txt;ta.setAttribute("readonly","");ta.style.cssText="position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";document.body.appendChild(ta);ta.focus({preventScroll:true});ta.select();ta.setSelectionRange(0,txt.length);ok=document.execCommand("copy");document.body.removeChild(ta);}catch(e){}try{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt).catch(function(){});}catch(e){}try{if(window.term&&window.term.focus)window.term.focus();}catch(e){}if(ok&&!silent){try{if(window.parent&&window.parent.wtNotifyCopy)window.parent.wtNotifyCopy(txt.length);}catch(e){}}return ok;}window.__wtCopyText=copyFallback;var pt=setInterval(function(){var t=window.term;if(t&&t.options){t.options.allowTransparency=true;t.options.macOptionIsMeta=true;t.options.theme=TOKYO;}var ss=t&&t._core&&t._core._selectionService;if(ss){if(!ss.__wtPatched){ss.__wtPatched=true;ss.shouldForceSelection=function(e){return !e.ctrlKey;};}clearInterval(pt);}},50);setTimeout(function(){clearInterval(pt);},15000);document.addEventListener("copy",function(e){var t=window.term;if(t&&t.hasSelection&&t.hasSelection()){var txt=cleanTxt(t.getSelection());if(txt&&e.clipboardData){e.clipboardData.setData("text/plain",txt);e.preventDefault();try{if(window.parent&&window.parent.wtNotifyCopy)window.parent.wtNotifyCopy(txt.length);}catch(err){}}}},true);window.addEventListener("mouseup",function(e){if(e.button!==0||e.ctrlKey)return;var t=window.term;if(t&&t.hasSelection&&t.hasSelection()){var txt=t.getSelection();if(txt)copyFallback(txt,false);}});window.addEventListener("keydown",function(e){var isC=(e.code==="KeyC"||(e.key&&e.key.toLowerCase()==="c"));var isCopy=((e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey)||(e.ctrlKey&&e.shiftKey&&!e.metaKey&&!e.altKey))&&isC;if(!isCopy)return;var t=window.term;if(t&&t.hasSelection&&t.hasSelection()){var txt=t.getSelection();if(txt){copyFallback(txt,false);e.preventDefault();e.stopPropagation();}}},true);})();</script>';

refreshIndexVer(false);

const ttyHeaders = ['accept', 'accept-encoding', 'accept-language', 'user-agent',
  'origin', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version',
  'sec-websocket-protocol', 'sec-websocket-extensions'];

function proxyHttp(req, res) {
  const headers = Object.fromEntries(ttyHeaders.filter(key => req.headers[key]).map(key => [key, req.headers[key]]));
  headers['x-auth-user'] = USER;
  headers['host'] = TTY_HOST + ':' + TTY_PORT;
  const isTtyHtml = req.url.split('?')[0] !== '/tty/token';
  if (isTtyHtml) headers['accept-encoding'] = 'identity';
  const up = http.request({ host: TTY_HOST, port: TTY_PORT, path: req.url, method: req.method, headers }, r => {
    delete r.headers['set-cookie'];
    r.headers['cache-control'] = 'no-store';
    r.on('error', () => res.destroy());
    const ct = (r.headers['content-type'] || '');
    const ce = (r.headers['content-encoding'] || '');
    if (isTtyHtml && r.statusCode === 200 && ct.includes('text/html') && !ce) {
      const chunks = [];
      let bytes = 0;
      r.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) return up.destroy(new Error('ttyd response too large'));
        chunks.push(chunk);
      });
      r.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8').replace('<head>', '<head>' + TTY_PATCH_SNIPPET);
        const outHeaders = Object.assign({}, r.headers);
        delete outHeaders['content-length'];
        outHeaders['cache-control'] = 'no-store';
        res.writeHead(r.statusCode, outHeaders);
        res.end(html);
      });
      return;
    }
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    if (!res.writableEnded) res.end('upstream down');
  });
  up.setTimeout(10000, () => up.destroy(new Error('ttyd request timed out')));
  res.once('close', () => up.destroy());
  up.end();
}

function sanitizeUploadName(raw) {
  let base = path.basename(String(raw || '').replace(/\\/g, '/'));
  base = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '');
  if (!base || base === '.' || base === '..') return 'upload-' + Date.now();
  while (Buffer.byteLength(base) > 200) base = base.slice(0, -1);
  return base;
}

const MAX_FILE_WRITES = 4;
let activeFileWrites = 0;

function storeBody(req, res, dir, name, session, maxBytes, onSaved) {
  if (Number(req.headers['content-length']) > maxBytes) {
    res.setHeader('Connection', 'close');
    return sendJson(res, 413, { ok: false, error: 'payload too large' });
  }
  if (activeFileWrites >= MAX_FILE_WRITES) {
    res.setHeader('Connection', 'close');
    return sendJson(res, 503, { ok: false, error: 'too many uploads' });
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(path.dirname(dir)) !== path.dirname(dir) ||
        fs.realpathSync(dir) !== dir || !fs.lstatSync(dir).isDirectory()) throw new Error('unsafe directory');
  } catch {
    return sendJson(res, 500, { ok: false, error: 'storage unavailable' });
  }

  const temp = path.join(dir, '.part-' + crypto.randomUUID());
  const stream = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
  activeFileWrites++;
  let opened = false;
  let bytes = 0;
  let settled = false;
  const timer = setTimeout(() => fail(408, 'upload timed out'), 5 * 60 * 1000);
  const fail = (status, error) => {
    if (settled) return;
    settled = true;
    req.unpipe(stream);
    stream.destroy();
    if (!res.destroyed && !res.writableEnded) {
      res.setHeader('Connection', 'close');
      sendJson(res, status, { ok: false, error });
    }
  };
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) fail(413, 'payload too large');
  });
  req.once('aborted', () => fail(400, 'upload interrupted'));
  req.once('error', () => fail(400, 'upload interrupted'));
  res.once('close', () => fail(400, 'upload interrupted'));
  stream.once('open', () => { opened = true; });
  stream.once('error', () => fail(500, 'upload write failed'));
  stream.once('close', () => {
    clearTimeout(timer);
    activeFileWrites--;
    try {
      if (settled) return;
      if (!bytes) return fail(400, 'empty file');
      let finalName = name;
      for (let i = 0; ; i++) {
        try {
          fs.linkSync(temp, path.join(dir, finalName));
          break;
        } catch (err) {
          if (err.code !== 'EEXIST' || i >= 3) throw err;
          const ext = path.extname(name);
          finalName = name.slice(0, name.length - ext.length) + '-' + crypto.randomBytes(6).toString('hex') + ext;
        }
      }
      settled = true;
      sendJson(res, 200, { ok: true, path: path.join(dir, finalName), name: finalName, session, bytes });
      onSaved?.();
    } catch {
      fail(500, 'upload write failed');
    } finally {
      if (opened) {
        try { fs.unlinkSync(temp); } catch {}
      }
    }
  });
  req.pipe(stream);
}

function handleUpload(req, res) {
  const url = new URL(req.url, 'http://x');
  const session = url.searchParams.get('s') || '';
  if (session && !validSession(session)) return sendJson(res, 400, { ok: false, error: 'invalid session' });
  let rawName = url.searchParams.get('name') || '';
  if (!rawName && req.headers['x-file-name']) {
    try { rawName = decodeURIComponent(req.headers['x-file-name']); } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid file name' });
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  storeBody(req, res, path.join(UPLOAD_DIR, day), sanitizeUploadName(rawName), session, MAX_UPLOAD_BYTES);
}

function handlePaste(req, res) {
  const url = new URL(req.url, 'http://x');
  const session = url.searchParams.get('s') || '';
  if (session && !validSession(session)) return sendJson(res, 400, { ok: false, error: 'invalid session' });
  const mime = (req.headers['content-type'] || 'image/png').split(';')[0].toLowerCase();
  const formats = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);
  const ext = formats.get(mime);
  if (!ext) return sendJson(res, 415, { ok: false, error: 'unsupported image type' });
  const day = new Date().toISOString().slice(0, 10);
  const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;
  storeBody(req, res, path.join(PASTE_DIR, day), name, session, 25 * 1024 * 1024, prune);
}

let lastPrune = 0;
async function prune() {
  const now = Date.now();
  if (now - lastPrune < 60 * 60 * 1000) return;
  lastPrune = now;
  const cutoff = now - 7 * 24 * 3600 * 1000;
  try {
    for await (const day of await fs.promises.opendir(PASTE_DIR)) {
      if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
      const dir = path.join(PASTE_DIR, day.name);
      for await (const entry of await fs.promises.opendir(dir)) {
        if (!entry.isFile()) continue;
        const fp = path.join(dir, entry.name);
        try { if ((await fs.promises.lstat(fp)).mtimeMs < cutoff) await fs.promises.unlink(fp); } catch {}
      }
    }
  } catch {}
}

function handleClose(req, res) {
  const sess = new URL(req.url, 'http://x').searchParams.get('s');
  if (!validSession(sess)) return sendJson(res, 400, { error: 'invalid session' });
  execFile('/usr/bin/tmux', ['-L', 'wt', 'kill-session', '-t', '=wt-' + sess], { timeout: 1200 }, err => {
    if (err) return sendJson(res, 404, { error: 'session not available' });
    sendJson(res, 200, { killed: sess });
  });
}

const terminalSendQueues = new Map();

function enqueueTerminalSend(target, res, run, finish) {
  let queue = terminalSendQueues.get(target);
  if (!queue) {
    if (terminalSendQueues.size >= 16) return sendJson(res, 503, { ok: false, error: 'terminal input busy' });
    queue = [];
    terminalSendQueues.set(target, queue);
  }
  if (queue.length >= 8) {
    return sendJson(res, 429, {ok: false, error: 'terminal input queue is busy'});
  }

  function next() {
    queue.shift();
    if (queue.length) queue[0]();
    else terminalSendQueues.delete(target);
  }

  queue.push(() => {
    if (res.destroyed) return next();
    const complete = err => {
      try { if (!res.destroyed) finish(err); }
      finally { next(); }
    };
    try { run(complete); } catch (err) { complete(err); }
  });
  if (queue.length === 1) queue[0]();
}

let sendSeq = 0;
function tmuxPasteText(target, text, cb) {
  const bufName = 'wt_send_' + process.pid + '_' + (++sendSeq);
  const loader = spawn('/usr/bin/tmux', ['-L', 'wt', 'load-buffer', '-b', bufName, '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let errOut = '';
  loader.stderr.on('data', d => { if (errOut.length < 4096) errOut += d.toString().slice(0, 4096 - errOut.length); });
  let loadError;
  const loadTimeout = setTimeout(() => loader.kill(), 3000);
  loader.on('error', err => { loadError = err; });
  loader.stdin.on('error', err => { loadError = err; });
  loader.on('close', code => {
    clearTimeout(loadTimeout);
    if (code !== 0) return cb(loadError || new Error(errOut.trim() || ('tmux load-buffer exit ' + code)));
    execFile(
      '/usr/bin/tmux',
      ['-L', 'wt', 'paste-buffer', '-p', '-r', '-d', '-b', bufName, '-t', target],
      { timeout: 3000 },
      (err2) => {
        if (err2) {
          execFile('/usr/bin/tmux', ['-L', 'wt', 'delete-buffer', '-b', bufName], { timeout: 1200 }, () => {});
          return cb(err2);
        }
        setTimeout(() => {
          execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, 'Enter'], { timeout: 3000 }, cb);
        }, 70);
      }
    );
  });
  loader.stdin.end(Buffer.from(text, 'utf8'));
}

function handleScreen(req, res) {
  const sess = new URL(req.url, 'http://x').searchParams.get('s') || '';
  if (!validSession(sess)) return sendJson(res, 400, {error:'invalid session'});
  execFile('/usr/bin/tmux', ['-L','wt','display-message','-t','=wt-'+sess+':','-p','__WT_META__\t#{pane_current_command}\t#{pane_title}', ';','capture-pane','-t','=wt-' + sess + ':','-e','-p','-J'], {timeout:2000,maxBuffer:1024*1024}, (err, text) => {
    if (err) return sendJson(res, 404, {error:'session not available'});
    const raw=String(text || ''), nl=raw.indexOf('\n');
    const metaLine = nl >= 0 ? raw.slice(0, nl) : raw;
    const [cmd,title]=metaLine.replace('__WT_META__\t','').split('\t');
    const screen=(nl >= 0 ? raw.slice(nl+1) : '').trimEnd(), parsed=parseTerminalHistory(screen,cmd,{paneTitle:title}), agent=detectActiveAgent(cmd,title)||parsed.agent;
    sendJson(res, 200, {text:screen, menuActive:parsed.menuActive, menuCloseKey:parsed.menuCloseKey||'\x1b', nativeMenu:parseNativeMenu(screen,agent)});
  });
}

function handleSend(req, res) {
  const maxBytes = 512 * 1024;
  if (Number(req.headers['content-length']) > maxBytes) {
    res.setHeader('Connection', 'close');
    return sendJson(res, 413, { ok: false, error: 'payload too large' });
  }
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return sendJson(res, 415, { ok: false, error: 'expected application/json' });
  }
  req.once('error', () => res.destroy());
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', c => {
    if (aborted) return;
    size += c.length;
    if (size > maxBytes) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
    }
    const sess = body?.s;
    if (!validSession(sess) || (body.raw !== undefined && typeof body.raw !== 'string') ||
        (body.text !== undefined && typeof body.text !== 'string')) {
      return sendJson(res, 400, { ok: false, error: 'invalid terminal input' });
    }
    if (typeof body.raw === 'string' && Buffer.byteLength(body.raw) > 4096) {
      return sendJson(res, 413, { ok: false, error: 'raw terminal input too large' });
    }
    const target = '=wt-' + sess + ':';
    const pokeWatcher = () => {
      const w = sessionWatchers.get(sess);
      if (w) {
        w.poke();
        setTimeout(() => w.poke(), 120);
      }
    };
    const finish = (err) => {
      if (err) {
        const msg = err.message || String(err);
        const notFound = /can't find|session not found|no server running/i.test(msg);
        res.writeHead(notFound ? 404 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: notFound ? 'session not available' : 'terminal input failed' }));
      }
      pokeWatcher();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    };

    enqueueTerminalSend(target, res, complete => {
      if (body && typeof body.raw === 'string' && body.raw.length) {
        if (body.raw === '\x1b') {
          return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, 'Escape'], { timeout: 3000 }, complete);
        }
        if (body.raw === '\x03') {
          return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, 'C-c'], { timeout: 3000 }, complete);
        }
        const hex = Array.from(Buffer.from(body.raw, 'utf8')).map(b => b.toString(16).padStart(2, '0'));
        return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, '-H', ...hex], { timeout: 3000 }, complete);
      }

      const text = String((body && body.text) || '').replace(/\r\n?/g, '\n');
      if (!text) {
        return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, 'Enter'], { timeout: 3000 }, complete);
      }
      tmuxPasteText(target, text, complete);
    }, finish);
  });
}

const sessionBannerCache = new Map();
const captureInFlight = new Map();
const META_PREFIX = '__WT_META__\t';
const AGENT_CMD_NAMES = ['agy', 'codex', 'claude', 'opencode', 'hermes', 'kimi', 'gemini', 'aider', 'goose', 'qwen', 'amp', 'droid'];
const SHELL_CMD_SET = new Set(['fish', 'bash', 'zsh', 'sh', 'dash', 'tcsh', 'csh', 'tmux']);

function detectActiveAgent(cmd, paneTitle) {
  const rawCmd = String(cmd || '').trim().toLowerCase();
  if (!rawCmd || SHELL_CMD_SET.has(rawCmd)) return '';
  for (const name of AGENT_CMD_NAMES) {
    if (rawCmd === name || rawCmd.startsWith(name + '-') || rawCmd.startsWith(name + '.')) return name;
  }
  const title = String(paneTitle || '').trim();
  if (!title) return '';
  if (/claude\s*code|\bclaude\b/i.test(title)) return 'claude';
  if (/openai\s*codex|\bcodex\b/i.test(title)) return 'codex';
  if (/antigravity|\bagy\b/i.test(title)) return 'agy';
  if (/\bopencode\b/i.test(title)) return 'opencode';
  if (/hermes\s*agent/i.test(title)) return 'hermes';
  if (/\bkimi\b/i.test(title)) return 'kimi';
  if (/gemini\s*cli/i.test(title)) return 'gemini';
  if (/^\d+\.\d+\.\d+$/.test(rawCmd) && /^[✳✶✻✽✢⠂⠄⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/.test(title)) return 'claude';
  return '';
}

function captureSessionHistory(sess, cb) {
  const waiting = captureInFlight.get(sess);
  if (waiting?.length >= 32 || (!waiting && captureInFlight.size >= 6)) {
    return queueMicrotask(() => cb({ status: 503, error: 'history capture busy' }));
  }
  if (waiting) { waiting.push(cb); return; }
  const callbacks = [cb];
  captureInFlight.set(sess, callbacks);
  const done = (err, payload) => {
    captureInFlight.delete(sess);
    for (const callback of callbacks) callback(err, payload && { ...payload });
  };
  const target = '=wt-' + sess + ':';
  execFile(
    '/usr/bin/tmux',
    ['-L', 'wt', 'display-message', '-t', target, '-p', '__WT_META__\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}', ';', 'capture-pane', '-t', target, '-e', '-p', '-J', '-S', '-'],
    { maxBuffer: 8 * 1024 * 1024, timeout: 3000 },
    (err, out) => {
      if (err) {
        const msg = err.message || '';
        const notFound = /can't find|session not found|no server running/i.test(msg);
        return done({ status: notFound ? 404 : 500, error: notFound ? 'session not found' : 'history capture failed' });
      }
      const parseCapture = async () => {
        const raw = out || '';
        let cmd = '', paneTitle = '', panePath = '', capOut = raw;
        if (raw.startsWith(META_PREFIX)) {
          const nl = raw.indexOf('\n');
          const metaLine = (nl === -1 ? raw : raw.slice(0, nl)).slice(META_PREFIX.length);
          const parts = metaLine.split('\t');
          cmd = (parts[0] || '').trim();
          paneTitle = (parts[1] || '').trim();
          panePath = (parts[2] || '').trim();
          capOut = nl === -1 ? '' : raw.slice(nl + 1);
        }
        const parsed = parseTerminalHistory(capOut, cmd, { paneTitle, panePath });
        const runningAgent = detectActiveAgent(cmd, paneTitle);
        const cacheKey = target + ':' + (parsed.agent || cmd);
        if (parsed.bannerCaptured && parsed.banner) {
          if (sessionBannerCache.size >= 64) sessionBannerCache.delete(sessionBannerCache.keys().next().value);
          if (parsed.banner.length + (parsed.bannerAnsi || '').length <= 32768) {
            sessionBannerCache.set(cacheKey, { banner: parsed.banner, bannerAnsi: parsed.bannerAnsi });
          }
        } else if (parsed.agent && sessionBannerCache.has(cacheKey)) {
          const cached = sessionBannerCache.get(cacheKey);
          parsed.banner = cached.banner;
          parsed.bannerAnsi = cached.bannerAnsi;
          parsed.bannerCaptured = true;
        }
        const payload = { sess, cmd, runningAgent, ...parsed, historySource: 'terminal' };
        if (runningAgent === 'codex') {
          const native = await readCodexHistory(paneTitle, panePath, parsed.turns);
          if (native) {
            payload.turns = native.turns;
            payload.historySource = 'codex-rollout';
            payload.threadId = native.threadId;
            if (!payload.model && native.model) payload.model = [native.model, native.effort].filter(Boolean).join(' ');
          }
        }
        return payload;
      };
      parseCapture().then(payload => done(null, payload),
        () => done({ status: 500, error: 'history parse failed' }));
    }
  );
}

let cmdsCache = { ts: 0, data: { cmds: {}, agents: {}, paths: {} } };
function listSessionCommands(cb) {
  const now = Date.now();
  if (now - cmdsCache.ts < 300) return cb(null, cmdsCache.data);
  execFile('/usr/bin/tmux', ['-L', 'wt', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}'], { timeout: 1500 }, (err, out) => {
    if (err) return cb(null, { cmds: {}, agents: {}, paths: {} });
    const cmds = Object.create(null), agents = Object.create(null), paths = Object.create(null);
    for (const line of (out || '').split('\n')) {
      const parts = line.split('\t');
      const name = (parts[0] || '').trim();
      if (!name.startsWith('wt-')) continue;
      const sess = name.slice(3);
      if (!validSession(sess)) continue;
      const cmd = (parts[1] || '').trim();
      const title = (parts[2] || '').trim();
      const cwd = (parts[3] || '').trim();
      cmds[sess] = cmd;
      agents[sess] = detectActiveAgent(cmd, title);
      if (cwd) paths[sess] = cwd;
    }
    const data = { cmds, agents, paths };
    cmdsCache = { ts: Date.now(), data };
    cb(null, data);
  });
}

function resolveSessionPath(sess, cb) {
  if (!sess) return cb(os.homedir());
  execFile('/usr/bin/tmux', ['-L', 'wt', 'display-message', '-t', '=wt-' + sess + ':', '-p', '#{pane_current_path}'], { timeout: 1200 }, (err, out) => {
    const p = !err && out ? out.trim() : '';
    cb(path.isAbsolute(p) ? p : os.homedir());
  });
}

function handleComplete(req, res) {
  const url = new URL(req.url, 'http://x');
  const sess = url.searchParams.get('s') || '';
  if (sess && !validSession(sess)) return sendJson(res, 400, { error: 'invalid session' });
  const rawQuery = String(url.searchParams.get('q') || '').slice(0, 300);
  resolveSessionPath(sess, cwd => {
    const home = os.homedir();
    const hasAt = rawQuery.startsWith('@');
    const q = hasAt ? rawQuery.slice(1) : rawQuery;
    const atPrefix = hasAt ? '@' : '';
    let dirPart = '';
    let basePart = q;
    const slashIdx = q.lastIndexOf('/');
    if (slashIdx !== -1) {
      dirPart = q.slice(0, slashIdx + 1);
      basePart = q.slice(slashIdx + 1);
    }

    let fsDir = cwd;
    if (dirPart) {
      if (dirPart === '~/') fsDir = home;
      else if (dirPart.startsWith('~/')) fsDir = path.resolve(home, dirPart.slice(2));
      else if (dirPart.startsWith('/')) fsDir = path.resolve(dirPart);
      else fsDir = path.resolve(cwd, dirPart);
    } else if (q === '~') {
      return sendJson(res, 200, {
        ok: true,
        cwd,
        items: [{ label: atPrefix + '~/', insert: atPrefix + '~/', kind: 'dir', detail: home }]
      });
    }

    const within = (root, item) => item === root || item.startsWith(root + path.sep);
    let roots, directory;
    try {
      roots = [fs.realpathSync(home)];
      try {
        const sessionRoot = fs.realpathSync(cwd);
        if (sessionRoot !== path.parse(sessionRoot).root) roots.push(sessionRoot);
      } catch {}
      fsDir = fs.realpathSync(fsDir);
      if (!roots.some(root => within(root, fsDir))) return sendJson(res, 200, { ok: true, cwd, items: [] });
      directory = fs.opendirSync(fsDir);
    } catch {
      return sendJson(res, 200, { ok: true, cwd, items: [] });
    }

    const wantHidden = basePart.startsWith('.');
    const needleLower = basePart.toLowerCase();
    const ranked = [];
    try {
      for (let scanned = 0; scanned < 800; scanned++) {
        const ent = directory.readSync();
        if (!ent) break;
        const name = ent.name;
        if (!wantHidden && name.startsWith('.')) continue;
        const lower = name.toLowerCase();
        let rank = 99;
        if (!basePart) rank = 1;
        else if (name.startsWith(basePart)) rank = 0;
        else if (lower.startsWith(needleLower)) rank = 1;
        else if (lower.includes(needleLower)) rank = 2;
        else continue;

        let isDir = ent.isDirectory();
        if (!isDir && ent.isSymbolicLink()) {
          try {
            const resolved = fs.realpathSync(path.join(fsDir, name));
            if (!roots.some(root => within(root, resolved))) continue;
            isDir = fs.statSync(resolved).isDirectory();
          } catch { continue; }
        }
        const suffix = isDir ? '/' : '';
        const relInsert = atPrefix + dirPart + name + suffix;
        ranked.push({
          rank,
          isDir,
          name,
          item: {
            label: name + suffix,
            insert: relInsert,
            kind: isDir ? 'dir' : 'file',
            detail: dirPart ? (atPrefix + dirPart) : cwd
          }
        });
      }
    } catch {
      return sendJson(res, 200, { ok: true, cwd, items: [] });
    } finally {
      directory.closeSync();
    }

    ranked.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    sendJson(res, 200, { ok: true, cwd, items: ranked.slice(0, 18).map(r => r.item) });
  });
}

function sendJson(res, status, obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  if (res._wtAcceptGzip && raw.length >= 1024) {
    return zlib.gzip(raw, { level: 5 }, (err, gz) => {
      if (res.writableEnded || res.destroyed) return;
      if (err) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(raw);
      }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding'
      });
      res.end(gz);
    });
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(raw);
}

function stableHistoryDigest(payload) {
  const visible = [payload.historySource, payload.threadId, payload.cmd, payload.agent, payload.runningAgent,
    payload.menuActive, payload.menuCloseKey, payload.slashOutput, payload.slashOutputAnsi, payload.model, payload.cwd, payload.banner, payload.bannerAnsi,
    payload.bannerCaptured, payload.preamble, payload.preambleAnsi, payload.totalLines, payload.turns];
  return crypto.createHash('sha1').update(JSON.stringify(visible)).digest('hex');
}

function handleHistory(req, res) {
  const url = new URL(req.url, 'http://x');
  const sess = url.searchParams.get('s') || '';
  const isProbe = url.searchParams.get('probe') === '1';
  if (!validSession(sess)) return sendJson(res, 400, { error: 'invalid session' });
  captureSessionHistory(sess, (err, payload) => {
    if (err) {
      if (isProbe && err.status === 404) {
        return sendJson(res, 200, { pending: true, sess, cmd: '', agent: '', turns: [] });
      }
      return sendJson(res, err.status || 500, { error: err.error, sess });
    }
    payload.digest = stableHistoryDigest(payload);
    sendJson(res, 200, payload);
  });
}

const sessionWatchers = new Map();
let historyStreamCount = 0;

function historyBaseKey(payload) {
  const turns = Array.isArray(payload.turns) ? payload.turns : [];
  return crypto.createHash('sha1').update(JSON.stringify([
    payload.historySource, payload.threadId, payload.cmd, payload.agent, payload.runningAgent,
    payload.cwd, payload.banner, payload.bannerAnsi, payload.bannerCaptured,
    payload.preamble, payload.preambleAnsi, turns.length, turns.slice(0, -1)
  ])).digest('hex');
}

function getOrCreateWatcher(sess) {
  let w = sessionWatchers.get(sess);
  if (w) return w;
  w = {
    sess,
    clients: new Set(),
    timer: null,
    inflight: false,
    rerunSoon: false,
    idleCount: 0,
    lastDigest: '',
    lastBaseKey: '',
    lastPayload: null,
    lastEventChunk: '',
    pingTimer: setInterval(() => {
      for (const client of w.clients) {
        if (client.res.writableNeedDrain) continue;
        try { client.res.write('event: heartbeat\ndata: 1\n\n'); } catch (e) { removeClient(w, client); }
      }
    }, 5000)
  };
  if (w.pingTimer.unref) w.pingTimer.unref();

  function removeClient(watcher, client) {
    if (!watcher.clients.delete(client)) return;
    historyStreamCount--;
    if (client.flushTimer) { clearTimeout(client.flushTimer); client.flushTimer = null; }
    if (watcher.clients.size === 0) {
      clearTimeout(watcher.timer);
      clearInterval(watcher.pingTimer);
      sessionWatchers.delete(watcher.sess);
    }
  }

  function writeLatestToClient(client) {
    if (!w.clients.has(client) || client.res.writableNeedDrain || !w.lastPayload || !w.lastDigest) return;
    if (client.lastSentDigest === w.lastDigest) return;
    const p = w.lastPayload;
    const turns = Array.isArray(p.turns) ? p.turns : [];
    const canDelta = Boolean(
      client.allowDelta &&
      client.lastSentBaseKey &&
      client.lastSentBaseKey === w.lastBaseKey &&
      turns.length > 0
    );
    const chunk = canDelta
      ? ('event: hist-tail\ndata: ' + JSON.stringify({
          baseDigest: client.lastSentDigest,
          digest: w.lastDigest,
          totalLines: p.totalLines,
          model: p.model,
          menuActive: p.menuActive,
          menuCloseKey: p.menuCloseKey,
          slashOutput: p.slashOutput,
          slashOutputAnsi: p.slashOutputAnsi,
          turnCount: turns.length,
          turn: turns[turns.length - 1]
        }) + '\n\n')
      : w.lastEventChunk;
    try {
      client.res.write(chunk);
      client.lastSentDigest = w.lastDigest;
      client.lastSentBaseKey = w.lastBaseKey;
      client.lastSentAt = Date.now();
    } catch (e) {
      removeClient(w, client);
    }
  }

  function deliverToClient(client) {
    if (client.lastSentDigest === w.lastDigest) return;
    const wait = client.minPushMs - (Date.now() - (client.lastSentAt || 0));
    if (wait <= 0 || !client.lastSentAt) {
      if (client.flushTimer) { clearTimeout(client.flushTimer); client.flushTimer = null; }
      writeLatestToClient(client);
      return;
    }
    if (!client.flushTimer) {
      client.flushTimer = setTimeout(() => {
        client.flushTimer = null;
        writeLatestToClient(client);
      }, wait);
    }
  }

  function minClientInterval() {
    let minMs = Infinity;
    for (const c of w.clients) {
      if (c.minPushMs < minMs) minMs = c.minPushMs;
    }
    return Number.isFinite(minMs) ? minMs : 220;
  }

  function schedule(ms) {
    if (sessionWatchers.get(sess) !== w) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(tick, ms);
  }

  function tick() {
    if (sessionWatchers.get(sess) !== w) return;
    if (w.inflight) { w.rerunSoon = true; return; }
    w.inflight = true;
    w.rerunSoon = false;
    captureSessionHistory(sess, (err, payload) => {
      w.inflight = false;
      if (sessionWatchers.get(sess) !== w) return;
      if (err) {
        const chunk = 'event: err\ndata: ' + JSON.stringify({ error: err.error, status: err.status }) + '\n\n';
        for (const client of [...w.clients]) {
          if (client.res.writableNeedDrain) continue;
          try { client.res.write(chunk); } catch (e) { removeClient(w, client); }
        }
        return schedule(w.rerunSoon ? 60 : 600);
      }
      const digest = stableHistoryDigest(payload);
      if (digest !== w.lastDigest) {
        payload.digest = digest;
        w.lastDigest = digest;
        w.lastBaseKey = historyBaseKey(payload);
        w.lastPayload = payload;
        w.idleCount = 0;
        w.lastEventChunk = 'event: hist\ndata: ' + JSON.stringify(payload) + '\n\n';
        for (const client of [...w.clients]) {
          deliverToClient(client);
        }
        const activeCadence = minClientInterval();
        return schedule(w.rerunSoon ? 35 : activeCadence);
      }
      if (w.rerunSoon) {
        w.idleCount = 0;
        return schedule(40);
      }
      w.idleCount = Math.min(w.idleCount + 1, 6);
      // Adaptive cadence: LAN 50->220ms; WAN-only watchers relax to 180->460ms at idle.
      const base = minClientInterval();
      schedule(Math.min(base > 100 ? 460 : 220, base + w.idleCount * 45));
    });
  }

  w.removeClient = client => removeClient(w, client);
  w.deliverToClient = deliverToClient;
  w.poke = () => {
    w.idleCount = 0;
    if (w.inflight) { w.rerunSoon = true; return; }
    clearTimeout(w.timer);
    tick();
  };
  sessionWatchers.set(sess, w);
  tick();
  return w;
}

function handleHistoryStream(req, res) {
  const url = new URL(req.url, 'http://x');
  const sess = url.searchParams.get('s') || '';
  if (!validSession(sess)) return sendJson(res, 400, { error: 'invalid session' });
  if (historyStreamCount >= 32 || (!sessionWatchers.has(sess) && sessionWatchers.size >= 12)) {
    return sendJson(res, 503, { error: 'too many history streams' });
  }
  const netParam = String(url.searchParams.get('net') || '').toLowerCase();
  const isForwarded = Boolean(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  const netMode = (netParam === 'lan' || netParam === 'wan' || netParam === 'slow')
    ? netParam
    : (isForwarded ? 'wan' : 'lan');
  const minPushMs = netMode === 'slow' ? 450 : (netMode === 'wan' ? 220 : 50);
  const allowDelta = url.searchParams.get('delta') === '1';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: ' + (netMode === 'lan' ? '500' : '1500') + '\n\n');
  const w = getOrCreateWatcher(sess);
  const client = {
    res,
    minPushMs,
    allowDelta,
    lastSentDigest: '',
    lastSentBaseKey: '',
    lastSentAt: 0,
    flushTimer: null
  };
  w.clients.add(client);
  historyStreamCount++;
  if (w.lastEventChunk && w.lastDigest) {
    w.deliverToClient(client);
  }
  const onDrain = () => w.deliverToClient(client);
  const onClose = () => {
    res.off('drain', onDrain);
    w.removeClient(client);
  };
  res.on('drain', onDrain);
  res.once('close', onClose);
}

function readStr(p, def = '') {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return def; }
}

let prevCpu = null;
function sampleCpuRaw() {
  const line = readStr('/proc/stat', '').split('\n')[0];
  if (!line) return null;
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (nums[3] || 0) + (nums[4] || 0);
  const total = nums.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function getSysStatus() {
  let cur = sampleCpuRaw();
  if (!prevCpu && cur) {
    prevCpu = cur;
    await new Promise(r => setTimeout(r, 120));
    cur = sampleCpuRaw();
  }
  let cpuPct = 0;
  if (prevCpu && cur) {
    const dt = cur.total - prevCpu.total;
    const di = cur.idle - prevCpu.idle;
    if (dt > 0) cpuPct = Math.max(0, Math.min(100, Math.round(1000 * (1 - di / dt)) / 10));
    prevCpu = cur;
  }

  const memMap = {};
  for (const l of readStr('/proc/meminfo', '').split('\n')) {
    const idx = l.indexOf(':');
    if (idx > 0) memMap[l.slice(0, idx).trim()] = parseInt(l.slice(idx + 1), 10) * 1024;
  }
  const memTotal = memMap.MemTotal || 1;
  const memAvail = memMap.MemAvailable || 0;
  const memUsed = Math.max(0, memTotal - memAvail);
  const swapTotal = memMap.SwapTotal || 0;
  const swapFree = memMap.SwapFree || 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);

  const temps = [];
  try {
    for (const d of fs.readdirSync('/sys/class/thermal')) {
      if (!d.startsWith('thermal_zone')) continue;
      const v = parseFloat(readStr('/sys/class/thermal/' + d + '/temp', ''));
      if (Number.isFinite(v)) {
        temps.push({
          name: readStr('/sys/class/thermal/' + d + '/type', d),
          c: Math.round(v / 100) / 10
        });
      }
    }
  } catch (e) {}

  let fanRpm = null;
  try {
    for (const d of fs.readdirSync('/sys/class/hwmon')) {
      if (readStr('/sys/class/hwmon/' + d + '/name', '') === 'thinkpad') {
        const rpm = parseInt(readStr('/sys/class/hwmon/' + d + '/fan1_input', ''), 10);
        if (Number.isFinite(rpm)) fanRpm = rpm;
        break;
      }
    }
  } catch (e) {}

  let disk = null;
  try {
    const st = fs.statfsSync('/');
    const total = st.blocks * st.bsize;
    const avail = st.bavail * st.bsize;
    const used = Math.max(0, total - st.bfree * st.bsize);
    disk = {
      totalGB: Math.round(total / 1073741824 * 10) / 10,
      usedGB: Math.round(used / 1073741824 * 10) / 10,
      availGB: Math.round(avail / 1073741824 * 10) / 10,
      pct: total > 0 ? Math.round(used / total * 1000) / 10 : 0
    };
  } catch (e) {}

  const freqKhz = parseInt(readStr('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', '0'), 10);
  const load = readStr('/proc/loadavg', '0 0 0').split(/\s+/).slice(0, 3).map(Number);
  const uptimeSec = Math.floor(parseFloat(readStr('/proc/uptime', '0').split(/\s+/)[0]) || 0);
  const pkg = temps.find(t => t.name === 'x86_pkg_temp') || temps[0] || null;

  return {
    updatedAt: new Date().toISOString(),
    host: readStr('/proc/sys/kernel/hostname', 'x230'),
    uptimeSec,
    cpu: {
      pct: cpuPct,
      freqMhz: freqKhz > 0 ? Math.round(freqKhz / 1000) : null,
      load
    },
    tempC: pkg ? pkg.c : null,
    temps,
    fanRpm,
    mem: {
      usedGB: Math.round(memUsed / 1073741824 * 10) / 10,
      totalGB: Math.round(memTotal / 1073741824 * 10) / 10,
      pct: Math.round(memUsed / memTotal * 1000) / 10,
      swapUsedGB: Math.round(swapUsed / 1073741824 * 10) / 10,
      swapTotalGB: Math.round(swapTotal / 1073741824 * 10) / 10,
      swapPct: swapTotal > 0 ? Math.round(swapUsed / swapTotal * 1000) / 10 : 0
    },
    disk
  };
}

function listWallpapers() {
  try {
    const names = fs.readdirSync(WALL_DIR).filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (!WALL_EXTS[ext]) return false;
      try {
        const st = fs.lstatSync(path.join(WALL_DIR, f));
        return st.isFile() && st.size <= MAX_WALL_BYTES;
      } catch { return false; }
    });
    names.sort((a, b) => {
      const ia = WALL_PRIORITY.indexOf(a), ib = WALL_PRIORITY.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.localeCompare(b);
    });
    return names;
  } catch (e) { return []; }
}

const writeRoutes = new Set(['/send', '/close', '/paste', '/upload', '/history-poke']);
let activeRequests = 0;
const server = http.createServer({ requestTimeout: 300000, headersTimeout: 15000 }, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const url = requestTarget(req.url);
  const origin = requestOrigin(req, origins, server.address().port);
  if (!url || !origin) return sendJson(res, 400, { error: 'invalid request target' });
  const auth = authorize(req);
  if (auth.status === 429) {
    res.setHeader('Retry-After', '900');
    return sendJson(res, 429, { error: 'too many auth attempts' });
  }
  if (auth.status === 401) {
    res.setHeader('WWW-Authenticate', 'Basic realm="X230 Terminal"');
    return sendJson(res, 401, { error: 'auth required' });
  }

  const route = url.pathname;
  const method = writeRoutes.has(route) ? 'POST' : 'GET';
  if (req.method !== method) {
    res.setHeader('Allow', method);
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (method === 'POST' && !allowsSource(req, origin, auth.basic)) {
    return sendJson(res, 403, { error: 'untrusted request origin' });
  }
  if (method === 'GET' && (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0)) {
    res.setHeader('Connection', 'close');
    return sendJson(res, 400, { error: 'unexpected request body' });
  }
  if (activeRequests >= 96) return sendJson(res, 503, { error: 'too many requests' });
  activeRequests++;
  res.once('close', () => { activeRequests--; });
  if (auth.basic && !auth.cookie && (method === 'GET' || allowsSource(req, origin, true))) {
    res.setHeader('Set-Cookie', makeAuthCookie(origin));
  }
  res._wtAcceptGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
  if (req.url === '/' || req.url.startsWith('/?')) return serveIndex(req, res);
  if (req.url === '/events' || req.url.startsWith('/events?')) return handleEvents(req, res);
  if (req.url === '/wallpapers' || req.url.startsWith('/wallpapers?')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(listWallpapers()));
  }
  if (req.url.startsWith('/wallpaper/')) {
    const name = decodeURIComponent(route.slice('/wallpaper/'.length));
    const mime = WALL_EXTS[path.extname(name).toLowerCase()];
    if (!name || name !== path.basename(name) || !mime) return sendJson(res, 404, { error: 'not found' });
    const fp = path.join(WALL_DIR, name);
    let fd;
    try {
      fd = fs.openSync(fp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_WALL_BYTES) return sendJson(res, 404, { error: 'not found' });
      const etag = '"' + [st.ino, st.size, st.mtimeMs, st.ctimeMs].join('-') + '"';
      const headers = { 'ETag': etag, 'Cache-Control': 'private, no-cache' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      let entry = wallMemCache.get(fp);
      if (!entry || entry.etag !== etag) {
        const buf = Buffer.allocUnsafe(st.size);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        if (wallMemCache.size >= 8) wallMemCache.delete(wallMemCache.keys().next().value);
        entry = { etag, buf: buf.subarray(0, bytes) };
        wallMemCache.set(fp, entry);
      }
      res.writeHead(200, { ...headers, 'Content-Type': mime });
      return res.end(entry.buf);
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (req.url === '/sys' || req.url.startsWith('/sys?')) {
    return getSysStatus().then(s => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(s));
    }).catch(() => sendJson(res, 500, { error: 'system status unavailable' }));
  }
  if (req.url === '/session-cmds' || req.url.startsWith('/session-cmds?')) {
    return listSessionCommands((_err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    });
  }
  if (req.url === '/complete' || req.url.startsWith('/complete?')) return handleComplete(req, res);
  if (route === '/history-poke') {
    const url = new URL(req.url, 'http://x');
    const sess = url.searchParams.get('s') || '';
    if (!validSession(sess)) return sendJson(res, 400, { error: 'invalid session' });
    const w = sessionWatchers.get(sess);
    if (w) w.poke();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, active: Boolean(w) }));
  }
  if (route === '/paste') return handlePaste(req, res);
  if (req.url === '/upload' || req.url.startsWith('/upload?')) return handleUpload(req, res);
  if (req.url === '/screen' || req.url.startsWith('/screen?')) return handleScreen(req, res);
  if (req.url === '/send' || req.url.startsWith('/send?')) return handleSend(req, res);
  if (route === '/close') return handleClose(req, res);
  if (req.url === '/history' || req.url.startsWith('/history?')) return handleHistory(req, res);
  if (req.url === '/history-stream' || req.url.startsWith('/history-stream?')) return handleHistoryStream(req, res);
  if (req.url === '/icon-32.png' || req.url === '/icon-180.png') {
    const f = path.join(ROOT, path.basename(req.url));
    return fs.readFile(f, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('no icon'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' });
      res.end(buf);
    });
  }
  if (validTtyTarget(url, false)) return proxyHttp(req, res);
  res.writeHead(404); res.end('not found');
});

server.on('connection', sock => {
  try { sock.setNoDelay(true); } catch (e) {}
});

let activeUpgrades = 0;
server.on('upgrade', (req, socket, head) => {
  const reject = (code, headers = '') => {
    socket.end('HTTP/1.1 ' + code + '\r\n' + headers + 'Content-Length: 0\r\nConnection: close\r\n\r\n');
  };
  const url = requestTarget(req.url);
  const origin = requestOrigin(req, origins, server.address().port);
  if (!url || !origin || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0 ||
      !validTtyTarget(url, true)) return reject('400 Bad Request');
  const auth = authorize(req);
  if (auth.status === 429) return reject('429 Too Many Requests', 'Retry-After: 900\r\n');
  if (auth.status === 401) return reject('401 Unauthorized', 'WWW-Authenticate: Basic realm="X230 Terminal"\r\n');
  if (!allowsSource(req, origin, auth.basic, true)) return reject('403 Forbidden');
  if (activeUpgrades >= 64) return reject('503 Service Unavailable');
  activeUpgrades++;
  socket.once('close', () => { activeUpgrades--; });
  try { socket.setNoDelay(true); } catch (e) {}
  const connectTimer = setTimeout(() => up.destroy(), 5000);
  const up = net.connect(TTY_PORT, TTY_HOST, () => {
    clearTimeout(connectTimer);
    try { up.setNoDelay(true); } catch (e) {}
    const lines = ['GET ' + req.url + ' HTTP/1.1', 'Host: ' + TTY_HOST + ':' + TTY_PORT];
    for (const key of ttyHeaders) {
      if (req.headers[key]) lines.push(key + ': ' + req.headers[key]);
    }
    lines.push('X-Auth-User: ' + USER);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  up.on('close', () => { clearTimeout(connectTimer); socket.destroy(); });
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
});

server.maxConnections = 256;
server.listen(PORT, host, () => console.log('webterm listening on ' + server.address().port));
