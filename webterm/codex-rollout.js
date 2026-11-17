(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__wtCodexRollout = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function summarize(text) {
    const first = String(text || '').split('\n')[0].trim().replace(/\s+/g, ' ');
    return first.length > 96 ? first.slice(0, 95) + '…' : first;
  }

  function isExcludedKind(kind) {
    if (typeof kind !== 'string') return false;
    if (kind.startsWith('user.')) return false;
    return /^(?:agents_md|environments?|developer|system)\b/i.test(kind);
  }

  function isFallbackContextText(text) {
    const trimmed = String(text || '').trimStart();
    return trimmed.startsWith('# AGENTS.md instructions') || trimmed.startsWith('<environment_context>');
  }

  function normalizeContentArray(content, defaultType) {
    if (Array.isArray(content)) return content;
    if (typeof content === 'string') return [{ type: defaultType, text: content }];
    return [];
  }

  function getContentItemKinds(payload, record) {
    const meta = (payload && payload.metadata) || (record && record.metadata) || payload;
    const passthrough = meta && meta.internal_chat_message_metadata_passthrough;
    return passthrough && Array.isArray(passthrough.content_item_kinds)
      ? passthrough.content_item_kinds
      : null;
  }

  function extractUserPrompt(payload, record) {
    const content = normalizeContentArray(payload.content, 'input_text');
    const kinds = getContentItemKinds(payload, record);

    if (kinds && kinds.length > 0 && kinds.length !== content.length) {
      const hasUserKind = kinds.some((k) => typeof k === 'string' && k.startsWith('user.'));
      if (!hasUserKind) return '';
    }

    const texts = [];
    let hasInputImage = false;
    const perItemKinds = kinds && kinds.length === content.length;

    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      if (!item || typeof item !== 'object') continue;

      if (perItemKinds) {
        if (isExcludedKind(kinds[i])) continue;
      } else if (typeof item.text === 'string' && isFallbackContextText(item.text)) {
        continue;
      }

      if (item.type === 'input_image' || item.type === 'image_url') {
        hasInputImage = true;
        if (typeof item.text === 'string' && item.text.trim()) {
          texts.push(item.text.trim());
        }
        continue;
      }

      if (typeof item.text === 'string') {
        const t = item.text.trim();
        if (t) texts.push(t);
      }
    }

    if (texts.length > 0) return texts.join('\n');
    if (hasInputImage) return '[图片]';
    return '';
  }

  function extractAssistantReply(payload) {
    if (payload.phase && payload.phase !== 'commentary' && payload.phase !== 'final') {
      return '';
    }
    const content = normalizeContentArray(payload.content, 'output_text');
    const texts = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type && item.type !== 'output_text' && item.type !== 'text') continue;
      if (typeof item.text === 'string') {
        const t = item.text.trim();
        if (t) texts.push(t);
      }
    }
    return texts.join('\n');
  }

  function createIdAllocator() {
    const used = new Set();
    return function allocateId(preferred, index) {
      const raw = preferred !== undefined && preferred !== null ? String(preferred).trim() : '';
      const base = raw || `turn-${index}`;
      if (!used.has(base)) {
        used.add(base);
        return base;
      }
      let suffix = 2;
      while (used.has(`${base}-${suffix}`)) suffix++;
      const unique = `${base}-${suffix}`;
      used.add(unique);
      return unique;
    };
  }

  function finalizeTurns(rawTurns) {
    const allocateId = createIdAllocator();
    return rawTurns.map((turn, idx) => {
      const index = idx + 1;
      const reply = turn.replyParts.join('\n\n').trim();
      const lineCount = reply ? reply.split('\n').length : 0;
      return {
        id: allocateId(turn.preferredId, index),
        index,
        summary: summarize(turn.prompt),
        prompt: turn.prompt,
        promptAnsi: turn.prompt,
        reply,
        replyAnsi: reply,
        lineCount,
      };
    });
  }

  function parseCodexRollout(text) {
    const result = { threadId: '', cwd: '', model: '', turns: [] };
    if (typeof text !== 'string' || !text.trim()) return result;

    const modernTurns = [];
    const legacyTurns = [];
    let sawModernResponseItem = false;

    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') continue;

      const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;

      if (record.type === 'session_meta' && payload) {
        if (typeof payload.id === 'string' && payload.id) result.threadId = payload.id;
        if (typeof payload.cwd === 'string' && payload.cwd) result.cwd = payload.cwd;
        continue;
      }

      if (record.type === 'turn_context') {
        const tc = payload || record;
        if (typeof tc.model === 'string' && tc.model) result.model = tc.model;
        if (!result.cwd && typeof tc.cwd === 'string' && tc.cwd) result.cwd = tc.cwd;
        continue;
      }

      if (record.type === 'compacted') {
        continue;
      }

      if (record.type === 'response_item' && payload && payload.type === 'message') {
        if (payload.role === 'user') {
          sawModernResponseItem = true;
          const prompt = extractUserPrompt(payload, record);
          if (prompt) {
            modernTurns.push({ preferredId: payload.id, prompt, replyParts: [] });
          }
        } else if (payload.role === 'assistant') {
          sawModernResponseItem = true;
          const reply = extractAssistantReply(payload);
          if (reply && modernTurns.length > 0) {
            modernTurns[modernTurns.length - 1].replyParts.push(reply);
          }
        }
        continue;
      }

      if (record.type === 'event_msg' && payload) {
        if (payload.type === 'user_message') {
          const msg = typeof payload.message === 'string'
            ? payload.message
            : (typeof payload.text === 'string' ? payload.text : '');
          let prompt = msg.trim();
          if (!prompt && Array.isArray(payload.images) && payload.images.length > 0) {
            prompt = '[图片]';
          }
          if (prompt) {
            legacyTurns.push({ preferredId: payload.id, prompt, replyParts: [] });
          }
        } else if (payload.type === 'agent_message') {
          const msg = typeof payload.message === 'string'
            ? payload.message
            : (typeof payload.text === 'string' ? payload.text : '');
          const reply = msg.trim();
          if (reply && legacyTurns.length > 0) {
            legacyTurns[legacyTurns.length - 1].replyParts.push(reply);
          }
        }
      }
    }

    const chosen = (sawModernResponseItem || modernTurns.length > 0) ? modernTurns : legacyTurns;
    result.turns = finalizeTurns(chosen);
    return result;
  }

  return { parseCodexRollout };
}));
