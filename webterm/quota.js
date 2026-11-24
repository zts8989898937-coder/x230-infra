const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = os.homedir();
const CACHE_TTL_MS = 20 * 1000;
const AGY_CLI_TTL_MS = 60 * 1000;
const AGY_CLI_CACHE = path.join(HOME, '.local/state/webterm/agy-cli-quota.json');
const MAX_QUOTA_RESPONSE = 2 * 1024 * 1024;
const AGY_BIN = process.env.AGY_BIN || path.join(HOME, '.local/bin/agy');

let cached = null;
let cachedAt = 0;
let inflight = null;
let agyCliRunning = false;
let agyCliPromise = null;

function normalizeResetTime(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+CST$/i);
  if (m) return `${m[1]}T${m[2]}:00+08:00`;
  return s;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const chunks = [];
    let size = 0;
    if (res.body) for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_QUOTA_RESPONSE) throw new Error('quota response too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks, size).toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function writeAgyCliCache(payload) {
  const dir = path.dirname(AGY_CLI_CACHE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, '.quota-' + crypto.randomUUID());
  let created = false;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(payload));
    fs.renameSync(temp, AGY_CLI_CACHE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

function readAgyCliCache() {
  const c = readJsonSafe(AGY_CLI_CACHE);
  if (c && typeof c.ts === 'number' && (Array.isArray(c.entries) || c.pools)) return c;
  return null;
}

function readAgySelectedModel() {
  const s = readJsonSafe(path.join(HOME, '.gemini/antigravity-cli/settings.json'));
  const raw = s && typeof s.model === 'string' ? s.model.trim() : '';
  return raw ? raw.replace(/\s*\((?:Low|Medium|High)\)\s*$/i, '').trim() : '';
}

function readCodexCurrentModel() {
  try {
    const txt = fs.readFileSync(path.join(HOME, '.codex/config.toml'), 'utf8');
    const m = txt.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    if (m && m[1]) return m[1].trim();
  } catch (e) {}
  const cache = readJsonSafe(path.join(HOME, '.codex/models_cache.json'));
  const first = cache && Array.isArray(cache.models) && cache.models[0];
  return (first && (first.slug || first.id || first.display_name)) || '';
}

function extractLatestClaudeVersion(models) {
  if (!models || typeof models !== 'object') return '';
  let best = '';
  let bestNum = -1;
  for (const [id, info] of Object.entries(models)) {
    const src = `${(info && info.displayName) || ''} ${id}`;
    const m = src.match(/claude(?:[\s-]+(?:opus|sonnet|haiku))?[\s-]+(\d+)[.-](\d+)/i);
    if (!m) continue;
    const num = Number(m[1]) * 100 + Number(m[2]);
    if (num > bestNum) {
      bestNum = num;
      best = `${m[1]}.${m[2]}`;
    }
  }
  return best;
}

function formatDynamicPoolLabel(pool, kind, dynamicHints = {}) {
  let win = '';
  if (/Weekly/i.test(kind)) win = '周池';
  else if (/Five Hour|5h/i.test(kind)) win = '5h';
  else if (kind && kind.toLowerCase() !== pool.toLowerCase()) win = kind.replace(/\s*Remaining$/i, '').trim();

  let base = String(pool || '').trim();
  if (/^Claude\s+and\s+GPT\s+models$/i.test(base)) {
    base = dynamicHints.claudeVer ? `Claude ${dynamicHints.claudeVer} + GPT` : 'Claude + GPT';
  }
  return win ? `${base} (${win})` : base;
}

function inferPoolKey(pool, kind, fallbackIndex) {
  if (/Argon/i.test(pool) || /Argon/i.test(kind)) return 'argon-w';
  if (/Gemini/i.test(pool) && /Weekly/i.test(kind)) return 'gem-w';
  if (/Gemini/i.test(pool) && /Five Hour|5h/i.test(kind)) return 'gem-5h';
  if (/Claude/i.test(pool) && /Weekly/i.test(kind)) return '3p-w';
  if (/Claude/i.test(pool) && /Five Hour|5h/i.test(kind)) return '3p-5h';
  return (pool + '-' + kind).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || ('pool-' + fallbackIndex);
}

function triggerAgyCliRefresh(force = false) {
  if (agyCliPromise) return agyCliPromise;
  const c = readAgyCliCache();
  if (!force && c && (Date.now() - c.ts) < AGY_CLI_TTL_MS) return Promise.resolve(c);
  agyCliRunning = true;
  agyCliPromise = new Promise((resolve) => {
    execFile(AGY_BIN, ['-p', '/usage'], { cwd: '/tmp', timeout: 60000, env: { ...process.env } }, (err, stdout, stderr) => {
      try {
        if (err && !stdout) {
          resolve(null);
          return;
        }
        const text = String(stdout || '') + '\n' + String(stderr || '');
        const entries = [];
        for (const line of text.split(/\r?\n/)) {
          const parts = line.split('\t').map(s => s.trim());
          if (parts.length < 3) continue;
          const m = parts[2].match(/(\d+(?:\.\d+)?)\s*%/);
          if (!m) continue;
          const left = Number(m[1]);
          const pool = parts[0];
          const kind = parts[1];
          const reset = normalizeResetTime(parts[3] || '');
          entries.push({
            key: inferPoolKey(pool, kind, entries.length),
            pool,
            kind,
            leftPct: left,
            usedPct: Math.round((100 - left) * 10) / 10,
            resetAt: reset
          });
        }
        if (entries.length) {
          const payload = { ts: Date.now(), entries };
          try {
            writeAgyCliCache(payload);
            cached = null;
            liveProvidersCache = null;
          } catch (e) {}
          resolve(payload);
          return;
        }
        resolve(null);
      } finally {
        agyCliRunning = false;
        agyCliPromise = null;
      }
    });
  });
  return agyCliPromise;
}

async function fetchAntigravity(opts = false) {
  const forceCli = typeof opts === 'object' ? !!opts.forceCli : !!opts;
  const waitCli = typeof opts === 'object' ? !!opts.waitCli : false;
  const refreshPromise = triggerAgyCliRefresh(forceCli);
  if (waitCli) {
    await refreshPromise;
  }
  const cliCache = readAgyCliCache();
  const cliEntries = Array.isArray(cliCache && cliCache.entries) ? cliCache.entries : [];

  const tokFile = path.join(HOME, '.gemini/antigravity-cli/antigravity-oauth-token');
  const d = readJsonSafe(tokFile);
  const t = d && (d.token || d);
  const accessToken = t && t.access_token;

  const buckets = {};
  let liveModels = null;

  if (accessToken) {
    const headers = {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/2.0'
    };

    const [sumRes, modRes] = await Promise.allSettled([
      fetchJson('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', { method: 'POST', headers, body: '{}' }),
      fetchJson('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', { method: 'POST', headers, body: '{}' })
    ]);

    if (sumRes.status === 'fulfilled' && sumRes.value.ok && sumRes.value.json) {
      for (const g of (sumRes.value.json.groups || [])) {
        for (const b of (g.buckets || [])) {
          buckets[b.bucketId] = {
            groupName: g.displayName || '',
            displayName: b.displayName || '',
            left: Math.round(Number(b.remainingFraction || 0) * 1000) / 10,
            reset: b.resetTime || '',
            disabled: !!b.disabled
          };
        }
      }
    }

    if (modRes.status === 'fulfilled' && modRes.value.ok && modRes.value.json && modRes.value.json.models) {
      liveModels = modRes.value.json.models;
      if (!buckets['3p-weekly']) {
        const clEntry = Object.entries(liveModels).find(([k, v]) => /^claude-/i.test(k) && v && v.quotaInfo);
        if (clEntry && clEntry[1].quotaInfo) {
          buckets['3p-weekly'] = {
            groupName: 'Claude and GPT models',
            displayName: 'Weekly Limit Remaining',
            left: Math.round(Number(clEntry[1].quotaInfo.remainingFraction || 0) * 1000) / 10,
            reset: clEntry[1].quotaInfo.resetTime || '',
            disabled: false
          };
        }
      }
    }
  }

  const dynamicHints = { claudeVer: extractLatestClaudeVersion(liveModels) };
  const activeModel = readAgySelectedModel();
  const plan = activeModel ? `Google AI Pro · ${activeModel}` : 'Google AI Pro';

  const items = [];
  const seenKeys = new Set();

  // 优先按 agy -p /usage 真实返回的池子动态输出（将独立池置前或保持清晰顺序）
  const ordered = [...cliEntries].sort((a, b) => {
    const rank = k => (k === 'argon-w' ? 0 : k === 'gem-w' ? 1 : k === 'gem-5h' ? 2 : k === '3p-w' ? 3 : k === '3p-5h' ? 4 : 5);
    return rank(a.key) - rank(b.key);
  });

  for (const e of ordered) {
    seenKeys.add(e.key);
    items.push({
      key: e.key,
      label: formatDynamicPoolLabel(e.pool, e.kind, dynamicHints),
      leftPct: e.leftPct,
      usedPct: e.usedPct,
      resetAt: e.resetAt
    });
  }

  // 若 CLI 暂未返回 3p 池，则用云端实时 API 兜底
  if (!seenKeys.has('3p-w') && buckets['3p-weekly']) {
    const b = buckets['3p-weekly'];
    items.push({
      key: '3p-w',
      label: formatDynamicPoolLabel(b.groupName || 'Claude and GPT models', b.displayName || 'Weekly Limit Remaining', dynamicHints),
      leftPct: b.left,
      usedPct: Math.round((100 - b.left) * 10) / 10,
      resetAt: b.reset
    });
  }
  if (!seenKeys.has('3p-5h') && buckets['3p-5h']) {
    const b = buckets['3p-5h'];
    items.push({
      key: '3p-5h',
      label: formatDynamicPoolLabel(b.groupName || 'Claude and GPT models', b.displayName || 'Five Hour Limit Remaining', dynamicHints),
      leftPct: b.left,
      usedPct: Math.round((100 - b.left) * 10) / 10,
      resetAt: b.reset,
      disabled: b.disabled
    });
  }

  if (!items.length) {
    return { id: 'agy', name: 'Antigravity', plan, status: 'err', cliRefreshing: agyCliRunning, error: '暂未拿到额度' };
  }
  return { id: 'agy', name: 'Antigravity', plan, status: 'ok', cliRefreshing: agyCliRunning, items };
}

function attachAgyAccounts(provider) {
  const state = readJsonSafe(path.join(HOME, '.local/state/agy-accounts/quota.json'));
  const checkedAt = Number.isFinite(state?.checked) ? new Date(state.checked * 1000).toISOString() : null;
  const windows = [
    ['argon', 0, 'argon-w', 'Gemini 4 Argon · 周'],
    ['gemini', 0, 'gem-w', 'Gemini · 周'],
    ['gemini', 1, 'gem-5h', 'Gemini · 5 小时'],
    ['third-party', 0, '3p-w', 'Claude + GPT · 周'],
    ['third-party', 1, '3p-5h', 'Claude + GPT · 5 小时']
  ];
  const accounts = ['primary', 'backup'].map(role => {
    const status = state?.[role + '_status'] || '等待首次查询';
    const items = [];
    const missingWindows = [];
    if (status === '已核验' || status === '服务未返回额度') {
      for (const [pool, index, key, label] of windows) {
        const leftPct = state[role]?.[pool]?.[index];
        if (!Number.isFinite(leftPct) || leftPct < 0 || leftPct > 100) {
          missingWindows.push(label);
          continue;
        }
        const reportedReset = state.resets?.[role]?.[pool]?.[index];
        const previous = role === 'primary' && provider.items?.find(item => item.key === key && item.leftPct === leftPct);
        items.push({ key, label, leftPct, resetAt: reportedReset || previous?.resetAt || '' });
      }
    }
    return { role, email: state?.emails?.[role] || '', status, items, missingWindows };
  });
  return { ...provider, accounts, accountsCheckedAt: checkedAt };
}

function readLatestCodexSessionLimit() {
  const base = path.join(HOME, '.codex/sessions');
  try {
    const files = [];
    function walk(dir, depth) {
      if (depth > 4) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, depth + 1);
        else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          files.push({ p, mtime: fs.statSync(p).mtimeMs });
        }
      }
    }
    walk(base, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(0, 3)) {
      const fd = fs.openSync(f.p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let lines;
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) continue;
        const bytes = Math.min(st.size, 2 * 1024 * 1024);
        const buf = Buffer.allocUnsafe(bytes);
        const n = fs.readSync(fd, buf, 0, bytes, st.size - bytes);
        lines = buf.subarray(0, n).toString('utf8').split('\n');
      } finally { fs.closeSync(fd); }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('rate_limits')) continue;
        let obj;
        try { obj = JSON.parse(lines[i]); } catch { continue; }
        const rl = obj && obj.payload && obj.payload.rate_limits;
        if (rl && (rl.primary || rl.secondary)) return rl;
      }
    }
  } catch (e) {}
  return null;
}

