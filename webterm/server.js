const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { parseTerminalHistory, parseNativeMenu } = require('./history-parser');
const readCodexHistory = require('./codex-history').createCodexHistoryReader();

const PORT = 3902;
const TTY_HOST = '127.0.0.1', TTY_PORT = 3901;
const { user: USER, password: PASS, host: HOST } = require('./runtime-config').loadConfig();
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const AUTH_BUF = Buffer.from(AUTH);
const ROOT = '/home/zts/agent-share/webterm';
const INDEX_PATH = path.join(ROOT, 'index.html');
const PASTE_DIR = '/home/zts/agent-share/pastes';
const UPLOAD_DIR = '/home/zts/agent-share/uploads';
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const WALL_DIR = '/home/zts/Pictures/Wallpapers';
const WALL_EXTS = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const WALL_PRIORITY = ['anime_car_sunset.webp', 'arknights_frostleaf.webp', 'pixel_girl_starry_night.webp', 'anime_station_train_girl.webp', 'blue_night_fishbowl.webp'];
const wallMemCache = new Map();

const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUTH_FAIL_MAX = 15;
const AUTH_LOCK_MS = 15 * 60 * 1000;
const authFailures = new Map();

function clientIp(req) {
  const remote = req.socket?.remoteAddress || '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
    const fwd = String(req.headers['x-real-ip'] || '').trim();
    if (fwd) return fwd;
  }
  return remote || 'unknown';
}

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
  if (authFailures.size > 4096) authFailures.delete(authFailures.keys().next().value);
  authFailures.set(ip, rec);
}

const ok = req => {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return false;
  const b = Buffer.from(h);
  if (b.length !== AUTH_BUF.length) return false;
  return crypto.timingSafeEqual(b, AUTH_BUF);
};

const sseClients = new Set();
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
          try { res.write(msg); } catch (e) { sseClients.delete(res); }
        }
      }
    }
  } catch (e) {}
}

refreshIndexVer(false);
let watchTimer = null;
try {
  fs.watch(ROOT, (_, name) => {
    if (name && name !== 'index.html') return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => refreshIndexVer(true), 80);
  });
} catch (e) {}
setInterval(() => refreshIndexVer(true), 2000).unref();
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); }
  }
}, 25000).unref();

