(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__wtHistoryParser = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  const LEADING_SGR_RE = /^(?:\x1b\[[0-9;:]*m)+/;

  const RULE_RE = /^[─━\-=]{12,}\s*$/;
  const AGY_PROMPT_RE = /^>\s+(.*\S)\s*$/;
  const AGY_EMPTY_RE = /^>\s*$/;
  const CODEX_PROMPT_RE = /^›\s+(.*\S)\s*$/;
  const CODEX_EMPTY_RE = /^›\s*$/;
  const CLAUDE_PROMPT_RE = /^❯\s+(.*\S)\s*$/;
  const CLAUDE_EMPTY_RE = /^❯\s*$/;
  const FISH_PROMPT_RE = /^╰─[^\s]*\s+(.*\S)\s*$/;
  const PLACEHOLDER_RE = /^(?:Ask Codex to do anything|Ask anything|Type a message|Send a message|Message\b.*)\s*$/i;
  const FOOTER_RE = /^\s*(?:esc to cancel.*|Press up to edit.*|\?\s*for shortcuts.*|←\s*for agents.*|shift\+tab.*|(?:auto|plan|accept-edits)\s*·\s*.*|GPT-[0-9A-Za-z._-]+\s+.*·\s*\/.*)\s*$/i;
  const RESPONSE_START_RE = /^(?:[○●▸•◆└├│┌╰╭]\s|Worked for\s+\d)/;
  const STEP_LINE_RE = /^\s*(?:[○●▸•]\s+(?:Thought|Ran|Explored|Searched|Read|Edited|Wrote|Updated|Created|Deleted|Checked|Called)|Worked for\s+\d)/;

  function stripAnsi(s) {
    return String(s || '').replace(ANSI_RE, '');
  }

  function trimAnsiRight(s) {
    return String(s || '').replace(/[ \t]+$/, '');
  }

  // Strip the prompt marker prefix (`> `, `› `, `❯ `, `╰─... `) while preserving ANSI SGR styling.
  function stripPromptPrefixAnsi(rawLine, markerChar) {
    let s = trimAnsiRight(rawLine);
    let prefixSgr = '';
    const lead = s.match(LEADING_SGR_RE);
    if (lead) {
      prefixSgr = lead[0];
      s = s.slice(prefixSgr.length);
    }
    const idx = s.indexOf(markerChar);
    if (idx !== -1 && !stripAnsi(s.slice(0, idx)).trim()) {
      s = s.slice(idx + markerChar.length).replace(/^(?:(?:\x1b\[[0-9;:]*m)*[ \t]+)+/, '');
      if (markerChar === '╰') {
        s = s.replace(/^\S*[ \t]+/, '');
      }
      return prefixSgr + s;
    }
    return rawLine;
  }

  function trimBlankEdges(items, plainOf) {
    let start = 0;
    let end = items.length;
    while (start < end && !plainOf(items[start]).trim()) start++;
    while (end > start && !plainOf(items[end - 1]).trim()) end--;
    return items.slice(start, end);
  }

  function stripBottomChrome(rawLines, plainLines) {
    let end = plainLines.length;
    while (end > 0) {
      const s = plainLines[end - 1].trim();
      if (!s || RULE_RE.test(s) || FOOTER_RE.test(s) ||
          AGY_EMPTY_RE.test(s) || CODEX_EMPTY_RE.test(s) || CLAUDE_EMPTY_RE.test(s) ||
          /^(?:[•●✳\u2800-\u28ff]\s+Working\s*\(.*esc to interrupt.*\)|[\u2800-\u28ff]\s{1,3}(?:Running|Thinking|Generating|Planning|Reading|Searching|Editing|Waiting|Processing|Compacting|Exploring)\b.*|(?:[›└├]\s+)?Tip:\s+.*)$/i.test(s) ||
          /^[•●]\s+\[\d{1,2}:\d{2}(?::\d{2})?\]\s+.*\s+(?:running|completed|failed|stopped)\s*$/i.test(s) ||
          /^[›>❯]\s+(?:Ask Codex to do anything|Ask anything)\s*$/i.test(s) ||
          /^╭[─╴]/.test(s) || /^╰─[^\s]*\s*$/.test(s)) {
        end--;
      } else {
        break;
      }
    }
    return {
      rawLines: rawLines.slice(0, end),
      plainLines: plainLines.slice(0, end)
    };
  }

  const AGENT_CMD_NAMES = new Set(['agy', 'codex', 'claude', 'opencode', 'hermes', 'kimi', 'gemini', 'aider', 'goose', 'qwen', 'amp', 'droid']);

  function detectAgentKind(cmd, splitPlain, meta) {
    const rawCmd = String(cmd || '').trim().toLowerCase();
    if (['fish', 'bash', 'zsh', 'sh', 'dash', 'tcsh', 'csh'].includes(rawCmd)) return '';
    if (AGENT_CMD_NAMES.has(rawCmd)) return rawCmd;
    for (const name of AGENT_CMD_NAMES) {
      if (rawCmd.startsWith(name + '-') || rawCmd.startsWith(name + '.')) return name;
    }
    const title = String((meta && meta.paneTitle) || '');
    const sample = title + '\n' + splitPlain.slice(0, 35).join('\n') + '\n' + splitPlain.slice(-15).join('\n');
    if (/Antigravity CLI|Gemini\s+\d+\s+Hydrogen/i.test(sample)) return 'agy';
    if (/OpenAI Codex|Ask Codex to do anything|\bGPT-[0-9A-Za-z._-]+/i.test(sample)) return 'codex';
    if (/Claude Code|Bypass Permissions|accept edits on/i.test(sample)) return 'claude';
    if (/\bopencode\b/i.test(sample)) return 'opencode';
    if (/Hermes Agent|☤/.test(sample)) return 'hermes';
    if (/\bKimi\b/i.test(sample)) return 'kimi';
    if (/\bGemini CLI\b/i.test(sample)) return 'gemini';
    return '';
  }

  function extractFooterModel(splitPlain, agent) {
    for (let i = splitPlain.length - 1; i >= Math.max(0, splitPlain.length - 14); i--) {
      const s = splitPlain[i].trim();
      if (!s) continue;
      if (agent === 'codex') {
        const m = s.match(/\b(GPT-[0-9A-Za-z._-]+(?:\s+(?:low|medium|high|xhigh))?)\b/i);
        if (m) return m[1];
      }
      if (agent === 'agy') {
        const modeMatch = s.match(/(?:^|\s)(?:auto|plan|accept-edits|manual)\s*·\s*(.+)$/i);
        if (modeMatch) {
          const parts = modeMatch[1].split(/\s*·\s*/).map(p => p.trim())
            .filter(p => p && !/^(?:\d+\s+task\(s\)|\/tasks|\?\s*for\s+shortcuts|esc\s+to\s+cancel)$/i.test(p));
          if (parts.length) return parts.slice(0, 2).join(' · ');
        }
        const m = s.match(/((?:Orchestrator(?:\s*\([^)]+\))?|Gemini\s+[^·\n]+|Claude\s+[^·\n]+|GPT-[0-9A-Za-z._-]+[^·\n]*)(?:\s*·\s*(?:low|medium|high|xhigh|max))?)/i);
        if (m) return m[1].trim();
      }
      if (agent === 'claude') {
        const m = s.match(/\b((?:Claude\s+)?(?:Opus|Sonnet|Haiku)\s*[0-9.]*[^\s·]*)/i);
        if (m) return m[1];
      }
    }
    return '';
  }

  function matchUserPrompt(plainLine, prevPlainLine, cmd, agent) {
    const trimmed = plainLine.replace(/\s+$/, '');
    const prev = (prevPlainLine || '').trim();
    const boundaryBefore = !prev || RULE_RE.test(prev) || /^╭/.test(prev) || /^╰─/.test(prev) || /^Worked for\s+/.test(prev) || /Conversation compacted/i.test(prev);

    let m = (!agent || agent === 'codex') ? trimmed.match(CODEX_PROMPT_RE) : null;
    if (m && !PLACEHOLDER_RE.test(m[1])) return { kind: agent || 'codex', marker: '›', text: m[1] };

    m = (!agent || agent === 'claude') ? trimmed.match(CLAUDE_PROMPT_RE) : null;
    if (m && !PLACEHOLDER_RE.test(m[1])) return { kind: agent || 'claude', marker: '❯', text: m[1] };

    m = (!agent || agent === 'agy') ? trimmed.match(AGY_PROMPT_RE) : null;
    if (m && boundaryBefore && !PLACEHOLDER_RE.test(m[1])) {
      return { kind: agent || 'agy', marker: '>', text: m[1] };
    }

    if (!agent) {
      m = trimmed.match(FISH_PROMPT_RE);
      if (m) return { kind: 'shell', marker: '╰', text: m[1] };
    }
    return null;
  }

  function summarize(text) {
    const first = String(text || '').split('\n')[0].trim().replace(/\s+/g, ' ');
    return first.length > 96 ? first.slice(0, 95) + '…' : first;
  }

  function extractBannerPairs(cleanPre, agent) {
    if (!cleanPre || !cleanPre.length) return [];
    const limit = Math.min(cleanPre.length, 36);

    // 1. Antigravity CLI startup pixel-A + metadata header
    for (let i = 0; i < limit; i++) {
      const p = cleanPre[i].plain;
      if (/Antigravity CLI/i.test(p)) {
        const start = Math.max(0, i - 1);
        let end = i;
        while (end + 1 < limit && end - start < 7 && cleanPre[end + 1].plain.trim()) end++;
        let top = start;
        while (top > 0 && cleanPre[top - 1].plain.trim() && /[▄▀█]/.test(cleanPre[top - 1].plain)) top--;
        return cleanPre.slice(top, end + 1);
      }
    }

    // 2. Boxed startup banner (`╭─ ...` ... `╰─ ...`) across Codex, Claude Code, OpenCode, Hermes, etc.
    for (let i = 0; i < limit; i++) {
      const p = cleanPre[i].plain.trimStart();
      if (/^╭[─╴]/.test(p) && !/^╭╴\S+\s+at\s+/.test(p)) {
        let j = i;
        let matchedAgent = /Codex|Claude Code|OpenAI|opencode|Hermes|Kimi|Gemini/i.test(p);
        while (j + 1 < limit && j - i < 14) {
          j++;
          const jp = cleanPre[j].plain.trimStart();
          if (/Codex|Claude Code|OpenAI|opencode|Hermes|Kimi|Gemini|model:|directory:|version/i.test(jp)) matchedAgent = true;
          if (/^╰[─┘]/.test(jp)) break;
        }
        if (matchedAgent && /^╰[─┘]/.test(cleanPre[j].plain.trimStart())) {
          return cleanPre.slice(i, j + 1);
        }
      }
    }

    // 3. Claude / OpenCode / Hermes / Kimi / Gemini pixel or emblem headers
    for (let i = 0; i < limit; i++) {
      const p = cleanPre[i].plain;
      if (/Claude Code|Hermes Agent|\bopencode\b|\bKimi\b|\bGemini CLI\b|[▐▛▜▝▘█]{4,}/i.test(p)) {
        let top = i;
        while (top > 0 && cleanPre[top - 1].plain.trim() && /[▄▀█▐▛▜▝▘☤]/.test(cleanPre[top - 1].plain)) top--;
        let end = i;
        while (end + 1 < limit && end - top < 7 && cleanPre[end + 1].plain.trim()) end++;
        return cleanPre.slice(top, end + 1);
      }
    }

    return [];
  }

  function synthesizeFallbackBanner(agent, model, meta) {
    if (!agent) return null;
    const cwd = (meta && meta.panePath) ? String(meta.panePath) : '/';
    const title = (meta && meta.paneTitle) ? String(meta.paneTitle).trim() : '';
    const labels = {
      agy: { name: 'Antigravity CLI', badge: '✦', c: '38;5;214', detail: model || 'Gemini' },
      codex: { name: 'OpenAI Codex', badge: '◎', c: '38;5;110', detail: model || (title && title !== '/' ? title.split('|')[0].trim() : 'GPT') },
      claude: { name: 'Claude Code', badge: '✳', c: '38;5;173', detail: model || 'Claude' },
      opencode: { name: 'opencode', badge: '▪', c: '38;5;110', detail: model || 'Agent' },
      hermes: { name: 'Hermes Agent', badge: '☤', c: '38;5;180', detail: model || 'Hermes' },
      kimi: { name: 'Kimi CLI', badge: '◐', c: '38;5;141', detail: model || 'Kimi' },
      gemini: { name: 'Gemini CLI', badge: '✦', c: '38;5;110', detail: model || 'Gemini' }
    };
    const cfg = labels[agent] || { name: agent, badge: '◆', c: '38;5;214', detail: model || 'CLI Agent' };
    const line1Plain = `${cfg.badge}  ${cfg.name}${cfg.detail ? '  ·  ' + cfg.detail : ''}`;
    const line2Plain = `   ${cwd}`;
    const line1Ansi = `\x1b[1;${cfg.c}m${cfg.badge}\x1b[0m  \x1b[1m${cfg.name}\x1b[0m${cfg.detail ? `  \x1b[2m·\x1b[0m  \x1b[${cfg.c}m${cfg.detail}\x1b[0m` : ''}`;
    const line2Ansi = `   \x1b[2m${cwd}\x1b[0m`;
    return {
      banner: `${line1Plain}\n${line2Plain}`,
      bannerAnsi: `${line1Ansi}\n${line2Ansi}`
    };
  }

  function cleanReplyPairs(pairs) {
    const trimmed = trimBlankEdges(pairs, p => p.plain);
    const merged = [];
    for (let i = 0; i < trimmed.length; i++) {
      const p = trimmed[i];
      if (RULE_RE.test(p.plain.trim()) && (i === 0 || i === trimmed.length - 1)) continue;
      // Merge wrapped orphan TUI bullets (`  •\n  item text`) back onto the item line.
      const bm = p.plain.match(/^([ \t]*)•[ \t]*$/);
      if (bm && i + 1 < trimmed.length) {
        const nextP = trimmed[i + 1];
        const nm = nextP.plain.match(/^([ \t]*)(\S.*)$/);
        if (nm && nm[1].length >= bm[1].length && !/^[○▸●•└├│]/.test(nm[2])) {
          merged.push({
            plain: `${bm[1]}• ${nm[2]}`,
            ansi: `${p.ansi.replace(/[ \t]+$/, '')} ${nextP.ansi.replace(/^(?:(?:\x1b\[[0-9;:]*m)*[ \t]+)+/, m => m.replace(/[ \t]+/g, ''))}`
          });
          i++;
          continue;
        }
      }
      merged.push(p);
    }
    return trimBlankEdges(merged, p => p.plain);
  }

  function finalizeTurn(current, idx) {
    const replyPairs = cleanReplyPairs(current.replyPairs);
    const promptPlain = current.promptPlain.join('\n').trim();
    return {
      index: idx,
      kind: current.kind,
      prompt: promptPlain,
      promptAnsi: current.promptAnsi.join('\n').trim(),
      summary: summarize(promptPlain),
      reply: replyPairs.map(p => p.plain).join('\n'),
      replyAnsi: replyPairs.map(p => p.ansi).join('\n'),
      lineCount: replyPairs.length,
      stepCount: replyPairs.filter(p => STEP_LINE_RE.test(p.plain)).length
    };
  }

  function parseTerminalHistory(rawText, cmd = '', meta = {}) {
    const normalized = String(rawText || '').replace(/\r\n?/g, '\n');
    let splitRaw = normalized.split('\n');
    let splitPlain = splitRaw.map(stripAnsi);
    // Native pickers share prompt markers with dialogue. Only remove a recognized
    // trailing picker when its navigation footer is present, outside code fences.
    const NATIVE_MENU_HEADING_RE = /^(?:Switch Model|Select Model(?: and Effort)?|Select Reasoning Effort|Select Reasoning Level for(?: .*)?|Update Model Permissions|Permission Config Editor|Resume Session|Select Session|Switch Session|Select Conversation|Choose Session|Select Theme|Manage MCP Servers|MCP Servers|Select Agent|Skills|Compact Conversation|Antigravity CLI\s+general\s+commands\s+shortcuts.*)$/i;
    const NATIVE_MENU_FOOTER_RE = /(?:enter (?:to )?(?:select|default|confirm|resume).*esc\s*(?:to\s*)?(?:back|close|cancel)|Keyboard:.*(?:Navigate|Select|Switch View).*esc|(?:↑\/↓|up\/down).*enter.*esc)/i;
    let menuActive = '', menuStart = -1, inFence = '';
    for (let i = 0; i < splitPlain.length; i++) {
      const t = splitPlain[i].trim();
      const fence = t.match(/^(`{3,}|~{3,})/);
      if (fence) {
        if (!inFence) inFence = fence[1];
        else if (fence[1][0] === inFence[0] && fence[1].length >= inFence.length) inFence = '';
      }
      if (!inFence && NATIVE_MENU_HEADING_RE.test(t)) menuStart = i;
    }
    if (menuStart >= 0 && splitPlain.slice(menuStart).some(l => NATIVE_MENU_FOOTER_RE.test(l))) {
      menuActive = splitPlain[menuStart].trim();
      splitRaw = splitRaw.slice(0, menuStart);
      splitPlain = splitPlain.slice(0, menuStart);
    }
    const agent = detectAgentKind(cmd, splitPlain, meta);
    const model = extractFooterModel(splitPlain, agent);
    if (agent === 'agy') {
      let codeFence = '';
      for (let i = 0; i < splitPlain.length - 2; i++) {
        const line = splitPlain[i].trim(), marker = line.match(/^(`{3,}|~{3,})/);
        if (marker) {
          if (!codeFence) codeFence = marker[1];
          else if (marker[1][0] === codeFence[0] && marker[1].length >= codeFence.length && !line.slice(marker[1].length).trim()) codeFence = '';
        }
        if (!codeFence && i >= splitPlain.length - 40 && RULE_RE.test(line) && AGY_EMPTY_RE.test(splitPlain[i + 1].trim()) && RULE_RE.test(splitPlain[i + 2].trim())) {
          splitRaw = splitRaw.slice(0, i); splitPlain = splitPlain.slice(0, i); break;
        }
      }
    }
    const { rawLines, plainLines } = stripBottomChrome(splitRaw, splitPlain);
    const turns = [];
    const preamblePairs = [];
    let current = null;
    let fence = null;

    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i];
      const plainLine = plainLines[i];
      const prevPlain = i > 0 ? plainLines[i - 1] : '';
      const hit = fence ? null : matchUserPrompt(plainLine, prevPlain, cmd, agent);
      const fenceMatch = plainLine.trimStart().match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length && !plainLine.trim().slice(marker.length).trim()) fence = null;
      }
      if (hit) {
        if (current) turns.push(finalizeTurn(current, turns.length + 1));

        const promptPlain = [hit.text];
        const promptAnsi = [stripPromptPrefixAnsi(rawLine, hit.marker)];
        // Collect indented wrapped continuation lines belonging to the same user prompt.
        const promptStyled = /\x1b\[(?:1|38;|48;)/.test(rawLine);
        const promptHasBg = /\x1b\[48;/.test(rawLine);
        while (i + 1 < rawLines.length) {
          const nextRaw = rawLines[i + 1];
          const nextPlain = plainLines[i + 1].replace(/\s+$/, '');
          if (!nextPlain.trim() || RULE_RE.test(nextPlain.trim()) || FOOTER_RE.test(nextPlain)) break;
          if (!/^\s{2,}\S/.test(nextPlain)) break;
          if (promptHasBg && (!/\x1b\[48;/.test(nextRaw) || /\x1b\[(?:[0-9;]*;)?49m/.test(nextRaw))) break;
          if (promptStyled && /^(?:\x1b\[(?:0|2|39|49)m|\x1b\[[0-9;]*49m)/.test(nextRaw)) break;
          const inner = nextPlain.trim();
          if (RESPONSE_START_RE.test(inner)) break;
          if (/^(?:\+\s*\d+\s+lines?\b|\(\+\d+\s+lines?\)|\[Drive\]|\(?\^?ctrl\+[ot]\s+to\s+expand\)?|\(\^t\s+to\s+expand\))/i.test(inner)) break;
          promptPlain.push(inner);
          promptAnsi.push(trimAnsiRight(nextRaw).replace(/^(?:(?:\x1b\[[0-9;:]*m)*[ \t]+)+/, m => m.replace(/[ \t]+/g, '')));
          i++;
        }
        current = { kind: hit.kind, promptPlain, promptAnsi, replyPairs: [] };
        continue;
      }

      const pair = { plain: plainLine, ansi: trimAnsiRight(rawLine) };
      if (current) current.replyPairs.push(pair);
      else preamblePairs.push(pair);
    }

    if (current) turns.push(finalizeTurn(current, turns.length + 1));

    const INTERACTIVE_SLASH_ONLY_RE = /^\/(?:model|resume|config|mcp|skills|theme|permissions|agents|help|status|compact)(?:\s+\S.*)?$/i;
    const filteredTurns = turns.filter((t, idx) => {
      if (!t.reply && INTERACTIVE_SLASH_ONLY_RE.test(t.prompt) && (menuActive || idx < turns.length - 1 || turns.length > 1)) return false;
      return true;
    }).map((t, idx) => ({ ...t, index: idx + 1 }));

    const cleanPre = cleanReplyPairs(preamblePairs);
    const bannerPairs = extractBannerPairs(cleanPre, agent);
    let banner = bannerPairs.map(p => p.plain).join('\n');
    let bannerAnsi = bannerPairs.map(p => p.ansi).join('\n');
    const bannerCaptured = Boolean(banner);
    if (!bannerCaptured && agent) {
      const synth = synthesizeFallbackBanner(agent, model, meta);
      if (synth) {
        banner = synth.banner;
        bannerAnsi = synth.bannerAnsi;
      }
    }
    return {
      agent,
      model,
      menuActive,
      cwd: (meta && meta.panePath) ? String(meta.panePath) : '',
      totalLines: rawLines.length,
      banner,
      bannerAnsi,
      bannerCaptured,
      preamble: cleanPre.map(p => p.plain).join('\n'),
      preambleAnsi: cleanPre.map(p => p.ansi).join('\n'),
      turns: filteredTurns
    };
  }


  // Only known, currently displayed CLI pickers become actionable web controls.
  function parseNativeMenu(text, agent) {
    const lines = stripAnsi(text).split('\n');
    const titles = agent === 'codex' ? {
      'Select Model and Effort':'model', 'Select Model':'model',
      'Select Reasoning Effort':'effort', 'Update Model Permissions':'permissions',
      'Resume Session':'session', 'Select Session':'session',
      'Select Conversation':'session', 'Select Theme':'theme'
    } : agent === 'agy' ? {
      'Switch Model':'model', 'Permission Config Editor':'permission-scope',
      'Resume Session':'session', 'Select Conversation':'session',
      'Select Session':'session', 'Switch Session':'session',
      'Select Theme':'theme', 'Manage MCP Servers':'mcp',
      'MCP Servers':'mcp', 'Select Agent':'agent', 'Skills':'skills'
    } : {};
    let start = -1, kind = '', fence = '';
    for (let i=0;i<lines.length;i++) {
      const t=lines[i].trim(), f=t.match(/^(`{3,}|~{3,})/);
      if (f) { fence=fence ? '' : f[1][0]; continue; }
      if (!fence && (titles[t] || (agent==='codex' && /^Select Reasoning Level for(?: .*)?$/.test(t)))) { start=i;kind=titles[t]||'effort'; }
    }
    if(start<0) return null;
    const rest=lines.slice(start+1), footer=rest.findIndex(l=>agent==='codex' ? /enter (?:select|default|resume).*esc (?:back|close|cancel)/i.test(l) : /(?:Keyboard:.*(?:Navigate|Select|Switch View).*esc|(?:↑\/↓|up\/down).*enter.*esc)/i.test(l));
    if(footer<0) return null;
    const body=rest.slice(0,footer), options=[];
    if(kind==='permission-scope' && !body.some(l=>l.trim()==='Select a config scope to edit:')) return null;
    let selected=-1, begun=false;
    for(const line of body) {
      const t=line.trimEnd();
      if(agent==='codex') {
        const m=t.match(/^\s*([›>]?)\s*(\d+)\.\s+(.+)$/);
        if(m) { if(m[1]) selected=options.length; options.push({label:m[3].trim(),index:Number(m[2])}); }
      } else {
        if(!begun && /^\s*>\s+\S/.test(t)) begun=true;
        // Include options above the selection, not only those below it.
        if(!begun) continue;
        if(!t.trim() || /^\s*Effort\b/.test(t) || /^\s*[↑↓]\s*$/.test(t)) break;
        const m=t.match(/^\s*(>?)\s*(\S.*)$/);
        if(m && !/^[─━-]+$/.test(m[2].trim())) { if(m[1]) selected=options.length; options.push({label:m[2].trim(),index:options.length}); }
      }
    }
    if(agent==='agy' && selected===0) {
      // Native agy lists have a blank line before their first option; selected may be in the middle.
      const first=body.findIndex(l=>/^\s*>\s+\S/.test(l));
      const before=[];
      for(let i=first-1;i>=0 && body[i].trim() && !/^\s*(?:Search:|Effort\b|[↑↓]\s*$)/.test(body[i]);i--) {
        if(/^[\s─━-]+$/.test(body[i])) break;
        before.unshift({label:body[i].trim()});
      }
      options.unshift(...before);selected=before.length;
      options.forEach((o,i)=>o.index=i);
    }
    if(!options.length || selected<0) return null;
    const title=lines[start].trim();
    return {agent,kind,title,options,selected,session:/s session/.test(rest[footer]),confirmLabel:/enter default/.test(rest[footer])?'设为默认':'确认选择',effort:agent==='agy' && /←\/→\s+Effort/.test(rest[footer]),more:body.some(l=>/^\s*↓\s*$/.test(l)), signature:JSON.stringify([agent,title,options.map(o=>o.label)])};
  }

  return { parseTerminalHistory, parseNativeMenu, stripAnsi, AGENT_CMD_NAMES };
}));