async function fetchCodex() {
  const auth = readJsonSafe(path.join(HOME, '.codex/auth.json'));
  const tokens = auth && auth.tokens;
  if (tokens && tokens.access_token) {
    try {
      const r = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          'Authorization': 'Bearer ' + tokens.access_token,
          'ChatGPT-Account-Id': tokens.account_id || '',
          'User-Agent': 'codex-cli'
        }
      });
      if (r.ok && r.json && r.json.rate_limit) {
        const rl = r.json.rate_limit;
        const items = [];
        if (rl.primary_window) {
          const used = Number(rl.primary_window.used_percent || 0);
          items.push({
            label: '5h 窗口',
            usedPct: used,
            leftPct: Math.max(0, Math.round((100 - used) * 10) / 10),
            resetAt: rl.primary_window.reset_at ? new Date(rl.primary_window.reset_at * 1000).toISOString() : ''
          });
        }
        if (rl.secondary_window) {
          const used = Number(rl.secondary_window.used_percent || 0);
          items.push({
            label: '周窗口',
            usedPct: used,
            leftPct: Math.max(0, Math.round((100 - used) * 10) / 10),
            resetAt: rl.secondary_window.reset_at ? new Date(rl.secondary_window.reset_at * 1000).toISOString() : ''
          });
        }
        const curModel = readCodexCurrentModel();
        const planBase = 'ChatGPT ' + (r.json.plan_type || 'Plus');
        return { id: 'codex', name: 'Codex', plan: curModel ? `${planBase} · ${curModel}` : planBase, status: 'ok', items };
      }
    } catch (e) {}
  }

  const fallback = readLatestCodexSessionLimit();
  if (fallback) {
    const items = [];
    if (fallback.primary) {
      const used = Number(fallback.primary.used_percent || 0);
      items.push({
        label: '5h 窗口 (缓存)',
        usedPct: used,
        leftPct: Math.max(0, Math.round((100 - used) * 10) / 10),
        resetAt: fallback.primary.resets_at ? new Date(fallback.primary.resets_at * 1000).toISOString() : ''
      });
    }
    if (fallback.secondary) {
      const used = Number(fallback.secondary.used_percent || 0);
      items.push({
        label: '周窗口 (缓存)',
        usedPct: used,
        leftPct: Math.max(0, Math.round((100 - used) * 10) / 10),
        resetAt: fallback.secondary.resets_at ? new Date(fallback.secondary.resets_at * 1000).toISOString() : ''
      });
    }
    const curModel = readCodexCurrentModel();
    const planBase = 'ChatGPT ' + (fallback.plan_type || 'Plus');
    return { id: 'codex', name: 'Codex', plan: curModel ? `${planBase} · ${curModel}` : planBase, status: 'ok', items };
  }
  return { id: 'codex', name: 'Codex', plan: 'ChatGPT Plus', status: 'err', error: '无法获取 Codex 额度' };
}

