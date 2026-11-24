(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__wtHistoryParser = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  const LEADING_SGR_RE = /^(?:\x1b\[[0-9;:]*m)+/;

  const RULE_RE = /^[─━\-=]{12,}$/;
  const AGY_PROMPT_RE = /^>\s+(\S.*)$/;
  const AGY_EMPTY_RE = /^>\s*$/;
  const CODEX_PROMPT_RE = /^›\s+(\S.*)$/;
  const CODEX_EMPTY_RE = /^›\s*$/;
  const CLAUDE_PROMPT_RE = /^❯\s+(\S.*)$/;
  const CLAUDE_EMPTY_RE = /^❯\s*$/;
  const FISH_PROMPT_RE = /^╰─\S*\s+(\S.*)$/;
  const PLACEHOLDER_RE = /^(?:Ask Codex to do anything|Ask anything|Type a message|Send a message|Message\b.*)\s*$/i;
  const CODEX_STATUS_RE = /^\s*GPT-[0-9A-Za-z._-]+\s+.*·\s*\/.*$/i;
  const FOOTER_RE = /^\s*(?:esc to cancel.*|Press up to edit.*|\?\s*for shortcuts.*|←\s*for agents.*|shift\+tab.*|(?:auto|plan|accept-edits)\s*·\s*.*)\s*$/i;
  const CODEX_QUEUE_HINT_RE = /^tab to queue message$/i;
  const RESPONSE_START_RE = /^(?:[○●▸•◆└├│┌╰╭⎿]\s|Worked for\s+\d)/;
  const STEP_LINE_RE = /^\s*(?:[○●▸•]\s+(?:Thought|Ran|Explored|Searched|Read|Edited|Wrote|Updated|Created|Deleted|Checked|Called)|Worked for\s+\d)/;

  function stripAnsi(s) {
    return String(s || '').replace(ANSI_RE, '');
  }

  function trimAnsiRight(s) {
    return String(s || '').replace(/[ \t]+$/, '');
  }

  // tmux capture-pane -e can carry SGR values across rows, or reset and set
  // them again after indentation. Compare the background at the visible text.
  function terminalBackground(raw, column, initial = '') {
    let background = initial;
    let plainOffset = 0;
    let rawOffset = 0;
    for (const match of raw.matchAll(/\x1b\[([0-9;:]*)m/g)) {
      plainOffset += match.index - rawOffset;
      if (plainOffset > column) break;
      rawOffset = match.index + match[0].length;
      const params = match[1].split(';');
      for (let i = 0; i < params.length; i++) {
        const code = params[i];
        if (code === '' || code === '0' || code === '49') background = '';
        else if (/^(?:4[0-7]|10[0-7])$|^48:/.test(code)) background = code;
        else if (code === '38' || code === '48' || code === '58') {
          const count = params[i + 1] === '2' ? 4 : params[i + 1] === '5' ? 2 : 0;
          if (count && code === '48') background = params.slice(i, i + count + 1).join(';');
          i += count;
        }
      }
    }
    return background;
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

  function stripBottomChrome(rawLines, plainLines, agent) {
    let end = plainLines.length;
    while (end > 0) {
      const s = plainLines[end - 1].trim();
      if (!s || RULE_RE.test(s) || FOOTER_RE.test(s) || CODEX_STATUS_RE.test(s) ||
          (agent === 'codex' && CODEX_QUEUE_HINT_RE.test(s) && CODEX_STATUS_RE.test(plainLines[end - 2] || '')) ||
          AGY_EMPTY_RE.test(s) || CODEX_EMPTY_RE.test(s) || CLAUDE_EMPTY_RE.test(s) ||
          /^(?:[•●✳\u2800-\u28ff]\s+Working\s*\(.*esc to interrupt.*\)|[\u2800-\u28ff]\s{1,3}(?:Running|Thinking|Generating|Planning|Reading|Searching|Editing|Waiting|Processing|Compacting|Exploring)\b.*|(?:[›└├]\s+)?Tip:\s+.*)$/i.test(s) ||
          /^[•●]\s+\[\d{1,2}:\d{2}(?::\d{2})?\]\s+.*\s+(?:running|completed|failed|stopped)\s*$/i.test(s) ||
          /^[›>❯]\s+(?:Ask Codex to do anything|Ask anything)\s*$/i.test(s) ||
          /^(?:↑\/↓\s+Navigate\s*·\s*enter\s+Select(?:\s*·\s*tab\s+Complete)?|tab\s+Complete)$/i.test(s) ||
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
        const m = CODEX_STATUS_RE.test(s) && s.match(/^(GPT-[0-9A-Za-z._-]+(?:\s+(?:none|minimal|low|medium|high|xhigh|max|ultra))?)\b/i);
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
    const trimmed = plainLine.trimEnd();
    const prev = (prevPlainLine || '').trim();
    const boundaryBefore = !prev || RULE_RE.test(prev) || /^╭/.test(prev) || /^╰─/.test(prev) || /^⎿\s+/.test(prev) || /^Worked for\s+/.test(prev) || /Conversation compacted/i.test(prev);

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

  // A picker left in scrollback is no longer active once dialogue resumes.
  // Keep status lines after the footer; only a new input prompt ends the picker.
  function hasDialogueAfterMenu(lines, footerIndex) {
    return lines.slice(footerIndex + 1).some(line => /^\s*[›❯>](?:\s|$)/.test(line));
  }

  const NATIVE_MENU_HEADING_RE = /^(?:Switch Model|Set Effort|Select Model(?: and Effort)?|Select Reasoning Effort|Select Reasoning Level for(?: .*)?|Update Model Permissions|Permission Config Editor|Resume Session|Select Session|Switch Session|Select Conversation|Choose Session|Select Theme|Manage MCP Servers|MCP Servers|Select Agent|Create New Agents|Available Agents|Skills|Configuration|Settings|Tasks|Compact Conversation|Update available(?:\s*·.*)?|Antigravity CLI\s+(?:general\s+commands\s+shortcuts.*|credits.*))$/i;
  const NATIVE_MENU_FOOTER_RE = /(?:enter\s+(?:to\s+)?(?:select|default|confirm|resume|continue|open).*esc\s*(?:to\s*)?(?:back|close|cancel|skip|exit|clear)|enter\s+resume\s+.*esc\s+exit|Keyboard:.*(?:Navigate|Effort|Select|Switch View|Save|Actions|View|Change|Page|Close|Go Back|Exit|Cancel)|(?:↑\/↓|up\/down)\s+(?:Navigate|Scroll).*?(?:enter|esc\s+Close)|\?\s*help\s+esc\s+back\s+↑\/↓\s+move\s+enter\s+open)/i;
  const PAGER_CLOSE_FOOTER_RE = /^\s*q\s+close\s*$/i;
  const PAGER_SCROLL_HINT_RE = /(?:↑\/↓\s+to\s+scroll|pgup\/pgdn\s+to\s+page|─{10,}\s+\d+%)/i;

  function fencedLines(lines) {
    let inFence = '';
    return lines.map(line => {
      const text = line.trim();
      const marker = text.match(/^(`{3,}|~{3,})/)?.[1];
      if (!marker) return Boolean(inFence);
      if (!inFence) inFence = marker;
      else if (marker[0] === inFence[0] && marker.length >= inFence.length && !text.slice(marker.length).trim()) inFence = '';
      return true;
    });
  }

  function detectActiveOverlay(splitPlain) {
    let footerIdx = -1;
    let footerEnd = -1;
    let closeKey = '\x1b';
    const fenceByLine = fencedLines(splitPlain);
    for (let i = 0; i < splitPlain.length; i++) {
      if (fenceByLine[i]) continue;
      const t = splitPlain[i].trim();
      if (NATIVE_MENU_FOOTER_RE.test(t)) {
        footerIdx = i;
        footerEnd = i;
        closeKey = '\x1b';
        // Some footers (e.g., AGY /resume, Codex /resume) wrap onto a second key-hint line.
        if (i + 1 < splitPlain.length) {
          const nextT = splitPlain[i + 1].trim();
          if (/^(?:tab\s+Switch\s+Tab|(?:\^[a-z]|↑\/↓)\s+\S)/i.test(nextT)) footerEnd = i + 1;
        }
      } else if (PAGER_CLOSE_FOOTER_RE.test(t)) {
        const prev1 = i > 0 ? splitPlain[i - 1] : '';
        const prev2 = i > 1 ? splitPlain[i - 2] : '';
        if (PAGER_SCROLL_HINT_RE.test(prev1) || PAGER_SCROLL_HINT_RE.test(prev2)) {
          footerIdx = i;
          footerEnd = i;
          closeKey = 'q';
        }
      }
    }
    if (footerIdx < 0 || hasDialogueAfterMenu(splitPlain, footerEnd)) {
      return { menuActive: '', menuStart: -1, menuCloseKey: '\x1b' };
    }

    // Find the nearest composer frame (──── / > / ────) before footerIdx so we never cross into older scrollback.
    let floorIdx = 0;
    for (let i = footerIdx - 1; i >= 2; i--) {
      if (fenceByLine[i]) continue;
      if (RULE_RE.test(splitPlain[i].trim()) &&
          (AGY_EMPTY_RE.test(splitPlain[i - 1].trim()) || /^>\s+/.test(splitPlain[i - 1].trim())) &&
          RULE_RE.test(splitPlain[i - 2].trim())) {
        floorIdx = i + 1;
        break;
      }
    }

    // Prefer an explicit recognized heading between floorIdx and footerIdx.
    let menuStart = -1;
    let heading = '';
    for (let i = floorIdx; i < footerIdx; i++) {
      if (fenceByLine[i]) continue;
      const t = splitPlain[i].trim();
      if (NATIVE_MENU_HEADING_RE.test(t) || /^Type to filter themes\b/i.test(t)) {
        menuStart = i;
        heading = /^Type to filter themes\b/i.test(t) ? 'Select Theme' : t;
      }
    }

    if (menuStart < 0) {
      if (closeKey === 'q') {
        menuStart = floorIdx;
        heading = '终端分页视图';
      } else if (floorIdx > 0) {
        menuStart = floorIdx;
        while (menuStart < footerIdx && !splitPlain[menuStart].trim()) menuStart++;
        const firstLine = (splitPlain[menuStart] || '').trim();
        if (/enter\s+resume|ctrl\+f\s+Grouped\s+View/i.test(splitPlain[footerIdx])) heading = 'Resume Session';
        else if (/↑\/↓\s+Scroll/i.test(splitPlain[footerIdx])) heading = 'Context Usage';
        else if (/←\/→\s+Change/i.test(splitPlain[footerIdx])) heading = 'Settings';
        else heading = (firstLine && firstLine.length <= 64) ? firstLine : '交互菜单';
      } else {
        // Codex full-screen or inline pickers without a recognized heading (e.g., /theme, /resume, /agents).
        const footerLine = splitPlain[footerIdx];
        if (/enter\s+resume/i.test(footerLine)) {
          menuStart = 0;
          heading = 'Resume Session';
        } else if (/\?\s*help\s+esc\s+back\s+↑\/↓\s+move\s+enter\s+open/i.test(footerLine)) {
          menuStart = 0;
          heading = 'Agents';
        } else {
          let back = footerIdx - 1;
          const minBack = Math.max(0, footerIdx - 28);
          while (back > minBack) {
            const lt = splitPlain[back].trim();
            if (/^(?:Worked for\s+\d|•\s+No previous message|╭|╰─|\/(?:mcp|status|diff|skills)\b)/.test(lt)) {
              back++;
              break;
            }
            back--;
          }
          menuStart = Math.max(0, back);
          while (menuStart < footerIdx && !splitPlain[menuStart].trim()) menuStart++;
          if (/Type to filter themes/i.test(splitPlain.slice(menuStart, footerIdx).join('\n'))) heading = 'Select Theme';
          else {
            const firstLine = (splitPlain[menuStart] || '').trim();
            heading = (firstLine && firstLine.length <= 64 && !/^[›>↑↓]\s*/.test(firstLine)) ? firstLine : '交互菜单';
          }
        }
      }
    }

    return {
      menuActive: heading || '交互菜单',
      menuStart: menuStart >= 0 ? menuStart : footerIdx,
      menuCloseKey: closeKey
    };
  }

  function extractTrailingSlashOutput(rawLines, plainLines, agent) {
    const empty = { slashOutput: '', slashOutputAnsi: '', start: -1 };
    if (agent !== 'codex') return empty;
    const fenced = fencedLines(plainLines);
    const command = /^(?:›\s+)?\/(status|mcp)$/i;
    const statusLine = /^(?:Model|Directory|Approval|Sandbox|Permissions|Agents\.md|Account|ChatGPT|Collaboration|Session|Context window|5h limit|Weekly limit|OpenAI Codex|Version|Tokens|Tip)\b/i;
    const displayText = line => line.trim().replace(/^[│║]\s*/, '');
    let start = -1;
    let confidence = 0;
    for (let i = plainLines.length - 1; i >= 0 && !fenced[i]; i--) {
      const text = displayText(plainLines[i]);
      const cmd = text.match(command)?.[1]?.toLowerCase();
      if (cmd && start === i + 1) {
        start = i;
        confidence = 2;
        break;
      }
      if (CODEX_PROMPT_RE.test(text)) break;
      if (/^🔌\s+MCP Tools\b/.test(text)) {
        start = i;
        confidence = 2;
      } else if (/^(?:5h limit|Weekly limit|Context window):\s+/i.test(text)) {
        start = i;
        confidence = 1;
        while (start > 0 && !fenced[start - 1] &&
               (statusLine.test(displayText(plainLines[start - 1])) || /^╭[─╴]/.test(plainLines[start - 1].trim()) ||
                (plainLines[start - 1].trim() === '│' && /^[│║]/.test(plainLines[start].trim())))) {
          start--;
          const label = displayText(plainLines[start]);
          if (/^(?:OpenAI Codex|5h limit|Weekly limit|Context window)\b/i.test(label)) confidence = 2;
        }
        i = start;
      }
    }
    if (start < 0 || confidence < 2) return empty;
    const pairs = plainLines.slice(start).map((plain, i) => ({plain, ansi:trimAnsiRight(rawLines[start + i])}));
    const cleaned = cleanReplyPairs(pairs);
    if (!cleaned.length) return empty;
    return {
      start,
      slashOutput: cleaned.map(p => p.plain).join('\n'),
      slashOutputAnsi: cleaned.map(p => p.ansi).join('\n')
    };
  }

  function parseTerminalHistory(rawText, cmd = '', meta = {}) {
    const normalized = String(rawText || '').replace(/\r\n?/g, '\n');
    let splitRaw = normalized.split('\n');
    let splitPlain = splitRaw.map(stripAnsi);
    // Native pickers and pagers share prompt markers with dialogue. Remove any recognized
    // trailing interactive overlay when its navigation footer is present, outside code fences.
    const agent = detectAgentKind(cmd, splitPlain, meta);
    const overlay = agent ? detectActiveOverlay(splitPlain) : { menuActive: '', menuStart: -1, menuCloseKey: '\x1b' };
    const menuActive = overlay.menuActive;
    const menuCloseKey = overlay.menuCloseKey;
    if (menuActive && overlay.menuStart >= 0) {
      splitRaw = splitRaw.slice(0, overlay.menuStart);
      splitPlain = splitPlain.slice(0, overlay.menuStart);
    }
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
    let { rawLines, plainLines } = stripBottomChrome(splitRaw, splitPlain, agent);
    const {slashOutput, slashOutputAnsi, start: slashStart} = extractTrailingSlashOutput(rawLines, plainLines, menuActive ? '' : agent);
    if (slashStart >= 0) {
      rawLines = rawLines.slice(0, slashStart);
      plainLines = plainLines.slice(0, slashStart);
    }
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
        const codexBg = hit.kind === 'codex' ? terminalBackground(rawLine, plainLine.indexOf(hit.text)) : '';
        let previousBg = codexBg ? terminalBackground(rawLine, Infinity) : '';
        while (i + 1 < rawLines.length) {
          const nextRaw = rawLines[i + 1];
          const nextPlain = plainLines[i + 1].replace(/\s+$/, '');
          if (!nextPlain.trim() || RULE_RE.test(nextPlain.trim()) || FOOTER_RE.test(nextPlain) || CODEX_STATUS_RE.test(nextPlain)) break;
          if (!/^\s{2,}\S/.test(nextPlain)) break;
          if (codexBg) {
            if (terminalBackground(nextRaw, nextPlain.search(/\S/), previousBg) !== codexBg) break;
            previousBg = terminalBackground(nextRaw, Infinity, previousBg);
          } else {
            if (promptHasBg && (!/\x1b\[48;/.test(nextRaw) || /\x1b\[(?:[0-9;]*;)?49m/.test(nextRaw))) break;
            if (promptStyled && /^(?:\x1b\[(?:0|2|39|49)m|\x1b\[[0-9;]*49m)/.test(nextRaw)) break;
          }
          const inner = nextPlain.trim();
          if (RESPONSE_START_RE.test(inner) || /^↑\/↓\s+Navigate\b/i.test(inner)) break;
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

    const INTERACTIVE_SLASH_ONLY_RE = /^\/(?:model|effort|resume|config|settings|mcp|skills|theme|permissions|agents|help|status|compact|credits|context|tasks|diff|usage|clear|new|copy|rename|fork|rewind|plan|vim|fast|approve|ps|pwd)(?:\s+\S.*)?$/i;
    const SLASH_EXIT_REPLY_RE = /^\s*⎿\s+(?:Exited\s+\/\S+\s+command|Cancelled|No\s+.*)\s*$/i;
    const SLASH_AC_GHOST_RE = /^\s*↑\/↓\s+Navigate\s*·\s*enter\s+Select\b/i;
    const filteredTurns = turns.filter((t, idx) => {
      const p = String(t.prompt || '').trim();
      const r = String(t.reply || '').trim();
      if (INTERACTIVE_SLASH_ONLY_RE.test(p)) {
        if (SLASH_EXIT_REPLY_RE.test(r)) return false;
        if (!r && (menuActive || idx < turns.length - 1 || turns.length > 1)) return false;
        if (r && SLASH_AC_GHOST_RE.test(r)) return false;
      }
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
      menuCloseKey,
      slashOutput,
      slashOutputAnsi,
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
      'Select Conversation':'session', 'Select Theme':'theme',
      'Skills':'skills', 'Configuration':'config'
    } : agent === 'agy' ? {
      'Switch Model':'model', 'Set Effort':'effort', 'Permission Config Editor':'permission-scope',
      'Resume Session':'session', 'Select Conversation':'session',
      'Select Session':'session', 'Switch Session':'session',
      'Select Theme':'theme', 'Manage MCP Servers':'mcp',
      'MCP Servers':'mcp', 'Select Agent':'agent',
      'Create New Agents':'agent', 'Available Agents':'agent',
      'Skills':'skills'
    } : {};
    let start = -1, kind = '', fence = '';
    for (let i=0;i<lines.length;i++) {
      const t=lines[i].trim(), f=t.match(/^(`{3,}|~{3,})/);
      if (f) { fence=fence ? '' : f[1][0]; continue; }
      if (fence) continue;
      if (titles[t]) { start=i; kind=titles[t]; }
      else if (agent==='codex' && /^Select Reasoning Level for(?: .*)?$/.test(t)) { start=i; kind='effort'; }
      else if (agent==='codex' && /^Update available\b/i.test(t)) { start=i; kind='update'; }
      else if (agent==='agy' && /^Antigravity CLI\s+credits$/i.test(t)) { start=i; kind='credits'; }
    }
    if(start<0) return null;
    const rest=lines.slice(start+1);
    const footer=rest.findIndex(l=>agent==='codex'
      ? /enter\s+(?:select|default|resume|continue|open).*esc\s+(?:back|close|cancel|skip|exit|clear)/i.test(l)
      : /(?:Keyboard:.*(?:Navigate|Effort|Select|Switch View|Save|Actions|View|Change|Page|Close|Go Back|Exit|Cancel)|(?:↑\/↓|up\/down).*enter.*esc)/i.test(l));
    if(footer<0) return null;
    let footerEnd = footer;
    if (footer + 1 < rest.length && /^(?:tab\s+Switch\s+Tab|(?:\^[a-z]|↑\/↓)\s+\S)/i.test(rest[footer + 1].trim())) footerEnd = footer + 1;
    if(hasDialogueAfterMenu(rest, footerEnd)) return null;
    const body=rest.slice(0,footer), options=[];
    if(kind==='permission-scope' && !body.some(l=>l.trim()==='Select a config scope to edit:')) return null;
    const RANGE_RE = /^\s*\[(\d+)-(\d+)\s+of\s+(\d+)\s+items?\]/i;
    const AGY_SECTION_HEADER_RE = /^(?:Plugins\s*\(|User\s*\(|Project\s*\(|Workspace\s*\(|Global\s*\(|Actions$|Available Agents$|Create New Agents$|Model AI Credits$|Remaining AI Credits:|Workspace:|Global:|home\/|~\/)/i;
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
        if(!t.trim() || /^\s*Effort\b/.test(t) || /^\s*[↑↓]\s*$/.test(t) || RANGE_RE.test(t)) break;
        const m=t.match(/^\s*(>?)\s*(\S.*)$/);
        if(m && !/^[─━-]+$/.test(m[2].trim()) && !AGY_SECTION_HEADER_RE.test(m[2].trim())) {
          if(m[1]) selected=options.length;
          options.push({label:m[2].trim(),index:options.length});
        }
      }
    }
    if(agent==='codex' && !options.length && (kind==='config' || kind==='theme')) {
      // Unnumbered Codex pickers (e.g. /config, /theme) mark the current item with `› `.
      const selIdx = body.findIndex(l => /^\s*›\s+\S/.test(l));
      if (selIdx >= 0) {
        let top = selIdx;
        while (top > 0) {
          const prev = body[top - 1].trim();
          if (!prev || /^[↑↓─━-]+$/.test(prev) || /^Appearance\s+Notifications/i.test(prev) || /^Changes save automatically/i.test(prev) || /^Type to filter/i.test(prev)) break;
          top--;
        }
        for (let i = top; i < body.length; i++) {
          const t = body[i].trimEnd();
          if (!t.trim() || /^\s*[↑↓]\s*$/.test(t)) break;
          const m = t.match(/^\s*(›?)\s*(\S.*)$/);
          if (m) {
            if (m[1]) selected = options.length;
            options.push({ label: m[2].trim(), index: options.length });
          }
        }
      }
    }
    if(agent==='agy' && selected===0) {
      // Native agy lists have a blank line before their first option; selected may be in the middle.
      const first=body.findIndex(l=>/^\s*>\s+\S/.test(l));
      const before=[];
      for(let i=first-1;i>=0 && body[i].trim() && !/^\s*(?:Search:|Effort\b|[↑↓]\s*$)/i.test(body[i]) && !RANGE_RE.test(body[i]);i--) {
        if(/^[\s─━-]+$/.test(body[i]) || AGY_SECTION_HEADER_RE.test(body[i].trim())) break;
        before.unshift({label:body[i].trim()});
      }
      options.unshift(...before);selected=before.length;
      options.forEach((o,i)=>o.index=i);
    }
    let effortLevel='';
    let effortOptions=[];
    if(agent==='agy') {
      const eIdx=body.findIndex(l=>/◂.*▸/.test(l));
      if(eIdx>=0 && eIdx+1<body.length) {
        const dots=body[eIdx].match(/[●◉○]/g)||[];
        const activeDot=dots.indexOf('◉');
        const words=body[eIdx+1].trim().split(/\s+/).filter(Boolean);
        effortOptions = words;
        if(activeDot>=0 && activeDot<words.length) effortLevel=words[activeDot];
      }
    }
    // AGY /effort (`Set Effort`) is a horizontal slider without vertical list items.
    const isHorizontalEffort = agent === 'agy' && kind === 'effort' && !options.length && effortOptions.length > 0;
    if (isHorizontalEffort) {
      effortOptions.forEach((w, i) => options.push({ label: w, index: i }));
      selected = Math.max(0, effortOptions.indexOf(effortLevel));
    }
    if(!options.length || selected<0) return null;
    let range=null;
    for(const line of body) {
      const rm=line.match(RANGE_RE);
      if(rm) { range={start:Number(rm[1]),end:Number(rm[2]),total:Number(rm[3])}; break; }
    }
    const prev=Boolean((range && range.start>1) || body.some(l=>/^\s*↑\s*$/.test(l)));
    const more=Boolean((range && range.end<range.total) || body.some(l=>/^\s*↓\s*$/.test(l)));
    const title=lines[start].trim();
    const confirmLabel = /enter default/.test(rest[footer]) ? '设为默认'
      : /enter continue/.test(rest[footer]) ? '继续'
      : /enter open/.test(rest[footer]) ? '打开'
      : '确认选择';
    return {
      agent,
      kind,
      title,
      options,
      selected,
      axis: isHorizontalEffort ? 'horizontal' : 'vertical',
      session:/s session/.test(rest[footer]),
      confirmLabel,
      effort:agent==='agy' && /←\/→\s+Effort/.test(rest[footer]),
      effortLevel,
      prev,
      more,
      range,
      signature:JSON.stringify([agent,title,options.map(o=>o.label)])
    };
  }

  return { parseTerminalHistory, parseNativeMenu, stripAnsi, AGENT_CMD_NAMES };
}));
