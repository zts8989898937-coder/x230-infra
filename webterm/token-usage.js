'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanNativeUsage } = require('./agy-native-usage');

const HOME = os.homedir();
const DSH_PROJCACHE_DIR = path.join(HOME, '.dsh/storages/session_projcache/sessions');
const CODEX_SESSIONS_DIR = path.join(HOME, '.codex/sessions');
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude/projects');

const CACHE_TTL_MS = 120 * 1000;
const USD_TO_CNY = 7.25;

// 公开 API 参考单价（USD / 1M tokens）：
// - DeepSeek 按官方文档 2026 标准峰/谷阶梯价（谷时为平时 50%；Peak = UTC Mon-Fri 01:00-04:00 & 06:00-10:00）
// - OpenAI GPT / Anthropic Claude / Zhipu GLM 按对应档位公开 API 牌价折算等值算力价值
const PRICING = {
  'deepseek-flash-peak':   { in: 0.30,  cr: 0.006, cw: 0.30,  out: 1.20 },
  'deepseek-flash-off':    { in: 0.15,  cr: 0.003, cw: 0.15,  out: 0.60 },
  'deepseek-v4-pro-peak':  { in: 1.32,  cr: 0.044, cw: 1.32,  out: 3.96 },
  'deepseek-v4-pro-off':   { in: 0.66,  cr: 0.022, cw: 0.66,  out: 1.98 },
  'gpt-frontier':          { in: 2.00,  cr: 0.20,  cw: 2.00,  out: 12.00 },
  'claude-sonnet':         { in: 2.00,  cr: 0.20,  cw: 2.50,  out: 10.00 },
  'claude-opus':           { in: 4.00,  cr: 0.40,  cw: 5.00,  out: 20.00 },
  // Gemini / Claude native reference snapshot: official Standard API prices on 2026-11-17.
  // https://aistudio.google.com/docs/pricing
  // https://platform.claude.com/docs/en/about-claude/pricing
  // Argon promotional price through Nov 30; Flash through Dec 31. Snapshot, not historical billing.
  'gemini-4-neon':         { in: 3.00, cr: 0.15, cw: 3.00, out: 15.00 },
  'gemini-4-hydrogen':     { in: 1.50, cr: 0.075, cw: 1.50, out: 7.50 },
  'gemini-4-argon':        { in: 2.00, cr: 0.10, cw: 2.00, out: 10.00 },
  'gemini-3.8-flash':      { in: 0.75, cr: 0.075, cw: 0.75, out: 3.75 },
  'claude-opus-5.5':      { in: 4.00, cr: 0.20, cw: 5.00, out: 20.00 },
  'claude-sonnet-5.5':    { in: 2.00, cr: 0.10, cw: 2.50, out: 10.00 },
  'gemini-pro':            { in: 1.25,  cr: 0.31,  cw: 1.25,  out: 5.00 },
  'gemini-flash':          { in: 0.15,  cr: 0.0375, cw: 0.15, out: 0.60 },
  'glm-5.3':               { in: 0.80,  cr: 0.08,  cw: 0.80,  out: 3.20 },
  'glm-5.3-flash':         { in: 0.15,  cr: 0.015, cw: 0.15,  out: 0.60 }
};

let cachedBase = null;
let cachedAt = 0;

function listFilesRecursive(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith(ext)) {
        out.push(full);
      }
    }
  }
  return out;
}

function isDeepSeekPeak(isoStr) {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  if (!Number.isFinite(d.getTime())) return false;
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (min >= 60 && min < 240) || (min >= 360 && min < 600);
}

function resolvePriceKey(providerGroup, model, band) {
  const m = String(model || '').toLowerCase();
  if (providerGroup === 'deepseek') {
    const isPro = m.includes('pro') || m.includes('reasoner') || m.includes('r1');
    const suffix = band === 'peak' ? 'peak' : 'off';
    return (isPro ? 'deepseek-v4-pro-' : 'deepseek-flash-') + suffix;
  }
  if (providerGroup === 'codex') return 'gpt-frontier';
  if (providerGroup === 'xpeach') return m.includes('opus') ? 'claude-opus' : 'claude-sonnet';
  if (providerGroup === 'glm') return m.includes('flash') ? 'glm-5.3-flash' : 'glm-5.3';
  if (providerGroup === 'agy') {
    if (m.includes('gemini-4-neon') || m.includes('orchestrator-neon')) return 'gemini-4-neon';
    if (m.includes('gemini-4-hydrogen')) return 'gemini-4-hydrogen';
    if (m.includes('gemini-4-argon') || m.includes('gemini-pro-orchestrator')) return 'gemini-4-argon';
    if (m.includes('gemini-3.8-flash')) return 'gemini-3.8-flash';
    if (m.includes('claude-opus-5-5')) return 'claude-opus-5.5';
    if (m.includes('claude-sonnet-5-5')) return 'claude-sonnet-5.5';
    if (m.includes('opus')) return 'claude-opus';
    if (m.includes('sonnet')) return 'claude-sonnet';
    if (m.includes('flash')) return 'gemini-flash';
    return 'gemini-pro';
  }
  return 'gpt-frontier';
}

