'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { parseCodexRollout } = require('./codex-rollout');

function createCodexHistoryReader({ home = os.homedir() } = {}) {
  const base = path.join(home, '.codex');
  const cache = new Map();
  function resolve(title, cwd) {
    const name = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+\|\s+.*$/, '').trim();
    if (!name || !cwd) return null;
    let db;
    try {
      db = new DatabaseSync(path.join(base, 'state_5.sqlite'), { readOnly: true });
      const rows = db.prepare('SELECT id, cwd, rollout_path FROM threads WHERE (name = ? OR title = ?) AND cwd = ?').all(name, name, cwd);
      if (rows.length !== 1) return null;
      return rows[0];
    } catch { return null; }
    finally { if (db) db.close(); }
  }
  function relevant(r) {
    if (r.type === 'session_meta' || r.type === 'turn_context') return true;
    const p = r.payload || {};
    if (r.type === 'response_item') return p.type === 'message' && (p.role === 'user' || (p.role === 'assistant' && (!p.phase || ['commentary', 'final'].includes(p.phase))));
    return r.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type);
  }
  async function update(file, state) {
    const stat = await fs.stat(file);
    if (stat.size < state.offset || stat.ino !== state.ino || (stat.size === state.offset && stat.mtimeMs !== state.mtime)) {
      state.offset = 0; state.tail = ''; state.lines = []; state.result = null;
    }
    if (stat.size !== state.offset) {
      const handle = await fs.open(file, 'r');
      let buffer;
      try {
        buffer = Buffer.alloc(stat.size - state.offset);
        let read = 0;
        while (read < buffer.length) {
          const part = await handle.read(buffer, read, buffer.length - read, state.offset + read);
          if (!part.bytesRead) break;
          read += part.bytesRead;
        }
        buffer = buffer.subarray(0, read);
      } finally { await handle.close(); }
      // Keep bytes until a newline, including UTF-8 characters split across writes.
      const combined = Buffer.concat([Buffer.isBuffer(state.tail) ? state.tail : Buffer.from(state.tail), buffer]);
      const end = combined.lastIndexOf(10);
      state.tail = combined.subarray(end + 1);
      if (end >= 0) for (const line of combined.subarray(0, end).toString('utf8').split('\n')) {
        try { const r = JSON.parse(line); if (relevant(r)) state.lines.push(JSON.stringify(r)); } catch {}
      }
      state.offset += buffer.length;
      state.result = parseCodexRollout(state.lines.join('\n'));
    }
    state.ino = stat.ino; state.mtime = stat.mtimeMs;
    return state.result;
  }
  return async function read(title, cwd) {
    try {
      const row = resolve(title, cwd);
      if (!row) return null;
      const file = await fs.realpath(row.rollout_path);
      if (!['sessions', 'archived_sessions'].some(dir => file.startsWith(path.join(base, dir) + path.sep)) || !file.endsWith('.jsonl')) return null;
      let state = cache.get(file);
      if (!state) {
        if (cache.size >= 16) cache.delete(cache.keys().next().value);
        state = { offset: 0, tail: '', lines: [], result: null, pending: null }; cache.set(file, state);
      }
      // Concurrent callers share one update, then check again for newly appended bytes.
      const pending = (state.pending || Promise.resolve()).catch(() => {}).then(() => update(file, state)); state.pending = pending;
      let result;
      try { result = await pending; } finally { if (state.pending === pending) state.pending = null; }
      return result && result.threadId === row.id && result.cwd === row.cwd ? result : null;
    } catch { return null; }
  };
}
module.exports = { createCodexHistoryReader };
