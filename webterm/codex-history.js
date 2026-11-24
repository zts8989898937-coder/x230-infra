'use strict';
const fs = require('node:fs/promises');
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = require('node:fs').constants;
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { parseCodexRollout, isVisibleAssistantPhase } = require('./codex-rollout');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

// Codex wraps CJK prompts onto new lines at narrow terminal widths.
function normalizePrompt(prompt) {
  return String(prompt || '').normalize('NFC')
    .replace(/(\p{Script=Han})[ \t]*\r?\n[ \t]*(?=\p{Script=Han})/gu, '$1')
    .replace(/\s+/gu, ' ').trim();
}

function matchVisibleHistory(histories, visible) {
  const latest = visible.at(-1);
  if (!latest) return null;
  const previous = visible.slice(0, -1).findLast(prompt => prompt && prompt !== latest);
  // A lone short prompt such as "继续" is too easy to share across threads.
  if (!previous && Array.from(latest).length < 16) return null;

  const matches = [];
  for (const history of histories) {
    const prompts = history.turns.map(turn => normalizePrompt(turn.prompt));
    const end = prompts.lastIndexOf(latest);
    if (end < 0 || (previous && !prompts.slice(0, end).includes(previous))) continue;
    matches.push({ history, atEnd: end === prompts.length - 1 });
  }
  if (matches.length !== 1 || !matches[0].atEnd) return null;
  return matches[0].history;
}

function createCodexHistoryReader({ home = os.homedir() } = {}) {
  const base = path.join(home, '.codex');
  const cache = new Map();
  function resolveCandidates(title, cwd) {
    const name = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+\|\s+.*$/, '').trim();
    if (!name || !cwd) return null;
    let db;
    try {
      db = new DatabaseSync(path.join(base, 'state_5.sqlite'), { readOnly: true });
      const rows = db.prepare('SELECT id, cwd, rollout_path FROM threads WHERE (name = ? OR title = ?) AND cwd = ? LIMIT 9').all(name, name, cwd);
      return rows.length <= 8 ? rows : null;
    } catch { return null; }
    finally { if (db) db.close(); }
  }
  function relevant(r) {
    if (r.type === 'session_meta' || r.type === 'turn_context') return true;
    const p = r.payload || {};
    if (r.type === 'response_item') return p.type === 'message' && (p.role === 'user' || (p.role === 'assistant' && isVisibleAssistantPhase(p.phase)));
    return r.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type);
  }
  async function update(file, state) {
    const handle = await fs.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      if (stat.size < state.offset || stat.dev !== state.dev || stat.ino !== state.ino ||
          (stat.size === state.offset && stat.mtimeMs !== state.mtime)) {
        Object.assign(state, { offset: 0, tail: [], tailBytes: 0, lines: [], historyBytes: 0, result: null, overflow: false });
      }
      Object.assign(state, { dev: stat.dev, ino: stat.ino, mtime: stat.mtimeMs });
      if (state.overflow) return null;

      const initialLineCount = state.lines.length;
      const append = (part, endOfLine) => {
        if (part.length) {
          state.tail.push(part);
          state.tailBytes += part.length;
        }
        if (state.tailBytes > MAX_LINE_BYTES) return false;
        if (!endOfLine) return true;
        const line = Buffer.concat(state.tail, state.tailBytes).toString('utf8');
        state.tail = [];
        state.tailBytes = 0;
        let record;
        try { record = JSON.parse(line); } catch { return true; }
        if (!record || !relevant(record)) return true;
        const retained = JSON.stringify(record);
        state.historyBytes += Buffer.byteLength(retained) + 1;
        if (state.historyBytes > MAX_HISTORY_BYTES) return false;
        state.lines.push(retained);
        return true;
      };

      while (state.offset < stat.size) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size - state.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        state.offset += bytesRead;
        for (let start = 0; start < chunk.length;) {
          const newline = chunk.indexOf(10, start);
          const end = newline === -1 ? chunk.length : newline;
          if (!append(chunk.subarray(start, end), newline !== -1)) {
            Object.assign(state, { tail: [], tailBytes: 0, lines: [], historyBytes: 0, result: null, overflow: true, offset: stat.size });
            return null;
          }
          start = end + 1;
        }
      }
      if (state.lines.length !== initialLineCount) state.result = parseCodexRollout(state.lines.join('\n'));
      return state.result;
    } finally {
      await handle.close();
    }
  }
  async function readRow(row) {
    const file = await fs.realpath(row.rollout_path);
    if (!['sessions', 'archived_sessions'].some(dir => file.startsWith(path.join(base, dir) + path.sep)) || !file.endsWith('.jsonl')) return null;
    let state = cache.get(file);
    if (!state) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      state = { pending: null };
      cache.set(file, state);
    }
    // Concurrent readers share the same snapshot. The next poll sees later appends.
    const pending = state.pending || update(file, state);
    state.pending = pending;
    let result;
    try { result = await pending; } finally { if (state.pending === pending) state.pending = null; }
    return result && result.threadId === row.id && result.cwd === row.cwd ? result : null;
  }
  return async function read(title, cwd, terminalTurns = []) {
    try {
      const rows = resolveCandidates(title, cwd);
      if (!rows?.length) return null;
      const visible = terminalTurns.slice(-3).map(turn => normalizePrompt(turn.prompt)).filter(Boolean);
      if (rows.length === 1) {
        const history = await readRow(rows[0]);
        if (!history || !visible.length) return history;
        return normalizePrompt(history.turns.at(-1)?.prompt) === visible.at(-1) ? history : null;
      }
      if (!visible.length) return null;
      const histories = await Promise.all(rows.map(readRow));
      if (histories.some(history => !history)) return null;
      return matchVisibleHistory(histories, visible);
    } catch { return null; }
  };
}
module.exports = { createCodexHistoryReader };