function calcCostUsd(priceKey, t) {
  const r = PRICING[priceKey] || PRICING['gpt-frontier'];
  return (
    (t.inputUncached * r.in +
      t.cacheRead * r.cr +
      t.cacheWrite * r.cw +
      t.output * r.out) / 1e6
  );
}

function makeBucket(id, label, billingMode, billingDetail, note) {
  return {
    id,
    label,
    billingMode,
    billingDetail,
    note,
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    totalTokens: 0,
    apiValueUsd: 0,
    unpricedTokens: 0,
    sessions: 0,
    sources: new Set(),
    models: Object.create(null)
  };
}

function addTokens(bucket, sourceName, modelName, priceKey, counts) {
  const iu = Math.max(0, Number(counts.inputUncached) || 0);
  const cr = Math.max(0, Number(counts.cacheRead) || 0);
  const cw = Math.max(0, Number(counts.cacheWrite) || 0);
  const out = Math.max(0, Number(counts.output) || 0);
  const tot = iu + cr + cw + out;
  if (tot <= 0) return;

  bucket.inputUncached += iu;
  bucket.cacheRead += cr;
  bucket.cacheWrite += cw;
  bucket.output += out;
  bucket.totalTokens += tot;
  if (priceKey === null) bucket.unpricedTokens += tot;
  else bucket.apiValueUsd += calcCostUsd(priceKey, {
    inputUncached: iu,
    cacheRead: cr,
    cacheWrite: cw,
    output: out
  });
  bucket.sources.add(sourceName);
  bucket.models[modelName] = (bucket.models[modelName] || 0) + tot;
}

function classifyProvider(prov, model) {
  const p = String(prov || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p === 'agy') return 'agy';
  if (p.includes('deepseek') || m.includes('deepseek')) return 'deepseek';
  if (p.includes('zai') || m.includes('glm')) return 'glm';
  if (p === 'xpeach' || m.includes('claude')) return 'xpeach';
  if (m.includes('gemini')) return 'agy';
  if (p === 'codex' || m.includes('gpt')) return 'codex';
  return 'codex';
}