async function fetchDeepSeek() {
  let key = '';
  try {
    const txt = fs.readFileSync(path.join(HOME, '.config/deepseek.env'), 'utf8');
    for (const line of txt.split('\n')) {
      if (line.startsWith('DEEPSEEK_API_KEY=')) {
        key = line.split('=', 2)[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch (e) {}
  if (!key) return { id: 'deepseek', name: 'DeepSeek', plan: '按量 API', status: 'err', error: '未配置 Key' };

  try {
    const r = await fetchJson('https://api.deepseek.com/user/balance', {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    if (r.ok && r.json && Array.isArray(r.json.balance_infos) && r.json.balance_infos.length) {
      const b = r.json.balance_infos[0];
      return {
        id: 'deepseek',
        name: 'DeepSeek',
        plan: '按量 API',
        status: 'ok',
        balance: b.total_balance + ' ' + (b.currency || 'CNY'),
        balanceNum: Number(b.total_balance || 0),
        currency: b.currency || 'CNY',
        detail: '充值 ' + b.topped_up_balance + ' · 赠金 ' + b.granted_balance
      };
    }
    return { id: 'deepseek', name: 'DeepSeek', plan: '按量 API', status: 'err', error: 'HTTP ' + r.status };
  } catch (e) {
    return { id: 'deepseek', name: 'DeepSeek', plan: '按量 API', status: 'err', error: '请求失败' };
  }
}

async function fetchXPeach() {
  let key = '';
  const st = readJsonSafe(path.join(HOME, '.claude-xpeach/settings.json'));
  if (st && st.env) key = st.env.ANTHROPIC_AUTH_TOKEN || st.env.ANTHROPIC_API_KEY || '';
  if (!key) {
    try {
      const txt = fs.readFileSync(path.join(HOME, '.config/secrets/xpeach-codes.txt'), 'utf8');
      const m = txt.match(/sk-[A-Za-z0-9_-]+/);
      if (m) key = m[0];
    } catch (e) {}
  }
  if (!key) return { id: 'xpeach', name: 'XPeach', plan: 'Claude 0.5x', status: 'err', error: '未配置 Key' };

  try {
    const r = await fetchJson('https://xpeach.codes/api/usage/token/', {
      headers: { 'Authorization': 'Bearer ' + key, 'User-Agent': 'webterm/1.0' }
    });
    const d = r.json && r.json.data;
    if (r.ok && d) {
      const usedUsd = (Number(d.total_used || 0) / 500000);
      if (d.unlimited_quota) {
        return {
          id: 'xpeach',
          name: 'XPeach',
          plan: 'Claude 0.5x',
          status: 'ok',
          unlimited: true,
          usedText: '$' + usedUsd.toFixed(2),
          detail: '不限额 Key（站内总余额需网页查看）'
        };
      }
      const total = Number(d.total_granted || 0) / 500000;
      const avail = Number(d.total_available || 0) / 500000;
      const leftPct = total > 0 ? Math.max(0, Math.min(100, Math.round(avail / total * 1000) / 10)) : 0;
      return {
        id: 'xpeach',
        name: 'XPeach',
        plan: 'Claude 0.5x',
        status: 'ok',
        unlimited: false,
        usedText: '$' + usedUsd.toFixed(2),
        leftText: '$' + avail.toFixed(2),
        items: [{ label: 'Key 额度', leftPct, usedPct: Math.round((100 - leftPct) * 10) / 10 }]
      };
    }
    return { id: 'xpeach', name: 'XPeach', plan: 'Claude 0.5x', status: 'err', error: 'HTTP ' + r.status };
  } catch (e) {
    return { id: 'xpeach', name: 'XPeach', plan: 'Claude 0.5x', status: 'err', error: '请求失败' };
  }
}

function clashUnixGet(sockPath, apiPath, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    try {
      const req = http.request({ socketPath: sockPath, path: apiPath, method: 'GET' }, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_QUOTA_RESPONSE) { req.destroy(); finish(null); return; }
          chunks.push(chunk);
        });
        res.on('error', () => finish(null));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            finish(res.statusCode >= 200 && res.statusCode < 300 ? JSON.parse(raw) : null);
          } catch (e) {
            finish(null);
          }
        });
      });
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch (e) {}
        finish(null);
      });
      req.on('error', () => finish(null));
      req.end();
    } catch (e) {
      finish(null);
    }
  });
}