function serveIndex(res) {
  fs.readFile(INDEX_PATH, 'utf8', (e, html) => {
    if (e) { res.writeHead(500); return res.end('index missing'); }
    const ver = calcVer(Buffer.concat([Buffer.from(html), Buffer.from(TTY_PATCH_SNIPPET)]));
    indexVer = ver;
    const body = html.replace('</head>', '<meta name="wt-ver" content="' + ver + '">\n</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 1500\n');
  res.write('data: ' + indexVer + '\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

const TTY_THEME_STYLE = '<style id="wt-tokyo-style">html,body,.terminal,.xterm,.xterm-viewport,.xterm-screen{background:transparent!important;background-color:transparent!important}</style>';
const TTY_PATCH_SNIPPET = TTY_THEME_STYLE + '<script>(function(){var NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.__wtSocket=this;}};var TOKYO={background:"rgba(0,0,0,0)",foreground:"#f1ece3",cursor:"#ee9833",cursorAccent:"#0a0a0c",selectionBackground:"rgba(238,152,51,0.28)",black:"#0a0a0c",red:"#e2708f",green:"#98b88c",yellow:"#ee9833",blue:"#83b8ca",magenta:"#b8a1c9",cyan:"#cbb38f",white:"#d8d2c7",brightBlack:"#5b6064",brightRed:"#e2708f",brightGreen:"#98b88c",brightYellow:"#ee9833",brightBlue:"#83b8ca",brightMagenta:"#b8a1c9",brightCyan:"#cbb38f",brightWhite:"#f1ece3"};var o=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(t,l,p){if(t==="beforeunload")return;return o.call(this,t,l,p);};var jp=JSON.parse;JSON.parse=function(s,r){var v=jp.call(this,s,r);if(v&&typeof v==="object"&&!Array.isArray(v)&&("rendererType" in v||"disableLeaveAlert" in v)){v.rendererType="dom";v.scrollback=600;v.disableLeaveAlert=true;v.macOptionClickForcesSelection=true;v.macOptionIsMeta=true;v.allowTransparency=true;v.theme=TOKYO;}return v;};function cleanTxt(txt){return String(txt||"").replace(/[ \\t]+(?=\\r?\\n|$)/g,"");}function copyFallback(txt,silent){txt=cleanTxt(txt);if(!txt)return false;var ok=false;try{var ta=document.createElement("textarea");ta.value=txt;ta.setAttribute("readonly","");ta.style.cssText="position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";document.body.appendChild(ta);ta.focus({preventScroll:true});ta.select();ta.setSelectionRange(0,txt.length);ok=document.execCommand("copy");document.body.removeChild(ta);}catch(e){}try{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt).catch(function(){});}catch(e){}try{if(window.term&&window.term.focus)window.term.focus();}catch(e){}if(ok&&!silent){try{if(window.parent&&window.parent.wtNotifyCopy)window.parent.wtNotifyCopy(txt.length);}catch(e){}}return ok;}window.__wtCopyText=copyFallback;var pt=setInterval(function(){var t=window.term;if(t&&t.options){t.options.allowTransparency=true;t.options.macOptionIsMeta=true;t.options.theme=TOKYO;}var ss=t&&t._core&&t._core._selectionService;if(ss){if(!ss.__wtPatched){ss.__wtPatched=true;ss.shouldForceSelection=function(e){return !e.ctrlKey;};}clearInterval(pt);}},50);setTimeout(function(){clearInterval(pt);},15000);document.addEventListener("copy",function(e){var t=window.term;if(t&&t.hasSelection&&t.hasSelection()){var txt=cleanTxt(t.getSelection());if(txt&&e.clipboardData){e.clipboardData.setData("text/plain",txt);e.preventDefault();try{if(window.parent&&window.parent.wtNotifyCopy)window.parent.wtNotifyCopy(txt.length);}catch(err){}}}},true);window.addEventListener("mouseup",function(e){if(e.button!==0||e.ctrlKey)return;var t=window.term;if(t&&t.hasSelection&&t.hasSelection()){var txt=t.getSelection();if(txt)copyFallback(txt,false);}});window.addEventListener("keydown",function(e){var isC=(e.code==="KeyC"||(e.key&&e.key.toLowerCase()==="c"));var isCopy=((e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey)||(e.ctrlKey&&e.shiftKey&&!e.metaKey&&!e.altKey))&&isC;if(!isCopy)return;var t=window.term;if(t&&t.hasSelection&&t.hasSelection()){var txt=t.getSelection();if(txt){copyFallback(txt,false);e.preventDefault();e.stopPropagation();}}},true);})();</script>';

function proxyHttp(req, res) {
  const headers = Object.assign({}, req.headers);
  headers['x-auth-user'] = USER;
  headers['host'] = TTY_HOST + ':' + TTY_PORT;
  const isTtyHtml = req.method === 'GET' && (req.url === '/tty' || req.url === '/tty/' || req.url.startsWith('/tty/?'));
  if (isTtyHtml) headers['accept-encoding'] = 'identity';
  const up = http.request({ host: TTY_HOST, port: TTY_PORT, path: req.url, method: req.method, headers }, r => {
    const ct = (r.headers['content-type'] || '');
    const ce = (r.headers['content-encoding'] || '');
    if (isTtyHtml && r.statusCode === 200 && ct.includes('text/html') && !ce) {
      const chunks = [];
      r.on('data', c => chunks.push(c));
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
  up.on('error', () => { res.writeHead(502); res.end('upstream down'); });
  req.pipe(up);
}

function sanitizeUploadName(raw) {
  let base = path.basename(String(raw || '').replace(/\\/g, '/'));
  base = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '');
  if (!base || base === '.' || base === '..') return 'upload-' + Date.now();
  return base.slice(0, 140);
}

function uniqueUploadPath(dir, safeName) {
  const first = path.join(dir, safeName);
  if (!fs.existsSync(first)) return first;
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  return path.join(dir, stem + '-' + stamp + ext);
}

function handleUpload(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const url = new URL(req.url, 'http://x');
  const session = (url.searchParams.get('s') || '').replace(/[^a-zA-Z0-9_-]/g, '');
  let rawName = url.searchParams.get('name') || '';
  if (!rawName && req.headers['x-file-name']) {
    try { rawName = decodeURIComponent(String(req.headers['x-file-name'])); } catch (e) { rawName = String(req.headers['x-file-name']); }
  }
  const safeName = sanitizeUploadName(rawName);
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(UPLOAD_DIR, day);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }

  const tmpPath = path.join(dir, '.part-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const ws = fs.createWriteStream(tmpPath);
  let bytes = 0;
  let settled = false;

  const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch (e) {} };
  const fail = (status, msg) => {
    if (settled) return;
    settled = true;
    try { ws.destroy(); } catch (e) {}
    cleanup();
    sendJson(res, status, { ok: false, error: msg });
  };

  req.setTimeout(0);
  req.on('data', chunk => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) {
      fail(413, 'file too large (>256MB)');
      req.destroy();
      return;
    }
    if (!ws.write(chunk)) req.pause();
  });
  ws.on('drain', () => { if (!settled) req.resume(); });
  ws.on('error', err => fail(500, err.message));
  req.on('aborted', () => fail(499, 'upload aborted'));
  req.on('error', err => fail(500, err.message));
  req.on('end', () => {
    if (settled) return;
    if (bytes === 0) return fail(400, 'empty file');
    ws.end(() => {
      if (settled) return;
      try {
        const dest = uniqueUploadPath(dir, safeName);
        fs.renameSync(tmpPath, dest);
        settled = true;
        sendJson(res, 200, { ok: true, path: dest, name: path.basename(dest), session, bytes });
      } catch (err) {
        fail(500, err.message);
      }
    });
  });
}

function handlePaste(req, res) {
  const url = new URL(req.url, 'http://x');
  const session = (url.searchParams.get('s') || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const mime = (req.headers['content-type'] || 'image/png').split(';')[0];
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'png';
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(PASTE_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const dest = path.join(dir, name);
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size > 25 * 1024 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    if (!chunks.length) { res.writeHead(400); return res.end('empty'); }
    fs.writeFileSync(dest, Buffer.concat(chunks));
    prune();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: dest, session, bytes: size }));
  });
}