function scanAllLogs() {
  const buckets = {
    deepseek: makeBucket('deepseek', 'DeepSeek', 'payg', '按量计费 · 峰/谷 50% 阶梯', '含 DSH + Codex + Claude Code 全部 DeepSeek 调用'),
    codex: makeBucket('codex', 'Codex (OpenAI)', 'subscription', '订阅调用日志；不代表订阅费或 API 账单', '读取 ~/.codex/sessions；仅计 OpenAI GPT 系列'),
    glm: makeBucket('glm', 'GLM (Z.ai)', 'subscription', '订阅调用日志；参考价不代表实际支出', '读取 DSH zai-coding-cn 日志'),
    xpeach: makeBucket('xpeach', 'XPeach / Claude', 'payg', '中转按量直出（XPeach API 实扣为准）', '本地仅留近端会话；实扣金额同步自 XPeach 余额接口'),
    agy: makeBucket('agy', 'Antigravity', 'subscription', 'Google AI Pro 订阅 · 原生调用日志；非额外账单', '原生 SQLite gen_metadata；原生模型按 2026-11-17 官方 Standard API 标价估算；DSH agy-bridge 同源调用不重复叠加')
  };

  const native = scanNativeUsage();
  const nativeSessions = new Set();
  for (const r of native.records) {
    addTokens(buckets.agy, 'Antigravity 原生', r.model, resolvePriceKey('agy', r.model), r);
    nativeSessions.add(r.session);
  }
  buckets.agy.sessions = nativeSessions.size;
  buckets.agy.nativeCoverage = { files: native.files, generations: native.records.length, failedFiles: native.failedFiles || 0, invalidRows: native.invalidRows || 0, legacyFiles: native.legacyFiles || 0, complete: !(native.failedFiles || native.invalidRows || native.legacyFiles) };

  // 1. DSH session_projcache
  const dshFiles = listFilesRecursive(DSH_PROJCACHE_DIR, '.json');
  for (const file of dshFiles) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const cost = data && data.record && data.record.rows &&
      data.record.rows.contextTimeline && data.record.rows.contextTimeline.val &&
      data.record.rows.contextTimeline.val.cost;
    if (!cost || typeof cost !== 'object') continue;

    const touched = new Set();
    for (const [prov, models] of Object.entries(cost)) {
      if (!models || typeof models !== 'object') continue;
      for (const [model, slots] of Object.entries(models)) {
        if (!slots || typeof slots !== 'object') continue;
        const group = classifyProvider(prov, model);
        // agy-bridge invokes native agy: its DSH totals describe the same calls.
        if (group === 'agy' && native.records.length > 0) continue;
        const bucket = buckets[group];
        for (const band of ['peak', 'off']) {
          const b = slots[band];
          if (!b || typeof b !== 'object') continue;
          const iu = Number(b.uncached) || 0;
          const cr = Number(b.cacheRead) || 0;
          const cw = Number(b.cacheWrite) || 0;
          const out = Number(b.output) || 0;
          if (iu + cr + cw + out <= 0) continue;
          addTokens(bucket, 'DSH', model, resolvePriceKey(group, model, band), {
            inputUncached: iu,
            cacheRead: cr,
            cacheWrite: cw,
            output: out
          });
          touched.add(group);
        }
      }
    }
    for (const g of touched) buckets[g].sessions += 1;
  }

  // Codex counters are cumulative. Attribute only new tokens at each event.
  for (const file of listFilesRecursive(CODEX_SESSIONS_DIR, '.jsonl')) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let model = 'gpt-6.1-sol';
    let previous = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    const touched = new Set();
    for (const line of raw.split('\n')) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type === 'turn_context' && d.payload && d.payload.model) model = d.payload.model;
      if (d.type !== 'event_msg' || !d.payload || d.payload.type !== 'token_count') continue;
      const total = d.payload.info && d.payload.info.total_token_usage;
      if (!total) continue;
      const delta = {};
      for (const k of Object.keys(previous)) {
        const current = Math.max(0, Number(total[k]) || 0);
        delta[k] = Math.max(0, current - previous[k]);
        previous[k] = current;
      }
      const cached = Math.min(delta.input_tokens, delta.cached_input_tokens);
      if (delta.input_tokens + delta.output_tokens <= 0) continue;
      const group = classifyProvider('codex', model);
      const band = group === 'deepseek' && isDeepSeekPeak(d.timestamp) ? 'peak' : 'off';
      addTokens(buckets[group], 'Codex', model, resolvePriceKey(group, model, band), {
        inputUncached: delta.input_tokens - cached,
        cacheRead: cached, cacheWrite: 0, output: delta.output_tokens
      });
      touched.add(group);
    }
    for (const group of touched) buckets[group].sessions += 1;
  }

  // 3. Claude Code CLI ~/.claude/projects/**/*.jsonl (deduplicated by message.id / uuid)
  const claudeFiles = listFilesRecursive(CLAUDE_PROJECTS_DIR, '.jsonl');
  const seenMsgs = new Set();
  for (const file of claudeFiles) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const touched = new Set();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = (d.message && typeof d.message === 'object') ? d.message : d;
      const u = msg.usage;
      if (!u || typeof u !== 'object') continue;
      const mid = msg.id || d.uuid;
      if (mid) {
        if (seenMsgs.has(mid)) continue;
        seenMsgs.add(mid);
      }
      const model = msg.model || d.model || 'unknown';
      const iu = Number(u.input_tokens) || 0;
      const cr = Number(u.cache_read_input_tokens) || 0;
      const cw = Number(u.cache_creation_input_tokens) || 0;
      const out = Number(u.output_tokens) || 0;
      if (iu + cr + cw + out <= 0) continue;

      const group = classifyProvider('', model);
      const band = group === 'deepseek' && isDeepSeekPeak(d.timestamp) ? 'peak' : 'off';
      const bucket = buckets[group];
      addTokens(bucket, 'ClaudeCode', model, resolvePriceKey(group, model, band), {
        inputUncached: iu,
        cacheRead: cr,
        cacheWrite: cw,
        output: out
      });
      touched.add(group);
    }
    for (const g of touched) buckets[g].sessions += 1;
  }

  return buckets;
}