function parseSubscriptionUserInfo(headerVal) {
  const out = Object.create(null);
  for (const part of String(headerVal || '').split(';')) {
    const kv = part.trim().split('=');
    if (kv.length === 2) {
      const k = kv[0].trim().toLowerCase();
      const v = Number(kv[1].trim());
      if (Number.isFinite(v)) out[k] = v;
    }
  }
  return (typeof out.total === 'number' && out.total > 0) ? out : null;
}

function updateVpnHistory(subInfo) {
  const histFile = path.join(HOME, '.local/state/vpn-usage-history.json');
  const now = new Date();
  const shDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  let state = readJsonSafe(histFile);
  if (!state || typeof state !== 'object' || !state.days) {
    state = { tz: 'Asia/Shanghai', days: {} };
  }

  const used = (subInfo.upload || 0) + (subInfo.download || 0);
  const up = subInfo.upload || 0;
  const down = subInfo.download || 0;

  let cur = state.days[shDate];
  if (!cur) {
    const keys = Object.keys(state.days).sort();
    const prevKey = keys.length ? keys[keys.length - 1] : null;
    const prevLastUsed = prevKey ? state.days[prevKey].lastUsed : used;
    const baseUsed = (prevLastUsed != null && used >= prevLastUsed) ? prevLastUsed : 0;
    const prevLastUp = prevKey ? state.days[prevKey].lastUp : up;
    const prevLastDown = prevKey ? state.days[prevKey].lastDown : down;
    cur = {
      startUsed: baseUsed,
      startUp: (prevLastUp != null && up >= prevLastUp) ? prevLastUp : 0,
      startDown: (prevLastDown != null && down >= prevLastDown) ? prevLastDown : 0,
      lastUsed: used,
      lastUp: up,
      lastDown: down
    };
  } else {
    if (used < cur.startUsed) {
      // Billing cycle reset detected
      cur.startUsed = 0;
      cur.startUp = 0;
      cur.startDown = 0;
    }
    cur.lastUsed = used;
    cur.lastUp = up;
    cur.lastDown = down;
  }
  state.days[shDate] = cur;

  // Keep only last 14 days
  const allDays = Object.keys(state.days).sort();
  while (allDays.length > 14) {
    delete state.days[allDays.shift()];
  }

  try {
    fs.mkdirSync(path.dirname(histFile), { recursive: true });
    fs.writeFileSync(histFile, JSON.stringify(state));
  } catch (e) {}

  const days = Object.keys(state.days).sort().slice(-7).map((d) => {
    const rec = state.days[d];
    return {
      date: d,
      deltaBytes: Math.max(0, (rec.lastUsed || 0) - (rec.startUsed || 0))
    };
  });

  return {
    todayUsedBytes: Math.max(0, (cur.lastUsed || 0) - (cur.startUsed || 0)),
    todayUpBytes: Math.max(0, (cur.lastUp || 0) - (cur.startUp || 0)),
    todayDownBytes: Math.max(0, (cur.lastDown || 0) - (cur.startDown || 0)),
    historyDays: days
  };
}