function prune() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  try {
    for (const day of fs.readdirSync(PASTE_DIR)) {
      const dir = path.join(PASTE_DIR, day);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      }
    }
  } catch (e) {}
}

function handleClose(req, res) {
  const url = new URL(req.url, 'http://x');
  const sess = (url.searchParams.get('s') || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sess) { res.writeHead(400); return res.end('no session'); }
  try { execFileSync('/usr/bin/tmux', ['-L', 'wt', 'kill-session', '-t', 'wt-' + sess], { stdio: 'ignore' }); } catch (e) {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ killed: sess }));
}

let sendSeq = 0;
function tmuxPasteText(target, text, cb) {
  const bufName = 'wt_send_' + process.pid + '_' + (++sendSeq);
  const loader = spawn('/usr/bin/tmux', ['-L', 'wt', 'load-buffer', '-b', bufName, '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let errOut = '';
  loader.stderr.on('data', d => { errOut += d.toString(); });
  loader.on('error', err => cb(err));
  loader.on('close', code => {
    if (code !== 0) return cb(new Error(errOut.trim() || ('tmux load-buffer exit ' + code)));
    execFile(
      '/usr/bin/tmux',
      ['-L', 'wt', 'paste-buffer', '-p', '-r', '-d', '-b', bufName, '-t', target],
      { timeout: 3000 },
      (err2) => {
        if (err2) {
          try { execFileSync('/usr/bin/tmux', ['-L', 'wt', 'delete-buffer', '-b', bufName], { stdio: 'ignore' }); } catch (e) {}
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
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sess)) return sendJson(res, 400, {error:'invalid session'});
  execFile('/usr/bin/tmux', ['-L','wt','display-message','-t','wt-'+sess,'-p','__WT_META__\t#{pane_current_command}\t#{pane_title}', ';','capture-pane','-t','wt-' + sess,'-e','-p','-J'], {timeout:2000,maxBuffer:1024*1024}, (err, text) => {
    if (err) return sendJson(res, 404, {error:'session not available'});
    const raw=String(text || ''), nl=raw.indexOf('\n');
    const [cmd,title]=raw.slice(0,nl).replace('__WT_META__\t','').split('\t');
    const screen=raw.slice(nl+1).trimEnd(), parsed=parseTerminalHistory(screen,cmd,{paneTitle:title}), agent=detectActiveAgent(cmd,title)||parsed.agent;
    sendJson(res, 200, {text:screen, menuActive:parsed.menuActive, nativeMenu:parseNativeMenu(screen,agent)});
  });
}

function handleSend(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
  }
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', c => {
    size += c.length;
    if (size > 512 * 1024) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {}
    const sess = String((body && body.s) || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sess) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'no session' }));
    }
    const target = 'wt-' + sess;
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
        return res.end(JSON.stringify({ ok: false, error: msg }));
      }
      pokeWatcher();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    };

    if (body && typeof body.raw === 'string' && body.raw.length) {
      if (body.raw === '\x1b') {
        return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, 'Escape'], { timeout: 3000 }, finish);
      }
      if (body.raw === '\x03') {
        return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, 'C-c'], { timeout: 3000 }, finish);
      }
      const hex = Array.from(Buffer.from(body.raw, 'utf8')).map(b => b.toString(16).padStart(2, '0'));
      return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, '-H', ...hex], { timeout: 3000 }, finish);
    }

    const text = String((body && body.text) || '').replace(/\r\n?/g, '\n');
    if (!text) {
      return execFile('/usr/bin/tmux', ['-L', 'wt', 'send-keys', '-t', target, 'Enter'], { timeout: 3000 }, finish);
    }
    tmuxPasteText(target, text, finish);
  });
}

