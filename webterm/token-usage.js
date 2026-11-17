'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

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
  bucket.apiValueUsd += calcCostUsd(priceKey, {
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
    codex: makeBucket('codex', 'Codex (OpenAI)', 'subscription', 'ChatGPT Plus $20/月 抵扣 ($0 额外按量)', '读取 ~/.codex/sessions；仅计 OpenAI GPT 系列'),
    glm: makeBucket('glm', 'GLM (Z.ai)', 'subscription', 'Coding Plan 订阅抵扣 ($0 额外按量)', '读取 DSH zai-coding-cn 日志'),
    xpeach: makeBucket('xpeach', 'XPeach / Claude', 'payg', '中转按量直出（XPeach API 实扣为准）', '本地仅留近端会话；实扣金额同步自 XPeach 余额接口'),
    agy: makeBucket('agy', 'Antigravity', 'subscription', 'Google AI Pro 订阅 · 仅计 DSH 路由', '原生 CLI 为二进制 .pb 未暴露 Token，仅统计经 DSH 调用量')
  };

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

  // 2. Codex CLI ~/.codex/sessions/**/*.jsonl (exact final total_token_usage per file)
  const codexFiles = listFilesRecursive(CODEX_SESSIONS_DIR, '.jsonl');
  for (const file of codexFiles) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let model = 'gpt-6.1-sol';
    let lastTs = null;
    let lastTot = null;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.timestamp) lastTs = d.timestamp;
      if (d.type === 'turn_context' && d.payload && d.payload.model) {
        model = d.payload.model;
      } else if (d.type === 'event_msg' && d.payload && d.payload.type === 'token_count' &&
        d.payload.info && d.payload.info.total_token_usage) {
        lastTot = d.payload.info.total_token_usage;
      }
    }
    if (!lastTot) continue;
    const inpAll = Number(lastTot.input_tokens) || 0;
    const cached = Number(lastTot.cached_input_tokens) || 0;
    const uncached = Math.max(0, inpAll - cached);
    const out = Number(lastTot.output_tokens) || 0;
    if (uncached + cached + out <= 0) continue;

    const group = classifyProvider('codex', model);
    const band = group === 'deepseek' && isDeepSeekPeak(lastTs) ? 'peak' : 'off';
    const bucket = buckets[group];
    addTokens(bucket, 'Codex', model, resolvePriceKey(group, model, band), {
      inputUncached: uncached,
      cacheRead: cached,
      cacheWrite: 0,
      output: out
    });
    bucket.sessions += 1;
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

  const order = ['deepseek', 'codex', 'glm', 'xpeach', 'agy'];
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

    const effectiveApiValueUsd = id === 'xpeach' && xpeachBilledUsd !== null
      ? Math.max(apiListUsd, xpeachBilledUsd)
      : apiListUsd;

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
      inputUncached: b.inputUncached,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      output: b.output,
      sessions: b.sessions,
      sources: Array.from(b.sources),
      topModels,
      apiValueUsd: Number(effectiveApiValueUsd.toFixed(2)),
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
    byProvider,
    methodology: 'Token 统计自本机 DSH / Codex / Claude Code 日志（未含 Antigravity 二进制 .pb）；DeepSeek 按官方峰/谷阶梯价估算，XPeach 取实时接口实扣，Codex/GLM/Antigravity 为订阅抵扣折算官方参考牌价（1 USD ≈ 7.25 CNY）'
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