const VPN_SUB_TTL_MS = 15 * 1000;
let vpnSubCache = null;
let vpnSubCacheAt = 0;
let vpnSubInflight = null;

async function fetchVpnSub(force = false) {
  const now = Date.now();
  if (!force && vpnSubCache && (now - vpnSubCacheAt) < VPN_SUB_TTL_MS) {
    return vpnSubCache;
  }
  if (vpnSubInflight) return vpnSubInflight;
  const work = (async () => {
    const out = { status: 'err' };
    // 1. Read subscription link from protected secrets file (never expose URL/token in JSON)
    let subUrl = '';
    try {
      subUrl = fs.readFileSync(path.join(HOME, '.config/secrets/clash-sub.txt'), 'utf8').trim();
    } catch (e) {}

    let subInfo = null;
    if (subUrl) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 8000);
        let res = await fetch(subUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': 'clash-verge/v2.0' },
          signal: ac.signal
        }).catch(() => null);
        clearTimeout(timer);
        if (res && res.ok) {
          subInfo = parseSubscriptionUserInfo(res.headers.get('subscription-userinfo'));
        }
        if (!subInfo) {
          const ac2 = new AbortController();
          const timer2 = setTimeout(() => ac2.abort(), 8000);
          res = await fetch(subUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'clash-verge/v2.0' },
            signal: ac2.signal
          }).catch(() => null);
          clearTimeout(timer2);
          if (res && res.ok) {
            subInfo = parseSubscriptionUserInfo(res.headers.get('subscription-userinfo'));
          }
          if (res?.body) await res.body.cancel().catch(() => {});
        }
      } catch (e) {}
    }

    if (subInfo) {
      const up = subInfo.upload || 0;
      const down = subInfo.download || 0;
      const used = up + down;
      const total = subInfo.total || 0;
      const left = Math.max(0, total - used);
      const usedPct = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      const leftPct = total > 0 ? Math.max(0, Math.round((left / total) * 1000) / 10) : 0;
      const hist = updateVpnHistory(subInfo);

      out.status = 'ok';
      out.subscription = {
        uploadBytes: up,
        downloadBytes: down,
        usedBytes: used,
        totalBytes: total,
        leftBytes: left,
        usedPct,
        leftPct,
        expireAt: subInfo.expire ? new Date(subInfo.expire * 1000).toISOString() : ''
      };
      out.todayUsedBytes = hist.todayUsedBytes;
      out.todayUpBytes = hist.todayUpBytes;
      out.todayDownBytes = hist.todayDownBytes;
      out.historyDays = hist.historyDays;
    } else {
      out.error = subUrl ? '订阅用量查询失败' : '未配置订阅文件';
    }

    vpnSubCache = out;
    vpnSubCacheAt = Date.now();
    return out;
  })();
  vpnSubInflight = work;
  try {
    return await work;
  } finally {
    if (vpnSubInflight === work) vpnSubInflight = null;
  }
}

