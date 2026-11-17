'use strict';
// Local schema-v1 generation metadata only. Never read step transcripts.
// Field tags checked against the installed agy Go protobuf descriptors.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

function decode(bytes) {
  const b = Buffer.from(bytes), fields = new Map();
  let at = 0;
  function varint() {
    let n = 0n, shift = 0n;
    for (let i = 0; i < 10 && at < b.length; i++) {
      const v = b[at++]; n |= BigInt(v & 127) << shift;
      if (!(v & 128)) return n;
      shift += 7n;
    }
    throw Error('Invalid varint');
  }
  while (at < b.length) {
    const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!number) throw Error('Invalid field');
    let value;
    if (wire === 0) value = Number(varint());
    else if (wire === 2) {
      const len = Number(varint());
      if (!Number.isSafeInteger(len) || len > b.length - at) throw Error('Invalid length');
      value = b.subarray(at, at + len); at += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      if (at + len > b.length) throw Error('Truncated field');
      value = b.subarray(at, at + len); at += len;
    } else throw Error('Unsupported wire type');
    if (!fields.has(number)) fields.set(number, []);
    fields.get(number).push(value);
  }
  return fields;
}
const first = (f, n) => (f.get(n) || [])[0];
const text = x => Buffer.isBuffer(x) ? x.toString('utf8') : '';
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : 0;
function generation(data) {
  const chatBytes = first(decode(data), 1);
  if (!chatBytes) return null;
  const chat = decode(chatBytes), usageBytes = first(chat, 4);
  if (!usageBytes) return null;
  const u = decode(usageBytes);
  const inputUncached = count(first(u, 2)), cacheWrite = count(first(u, 4)), cacheRead = count(first(u, 5));
  // Output field 3 includes reasoning. The optional 9/10 split must not be added again.
  const output = first(u, 3) === undefined ? count(first(u, 9)) + count(first(u, 10)) : count(first(u, 3));
  if (inputUncached + cacheWrite + cacheRead + output === 0) return null;
  const raw = text(first(chat, 19));
  const display = text(first(chat, 21));
  const model = [raw, display].find(m => /gemini|claude|gpt/i.test(m)) || 'unknown-native-model';
  return { model, inputUncached, cacheRead, cacheWrite, output, responseId: text(first(u, 11)) };
}

function scanNativeUsage(roots = ['antigravity-cli', 'antigravity', 'antigravity-ide'].map(app => path.join(os.homedir(), '.gemini', app, 'conversations'))) {
  const records = [], seen = new Set();
  let files = 0, failedFiles = 0, invalidRows = 0, legacyFiles = 0;
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (name.endsWith('.pb')) { legacyFiles++; continue; }
      if (!name.endsWith('.db')) continue;
      files++;
      let db;
      try {
        db = new DatabaseSync(path.join(root, name), { readOnly: true });
        if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw Error('Unknown schema');
        for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').iterate()) {
          try {
            const r = generation(row.data);
            if (!r) continue;
            const key = r.responseId ? 'response:' + r.responseId : name + ':' + row.idx;
            if (seen.has(key)) continue;
            seen.add(key);
            records.push({ ...r, session: name.slice(0, -3) });
          } catch { invalidRows++; }
        }
      } catch { failedFiles++; }
      finally { if (db) db.close(); }
    }
  }
  return { records, files, failedFiles, invalidRows, legacyFiles };
}
module.exports = { scanNativeUsage };