const sessionBannerCache = new Map();
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
  const target = 'wt-' + sess;
  execFile(
    '/usr/bin/tmux',
    ['-L', 'wt', 'display-message', '-t', target, '-p', '__WT_META__\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}', ';', 'capture-pane', '-t', target, '-e', '-p', '-J', '-S', '-'],
    { maxBuffer: 8 * 1024 * 1024, timeout: 3000 },
    async (err, out) => {
      if (err) {
        const msg = err.message || '';
        const notFound = /can't find|session not found|no server running/i.test(msg);
        return cb({ status: notFound ? 404 : 500, error: notFound ? 'session not found' : msg });
      }
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
        sessionBannerCache.set(cacheKey, { banner: parsed.banner, bannerAnsi: parsed.bannerAnsi });
      } else if (parsed.agent && sessionBannerCache.has(cacheKey)) {
        const cached = sessionBannerCache.get(cacheKey);
        parsed.banner = cached.banner;
        parsed.bannerAnsi = cached.bannerAnsi;
        parsed.bannerCaptured = true;
      }
      const payload = { sess, cmd, runningAgent, ...parsed, historySource: 'terminal' };
      if (runningAgent === 'codex') {
        const native = await readCodexHistory(paneTitle, panePath);
        if (native) {
          payload.turns = native.turns;
          payload.historySource = 'codex-rollout';
          payload.threadId = native.threadId;
          if (native.model) payload.model = native.model;
        }
      }
      cb(null, payload);
    }
  );
}

let cmdsCache = { ts: 0, data: { cmds: {}, agents: {}, paths: {} } };
function listSessionCommands(cb) {
  const now = Date.now();
  if (now - cmdsCache.ts < 300) return cb(null, cmdsCache.data);
  execFile('/usr/bin/tmux', ['-L', 'wt', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}'], { timeout: 1500 }, (err, out) => {
    if (err) return cb(null, { cmds: {}, agents: {}, paths: {} });
    const cmds = {}, agents = {}, paths = {};
    for (const line of (out || '').split('\n')) {
      const parts = line.split('\t');
      const name = (parts[0] || '').trim();
      if (!name.startsWith('wt-')) continue;
      const sess = name.slice(3);
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
  execFile('/usr/bin/tmux', ['-L', 'wt', 'display-message', '-t', 'wt-' + sess, '-p', '#{pane_current_path}'], { timeout: 1200 }, (err, out) => {
    const p = !err && out ? out.trim() : '';
    cb(p || (cmdsCache.data.paths && cmdsCache.data.paths[sess]) || os.homedir());
  });
}

function handleComplete(req, res) {
  const url = new URL(req.url, 'http://x');
  const sess = (url.searchParams.get('s') || '').replace(/[^a-zA-Z0-9_-]/g, '');
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

    let entries = [];
    try {
      entries = fs.readdirSync(fsDir, { withFileTypes: true });
    } catch (e) {
      return sendJson(res, 200, { ok: true, cwd, items: [] });
    }

    const wantHidden = basePart.startsWith('.');
    const needleLower = basePart.toLowerCase();
    const ranked = [];
    let scanned = 0;
    for (const ent of entries) {
      if (scanned++ > 800) break;
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
        try { isDir = fs.statSync(path.join(fsDir, name)).isDirectory(); } catch (e) {}
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

    ranked.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    sendJson(res, 200, { ok: true, cwd, items: ranked.slice(0, 18).map(r => r.item) });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function stableHistoryDigest(payload) {
  const visible = [payload.historySource, payload.threadId, payload.cmd, payload.agent, payload.banner, payload.bannerAnsi, payload.preamble, payload.preambleAnsi, payload.totalLines, payload.turns];
  const normalized = JSON.stringify(visible)
    .replace(/[\u2801-\u28ff◐◓◑◒◴◵◶◷]/g, '⠋')
    .replace(/[✳✶✻✽✢](?=[ \t]+\S+(?:ing\b|…))/g, '✳');
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

function handleHistory(req, res) {
  const url = new URL(req.url, 'http://x');
  const sess = (url.searchParams.get('s') || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const isProbe = url.searchParams.get('probe') === '1';
  if (!sess) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'no session' }));
  }
  captureSessionHistory(sess, (err, payload) => {
    if (err) {
      if (isProbe && err.status === 404) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ pending: true, sess, cmd: '', agent: '', turns: [] }));
      }
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: err.error, sess }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  });
}