let trafficStreamStarted = false;
let trafficSnapshot = { up: 0, down: 0, upTotal: 0, downTotal: 0, updatedMs: 0 };

function startTrafficStream() {
  if (trafficStreamStarted) return;
  trafficStreamStarted = true;
  const sockPath = process.env.CLASH_SOCK || '/run/clash-verge-service/users/1000/verge-mihomo.sock';
  let reconnectTimer = null;
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }
  function connect() {
    const req = http.request({ socketPath: sockPath, path: '/traffic', method: 'GET' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          if (idx > 65536) return res.destroy();
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (typeof obj.up === 'number' && typeof obj.down === 'number') {
              trafficSnapshot = {
                up: obj.up,
                down: obj.down,
                upTotal: typeof obj.upTotal === 'number' ? obj.upTotal : trafficSnapshot.upTotal,
                downTotal: typeof obj.downTotal === 'number' ? obj.downTotal : trafficSnapshot.downTotal,
                updatedMs: Date.now()
              };
            }
          } catch (e) {}
        }
        if (buf.length > 65536) res.destroy();
      });
      res.on('close', scheduleReconnect);
      res.on('error', scheduleReconnect);
      if (res.statusCode !== 200) res.destroy();
    });
    req.on('error', scheduleReconnect);
    req.setTimeout(10000, () => req.destroy());
    req.end();
  }
  connect();
}