function parseMoney(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function finalizeUsage(buckets, providers) {
  const xpeachLive = Array.isArray(providers) ? providers.find((p) => p && p.id === 'xpeach') : null;
  const dsLive = Array.isArray(providers) ? providers.find((p) => p && p.id === 'deepseek') : null;
  const xpeachRaw = xpeachLive ? (xpeachLive.usedUsd ?? xpeachLive.usedText) : null;
  const xpeachBilledUsd = parseMoney(xpeachRaw);
  const dsRaw = dsLive ? (dsLive.balanceNum ?? dsLive.balanceCny ?? dsLive.balance) : null;
  const dsRemainingCny = parseMoney(dsRaw);

  let totalTokens = 0;
  let totalInputUncached = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let totalApiValueUsd = 0;
  let totalPaygSpentUsd = 0;

  const order = ['agy', 'deepseek', 'codex', 'glm', 'xpeach'];
  const byProvider = order.map((id) => {
    const b = buckets[id];
    const apiListUsd = b.apiValueUsd;
    let paygUsd = 0;
    let paygSource = 'subscription';
    if (id === 'xpeach') {
      paygUsd = xpeachBilledUsd !== null ? xpeachBilledUsd : apiListUsd;
      paygSource = xpeachBilledUsd !== null ? 'api_billed' : 'estimated';
    } else if (id === 'deepseek') {
      paygUsd = apiListUsd;
      paygSource = 'estimated_peak_off';
    }

    const effectiveApiValueUsd = apiListUsd; // Reference value and account billing have different scopes.

    totalTokens += b.totalTokens;
    totalInputUncached += b.inputUncached;
    totalCacheRead += b.cacheRead;
    totalCacheWrite += b.cacheWrite;
    totalOutput += b.output;
    totalApiValueUsd += effectiveApiValueUsd;
    totalPaygSpentUsd += paygUsd;

    const topModels = Object.entries(b.models)
      .sort((a, c) => c[1] - a[1])
      .slice(0, 3)
      .map(([name, tokens]) => ({ name, tokens }));

    return {
      id: b.id,
      label: b.label,
      billingMode: b.billingMode,
      billingDetail: b.billingDetail,
      note: b.note,
      totalTokens: b.totalTokens,
      unpricedTokens: b.unpricedTokens,
      inputUncached: b.inputUncached,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      output: b.output,
      sessions: b.sessions,
      sources: Array.from(b.sources),
      topModels,
      apiValueUsd: b.unpricedTokens === b.totalTokens && b.totalTokens > 0 ? null : Number(effectiveApiValueUsd.toFixed(2)),
      apiValueCny: Number((effectiveApiValueUsd * USD_TO_CNY).toFixed(2)),
      paygSpentUsd: Number(paygUsd.toFixed(2)),
      paygSpentCny: Number((paygUsd * USD_TO_CNY).toFixed(2)),
      paygSource
    };
  });

  return {
    scannedAt: new Date(cachedAt || Date.now()).toISOString(),
    fxUsdToCny: USD_TO_CNY,
    totalTokens,
    unpricedTokens: byProvider.reduce((n, p) => n + p.unpricedTokens, 0),
    breakdown: {
      inputUncached: totalInputUncached,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      output: totalOutput
    },
    apiValueUsd: Number(totalApiValueUsd.toFixed(2)),
    apiValueCny: Number((totalApiValueUsd * USD_TO_CNY).toFixed(2)),
    paygSpentUsd: Number(totalPaygSpentUsd.toFixed(2)),
    paygSpentCny: Number((totalPaygSpentUsd * USD_TO_CNY).toFixed(2)),
    deepseekRemainingCny: dsRemainingCny !== null ? Number(dsRemainingCny.toFixed(2)) : null,
    xpeachBilledUsd: xpeachBilledUsd !== null ? Number(xpeachBilledUsd.toFixed(2)) : null,
    nativeAntigravity: buckets.agy.nativeCoverage,
    nativePricing: { asOf: '2026-11-17', basis: 'Standard API 参考价快照；非历史账单', source: 'https://aistudio.google.com/docs/pricing', claudeSource: 'https://platform.claude.com/docs/en/about-claude/pricing', note: '按输入/缓存命中/输出分别计价；trial、tiered、思考档位按基础型号；内部 orchestrator 别名近似按 Argon；不含工具与缓存存储费' },
    confirmedBilledUsd: xpeachBilledUsd,
    estimatedPaygUsd: Number(byProvider.filter(p => p.billingMode === 'payg' && p.paygSource !== 'api_billed').reduce((n, p) => n + p.paygSpentUsd, 0).toFixed(2)),
    byProvider,
    methodology: 'Token 统计自本机 DSH / Codex / Claude Code / Antigravity 原生数据库；DSH 的 agy-bridge 调用与原生同源，不重复叠加；日志累计含重复发送的上下文与缓存输入，不是新增文字量；DeepSeek 按峰/谷参考价估算（未校正历史价格与法定节假日），XPeach 为接口累计实扣，两者范围可能不同；订阅模型按配置参考价折算，不是账单或节省金额；固定换算 1 USD = 7.25 CNY，非实时汇率'
  };
}

function getTokenUsage({ providers = null, force = false } = {}) {
  const now = Date.now();
  // Always honor at least 30s debounce even on manual refresh so HTTP polling stays sub-millisecond
  const ttl = force ? 30 * 1000 : CACHE_TTL_MS;
  if (!cachedBase || (now - cachedAt) >= ttl) {
    cachedBase = scanAllLogs();
    cachedAt = Date.now();
  }
  return finalizeUsage(cachedBase, providers);
}

module.exports = { getTokenUsage };