const sessionWatchers = new Map();

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
    lastEventChunk: '',
    pingTimer: setInterval(() => {
      for (const client of w.clients) {
        try { client.res.write(': ping\n\n'); } catch (e) { removeClient(w, client); }
      }
    }, 20000)
  };
  if (w.pingTimer.unref) w.pingTimer.unref();

  function removeClient(watcher, client) {
    watcher.clients.delete(client);
    if (watcher.clients.size === 0) {
      clearTimeout(watcher.timer);
      clearInterval(watcher.pingTimer);
      sessionWatchers.delete(watcher.sess);
    }
  }

  function schedule(ms) {
    if (!sessionWatchers.has(sess)) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(tick, ms);
  }

  function tick() {
    if (!sessionWatchers.has(sess)) return;
    if (w.inflight) { w.rerunSoon = true; return; }
    w.inflight = true;
    w.rerunSoon = false;
    captureSessionHistory(sess, (err, payload) => {
      w.inflight = false;
      if (!sessionWatchers.has(sess)) return;
      if (err) {
        const chunk = 'event: err\ndata: ' + JSON.stringify({ error: err.error, status: err.status }) + '\n\n';
        for (const client of [...w.clients]) {
          try { client.res.write(chunk); } catch (e) { removeClient(w, client); }
        }
        return schedule(w.rerunSoon ? 40 : 600);
      }
      const digest = stableHistoryDigest(payload);
      if (digest !== w.lastDigest) {
        w.lastDigest = digest;
        w.idleCount = 0;
        const chunk = 'event: hist\ndata: ' + JSON.stringify(payload) + '\n\n';
        w.lastEventChunk = chunk;
        for (const client of [...w.clients]) {
          if (client.lastSentDigest === digest) continue;
          try {
            client.res.write(chunk);
            client.lastSentDigest = digest;
          } catch (e) {
            removeClient(w, client);
          }
        }
        return schedule(w.rerunSoon ? 25 : 50);
      }
      if (w.rerunSoon) {
        w.idleCount = 0;
        return schedule(30);
      }
      w.idleCount = Math.min(w.idleCount + 1, 5);
      // LAN low-latency adaptive cadence: 50ms when active -> max 220ms at idle
      schedule(Math.min(220, 50 + w.idleCount * 35));
    });
  }

  w.removeClient = client => removeClient(w, client);
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
  const sess = (url.searchParams.get('s') || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sess) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'no session' }));
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 500\n\n');
  const w = getOrCreateWatcher(sess);
  const client = { res, lastSentDigest: '' };
  w.clients.add(client);
  if (w.lastEventChunk && w.lastDigest) {
    try {
      res.write(w.lastEventChunk);
      client.lastSentDigest = w.lastDigest;
    } catch (e) {
      w.removeClient(client);
      return;
    }
  }
  const onClose = () => w.removeClient(client);
  req.on('close', onClose);
  res.on('close', onClose);
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
      try { return fs.statSync(path.join(WALL_DIR, f)).isFile(); } catch (e) { return false; }
    });
    names.sort((a, b) => {
      const ia = WALL_PRIORITY.indexOf(a), ib = WALL_PRIORITY.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.localeCompare(b);
    });
    return names;
  } catch (e) { return []; }
}