async function fetchVpn(opts = {}) {
  const forceSub = opts.forceSub !== undefined ? !!opts.forceSub : true;
  const subData = await fetchVpnSub(forceSub);
  const result = {
    status: subData.status,
    provider: 'XDollar · Clash 订阅',
    updatedAt: new Date().toISOString()
  };
  if (subData.subscription) {
    result.subscription = subData.subscription;
    result.todayUsedBytes = subData.todayUsedBytes;
    result.todayUpBytes = subData.todayUpBytes;
    result.todayDownBytes = subData.todayDownBytes;
    result.historyDays = subData.historyDays;
  } else if (subData.error) {
    result.error = subData.error;
  }

  // 2. Local X230 Clash Verge mihomo daemon telemetry
  const sockPath = process.env.CLASH_SOCK || '/run/clash-verge-service/users/1000/verge-mihomo.sock';
  let groupName = '🔰节点选择';
  let pinTarget = '';
  let pinActive = false;
  try {
    const cfg = fs.readFileSync('/etc/clash-node-pin/config', 'utf8');
    const gm = cfg.match(/^GROUP=(.+)$/m);
    const tm = cfg.match(/^TARGET=(.+)$/m);
    if (gm) groupName = gm[1].trim();
    if (tm) pinTarget = tm[1].trim();
    pinActive = !fs.existsSync('/etc/clash-node-pin/disabled');
  } catch (e) {}

  const [proxiesRes, connsRes] = await Promise.all([
    clashUnixGet(sockPath, '/proxies'),
    clashUnixGet(sockPath, '/connections')
  ]);

  if (proxiesRes && proxiesRes.proxies) {
    const pmap = proxiesRes.proxies;
    const grp = pmap[groupName] || pmap['GLOBAL'];
    const nowNode = grp && grp.now ? grp.now : '';
    const nodeObj = nowNode ? pmap[nowNode] : null;
    const hist = nodeObj && Array.isArray(nodeObj.history) ? nodeObj.history : [];
    const lastCheck = hist.length ? hist[hist.length - 1] : null;
    result.clash = {
      status: 'ok',
      group: groupName,
      activeNode: nowNode,
      protocol: nodeObj ? (nodeObj.type || '') : '',
      delayMs: lastCheck && typeof lastCheck.delay === 'number' ? lastCheck.delay : null,
      delayAt: lastCheck && lastCheck.time ? lastCheck.time : '',
      pinTarget,
      pinActive,
      sessionUploadBytes: connsRes && typeof connsRes.uploadTotal === 'number' ? connsRes.uploadTotal : null,
      sessionDownloadBytes: connsRes && typeof connsRes.downloadTotal === 'number' ? connsRes.downloadTotal : null,
      activeConnections: connsRes && Array.isArray(connsRes.connections) ? connsRes.connections.length : 0
    };
    if (result.status !== 'ok') result.status = 'partial';
  } else {
    result.clash = { status: 'err', error: 'Clash socket 未响应' };
  }

  if (result.clash && trafficStreamStarted && trafficSnapshot.updatedMs && (Date.now() - trafficSnapshot.updatedMs) < 6000) {
    result.clash.upSpeedBps = trafficSnapshot.up;
    result.clash.downSpeedBps = trafficSnapshot.down;
  }

  return result;
}