const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  if (authLocked(ip)) {
    res.writeHead(429, { 'Retry-After': '900', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('too many auth attempts');
  }
  if (!ok(req)) {
    noteAuthFail(ip);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="X230 Terminal"' });
    return res.end('auth required');
  }
  authFailures.delete(ip);
  if (req.url === '/' || req.url.startsWith('/?')) return serveIndex(res);
  if (req.url === '/events' || req.url.startsWith('/events?')) return handleEvents(req, res);
  if (req.url === '/wallpapers' || req.url.startsWith('/wallpapers?')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(listWallpapers()));
  }
  if (req.url.startsWith('/wallpaper/')) {
    let raw = '';
    try { raw = decodeURIComponent(req.url.slice('/wallpaper/'.length).split('?')[0]); } catch (e) {}
    const name = path.basename(raw);
    const mime = WALL_EXTS[path.extname(name).toLowerCase()];
    if (!name || !mime) { res.writeHead(404); return res.end('not found'); }
    const fp = path.join(WALL_DIR, name);
    try {
      const st = fs.statSync(fp);
      const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'public, max-age=86400' });
        return res.end();
      }
      let entry = wallMemCache.get(fp);
      if (!entry || entry.etag !== etag) {
        const buf = fs.readFileSync(fp);
        if (wallMemCache.size >= 8) wallMemCache.delete(wallMemCache.keys().next().value);
        entry = { etag, mime, buf };
        wallMemCache.set(fp, entry);
      }
      res.writeHead(200, { 'Content-Type': entry.mime, 'ETag': etag, 'Cache-Control': 'public, max-age=86400' });
      return res.end(entry.buf);
    } catch (e) {
      res.writeHead(404);
      return res.end('not found');
    }
  }
  if (req.url === '/sys' || req.url.startsWith('/sys?')) {
    return getSysStatus().then(s => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(s));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  }
  if (req.url === '/session-cmds' || req.url.startsWith('/session-cmds?')) {
    return listSessionCommands((_err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    });
  }
  if (req.url === '/complete' || req.url.startsWith('/complete?')) return handleComplete(req, res);
  if (req.url.startsWith('/history-poke')) {
    const url = new URL(req.url, 'http://x');
    const sess = (url.searchParams.get('s') || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const w = sess && sessionWatchers.get(sess);
    if (w) w.poke();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, active: Boolean(w) }));
  }
  if (req.url.startsWith('/paste')) return handlePaste(req, res);
  if (req.url === '/upload' || req.url.startsWith('/upload?')) return handleUpload(req, res);
  if (req.url === '/screen' || req.url.startsWith('/screen?')) return handleScreen(req, res);
  if (req.url === '/send' || req.url.startsWith('/send?')) return handleSend(req, res);
  if (req.url.startsWith('/close')) return handleClose(req, res);
  if (req.url === '/history' || req.url.startsWith('/history?')) return handleHistory(req, res);
  if (req.url === '/history-stream' || req.url.startsWith('/history-stream?')) return handleHistoryStream(req, res);
  if (req.url === '/icon-32.png' || req.url === '/icon-180.png') {
    const f = path.join(ROOT, path.basename(req.url));
    return fs.readFile(f, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('no icon'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
  }
  if (req.url.startsWith('/tty')) return proxyHttp(req, res);
  res.writeHead(404); res.end('not found');
});

server.on('connection', sock => {
  try { sock.setNoDelay(true); } catch (e) {}
});

server.on('upgrade', (req, socket, head) => {
  const ip = clientIp(req);
  if (authLocked(ip) || !ok(req)) { noteAuthFail(ip); socket.destroy(); return; }
  authFailures.delete(ip);
  try { socket.setNoDelay(true); } catch (e) {}
  const up = net.connect(TTY_PORT, TTY_HOST, () => {
    try { up.setNoDelay(true); } catch (e) {}
    const lines = ['GET ' + req.url + ' HTTP/1.1', 'Host: ' + TTY_HOST + ':' + TTY_PORT];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') continue;
      lines.push(k + ': ' + v);
    }
    lines.push('X-Auth-User: ' + USER);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, HOST, () => console.log('webterm listening on ' + PORT));