const LIVE_PROVIDERS_TTL_MS = 20 * 1000;
let liveProvidersCache = null;
let liveProvidersAt = 0;
let liveProvidersInflight = null;

async function getLiveProviders(force = false) {
  const now = Date.now();
  if (!force && liveProvidersCache && (now - liveProvidersAt) < LIVE_PROVIDERS_TTL_MS) {
    return liveProvidersCache;
  }
  if (liveProvidersInflight) return liveProvidersInflight;
  const work = (async () => {
    const [agy, codex, deepseek, xpeach] = await Promise.all([
      fetchAntigravity({ forceCli: force, waitCli: force }),
      fetchCodex(),
      fetchDeepSeek(),
      fetchXPeach()
    ]);
    liveProvidersCache = [attachAgyAccounts(agy), codex, deepseek, xpeach];
    liveProvidersAt = Date.now();
    return liveProvidersCache;
  })();
  liveProvidersInflight = work;
  try {
    return await work;
  } finally {
    if (liveProvidersInflight === work) liveProvidersInflight = null;
  }
}

const { getTokenUsage } = require('./token-usage');

async function getLiveQuota(opts = {}) {
  const force = !!opts.force;
  const [providers, vpn] = await Promise.all([
    getLiveProviders(force),
    fetchVpn({ forceSub: force })
  ]);
  const usage = getTokenUsage({ providers, force });
  return {
    updatedAt: new Date().toISOString(),
    providers,
    vpn,
    usage
  };
}

async function getQuota(opts = false) {
  const force = typeof opts === 'object' ? !!opts.force : !!opts;
  const waitCli = typeof opts === 'object' ? !!opts.waitCli : false;
  const now = Date.now();
  if (!force && cached && (now - cachedAt) < CACHE_TTL_MS) {
    return cached;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [agy, codex, deepseek, xpeach, vpn] = await Promise.all([
        fetchAntigravity({ forceCli: force, waitCli }),
        fetchCodex(),
        fetchDeepSeek(),
        fetchXPeach(),
        fetchVpn()
      ]);
      const providers = [attachAgyAccounts(agy), codex, deepseek, xpeach];
      const usage = getTokenUsage({ providers, force });
      cached = { updatedAt: new Date().toISOString(), providers, vpn, usage };
      cachedAt = Date.now();
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// 进程启动即异步预热一次全量 Antigravity CLI 额度缓存
triggerAgyCliRefresh(false);

module.exports = { getQuota, getLiveQuota, startTrafficStream };
