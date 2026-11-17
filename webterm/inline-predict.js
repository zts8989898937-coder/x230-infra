/* Native in-place local line editor for shell & AI CLI prompts.
 * Keeps editing local in an aligned transparent textarea until Enter,
 * while preserving wallpaper transparency and failing closed on passwords/pagers.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.WTInlinePrediction = api;
    let attempts = 0;
    const timer = root.setInterval(() => {
      if (root.term && root.term.element) {
        root.clearInterval(timer);
        if (!root.__wtInlinePredictor) root.__wtInlinePredictor = api.attach(root);
      } else if (++attempts > 300) root.clearInterval(timer);
    }, 50);
  }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function cellWidth(ch) {
    const n = ch.codePointAt(0);
    if (n >= 0x20 && n <= 0x7e) return 1;
    if ((n >= 0x3400 && n <= 0x9fff) || (n >= 0x20000 && n <= 0x2fa1f) ||
        (n >= 0x3041 && n <= 0x3096) || (n >= 0x30a1 && n <= 0x30fa) ||
        (n >= 0xac00 && n <= 0xd7a3)) return 2;
    return 0;
  }

  const clone = s => ({
    row: s.row, x: s.x, cols: s.cols,
    cells: s.cells.slice(),
    dims: s.dims ? s.dims.slice() : []
  });

  const equal = (a, b) => a && b && a.row === b.row && a.x === b.x && a.cols === b.cols &&
    a.cells.length === b.cells.length && a.cells.every((v, i) => v === b.cells[i] ||
      (i >= a.x && i >= b.x &&
       (!v || v === ' ' || a.dims?.[i]) &&
       (!b.cells[i] || b.cells[i] === ' ' || b.dims?.[i])));

  const exact = (a, b) => equal(a, b) && a.cells.every((v, i) => v === b.cells[i]);

  class PredictionCore {
    constructor(options = {}) {
      this.timeoutMs = options.timeoutMs || 1500;
      this.clear();
    }
    clearPending() { this.base = null; this.states = []; this.deadline = 0; }
    clear() { this.clearPending(); this.floor = null; this.anchor = null; }
    input(data, snapshot, now = Date.now()) {
      if (!snapshot || !data) return;
      this.confirm(snapshot);
      if (!this.base) this.base = clone(snapshot);
      const state = clone(this.states.length ? this.states[this.states.length - 1] : this.base);
      for (const ch of data) {
        if (ch === '\x7f' || ch === '\b') {
          if (!this.floor || this.floor.row !== state.row || state.x <= this.floor.x) { this.clear(); return; }
          let x = state.x - 1;
          if (state.cells[x] === '' && x > 0) x--;
          for (let i = x; i < state.x; i++) state.cells[i] = ' ';
          state.x = x;
        } else {
          const width = cellWidth(ch);
          const tail = state.cells.slice(state.x);
          if (width && tail.some(c => c && c !== ' ') &&
              tail.every((c, i) => !c || c === ' ' || state.dims[state.x + i])) {
            state.cells.fill(' ', state.x);
            state.dims.fill(false, state.x);
          }
          if (!width || state.x + width >= state.cols ||
              state.cells.slice(state.x, state.x + width).some(c => c !== ' ')) {
            this.clear(); return;
          }
          if (!this.floor) this.floor = { row: state.row, x: state.x };
          state.cells[state.x] = ch;
          state.dims[state.x] = false;
          if (width === 2) state.cells[state.x + 1] = '';
          state.x += width;
        }
        this.states.push(clone(state));
        if (this.states.length > 256) { this.clear(); return; }
      }
      this.deadline = now + this.timeoutMs;
    }
    confirm(snapshot) {
      if (!this.base) {
        if (this.anchor && !equal(this.anchor, snapshot)) { this.clear(); return 'invalid'; }
        return 'idle';
      }
      if (equal(this.base, snapshot)) {
        if (!exact(this.base, snapshot)) { this.clear(); return 'invalid'; }
        return 'same';
      }
      let matched = -1;
      for (let i = 0; i < this.states.length; i++) if (equal(this.states[i], snapshot)) matched = i;
      if (matched < 0) { this.clear(); return 'invalid'; }
      this.base = clone(snapshot);
      this.states.splice(0, matched + 1);
      if (!this.states.length) { this.anchor = clone(snapshot); this.clearPending(); }
      return 'confirmed';
    }
    expire(now = Date.now()) { if (this.deadline && now >= this.deadline) this.clear(); }
    view() {
      if (!this.base || !this.states.length) return null;
      const target = this.states[this.states.length - 1];
      let start = Math.min(this.base.x, target.x);
      let end = Math.max(this.base.x, target.x);
      for (let i = 0; i < this.base.cols; i++) {
        if (this.base.cells[i] !== target.cells[i]) {
          start = Math.min(start, i);
          end = Math.max(end, i + 1);
        }
      }
      return {
        x: start, row: this.base.row, cursorX: target.x, width: end - start,
        text: target.cells.slice(start, end).join(''),
        pendingText: target.cells.slice(this.base.x, target.x).join('')
      };
    }
    get pendingText() { const v = this.view(); return v ? v.pendingText : ''; }
  }

  function isMutedCell(cell) {
    if (!cell) return false;
    if (cell.isDim && cell.isDim()) return true;
    const mode = cell.getFgColorMode ? cell.getFgColorMode() : 0;
    const color = cell.getFgColor ? cell.getFgColor() : -1;
    // ANSI bright-black (8) in P16 mode (0x1000000)
    if (mode === 0x1000000 && color === 8) return true;
    // 256-color palette (0x2000000): grayscale ramp (236..252) & muted slate grays (e.g. agy placeholder 109)
    if (mode === 0x2000000 && (color === 8 || (color >= 236 && color <= 252) ||
        color === 59 || color === 60 || color === 66 || color === 102 || color === 103 || color === 109 || color === 145)) {
      return true;
    }
    // 24-bit RGB (0x3000000) muted gray/slate placeholder
    if (mode === 0x3000000 && color >= 0) {
      const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
      const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
      if (hi - lo <= 55 && hi <= 175) return true;
    }
    return false;
  }

  function snapshot(term) {
    const b = term.buffer.active;
    const row = b.baseY + b.cursorY;
    const line = b.getLine(row);
    if (!line) return null;
    const cells = [], dims = [];
    for (let i = 0; i < term.cols; i++) {
      const cell = line.getCell(i);
      cells.push(cell && cell.getWidth() === 0 ? '' : (cell && cell.getChars()) || ' ');
      dims.push(isMutedCell(cell));
    }
    return { row, x: b.cursorX, cols: term.cols, cells, dims };
  }

  const SECRET_RE = /(?:\b(?:password|passphrase|pin|otp|secret|token|verification|passcode)\b[^\r\n:：]{0,160}[:：>?]?|(?:密码|口令|验证码)[^\r\n:：]{0,80}[:：>?]?)\s*$/i;
  const PROMPT_END_RE = /^\s*(?:[╰├└]─\S*\s+|.{0,120}?(?:^|[\s\]\)@~\/:\da-zA-Z])[$#❯›λ➜➤▶]\s+|(?:^|.{0,120}?[\s\]\)@~\/:])[>%]\s+)$/u;
  const PROMPT_PREFIX_RE = /^\s*(?:[╰├└]─\S*\s+|.{0,120}?(?:^|[\s\]\)@~\/:\da-zA-Z])[$#❯›λ➜➤▶]\s+|(?:^|.{0,120}?[\s\]\)@~\/:])[>%]\s+)/u;
  const PAGER_FOOTER_RE = /(?:--\s*(?:INSERT|VISUAL|REPLACE|COMMAND|SELECT|TERMINAL)\s*--|\^G\s*(?:Get\s*)?Help|F1\s*Help\s*F2|\(END\)|--More--)/i;

  function attach(win, options = {}) {
    const term = options.term || win.term;
    const doc = win.document;
    let enabled = true, disposed = false, composing = false, pointerDown = false, pointerDownInEditor = false;
    let editorTitle = false, reason = '';
    let suppressedRow = -1, suppressedPrefix = '';
    let anchoredPromptPrefix = '', anchoredRow = -1, anchoredX = -1;
    let pendingSubmit = null;
    let hasFocusedOnce = false;
    let syncScheduled = false;
    let maskedRows = [];
    let lastLayoutKey = '';
    let lastGeoKey = '';
    let lastMaskKey = '';
    let cachedStyleEl = null, cachedRowsFont = '', cachedRowsColor = '';
    const disposables = [];
    const listeners = [];

    const host = term.element;
    const screen = host.querySelector('.xterm-screen') || host;

    const styleEl = doc.createElement('style');
    styleEl.textContent = [
      '.wt-local-editor-active .xterm-cursor,.wt-local-editor-active .xterm-cursor-layer{visibility:hidden!important}',
      '#wt-local-line-editor{user-select:text!important;-webkit-user-select:text!important}',
      '#wt-local-line-editor::placeholder{color:transparent}',
      '#wt-local-line-editor::selection{background:rgba(238,152,51,0.32);color:#f1ece3}'
    ].join('');
    doc.head.appendChild(styleEl);

    const editor = doc.createElement('textarea');
    editor.id = 'wt-local-line-editor';
    editor.setAttribute('aria-label', '本地终端输入');
    editor.setAttribute('autocomplete', 'off');
    editor.setAttribute('autocorrect', 'off');
    editor.setAttribute('autocapitalize', 'off');
    editor.setAttribute('spellcheck', 'false');
    editor.rows = 1;
    editor.style.cssText = [
      'position:absolute',
      'display:none',
      'z-index:32',
      'margin:0',
      'padding:0',
      'border:0',
      'outline:none',
      'resize:none',
      'overflow-x:hidden',
      'overflow-y:auto',
      'background:transparent',
      'background-color:transparent',
      'box-shadow:none',
      'white-space:pre-wrap',
      'word-break:break-word',
      'box-sizing:border-box',
      'scrollbar-width:none'
    ].join(';');
    screen.appendChild(editor);

    function listen(target, name, fn, settings) {
      target.addEventListener(name, fn, settings);
      listeners.push(() => target.removeEventListener(name, fn, settings));
    }

    function restoreMask() {
      for (const item of maskedRows) {
        if (item.el && item.el.style) item.el.style.clipPath = item.prev;
      }
      maskedRows = [];
    }

    function isVisible() {
      return editor.style.display !== 'none';
    }

    function getHelperTa() {
      return host.querySelector('.xterm-helper-textarea');
    }

    function isTermTreeFocused() {
      const ae = doc.activeElement;
      const ta = getHelperTa();
      return ae === editor || (!!ta && ae === ta);
    }

    function focusHelper() {
      const ta = getHelperTa();
      if (ta) ta.focus({ preventScroll: true });
    }

    function sendPaste(text) {
      if (typeof term.paste === 'function') term.paste(text);
      else if (typeof term.input === 'function') term.input(text, true);
    }

    function sendRaw(data) {
      if (!data) return;
      if (typeof term.input === 'function') term.input(data, true);
      else if (term._core && term._core.coreService) term._core.coreService.triggerDataEvent(data, true);
    }

    function clearPendingSubmit() {
      if (!pendingSubmit) return;
      if (pendingSubmit.timer) win.clearTimeout(pendingSubmit.timer);
      pendingSubmit = null;
    }

    function finishSubmit() {
      if (!pendingSubmit) return;
      clearPendingSubmit();
      sendRaw('\r');
    }

    function readVisibleScreen() {
      const b = term.buffer.active;
      const lines = [];
      for (let r = b.baseY; r < b.baseY + term.rows; r++) {
        const line = b.getLine(r);
        lines.push(line ? line.translateToString(true) : '');
      }
      return lines.join('\n');
    }

    function countSubstr(hay, needle) {
      if (!needle) return 0;
      let count = 0, idx = 0;
      while ((idx = hay.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
      }
      return count;
    }

    function bufferContainsSubmitted(sub) {
      if (!sub || !sub.text) return false;
      const joined = readVisibleScreen();
      if (joined === sub.baselineScreen) return false;
      if (/\[Pasted\s+/i.test(joined) && !/\[Pasted\s+/i.test(sub.baselineScreen)) return true;
      const firstLine = sub.firstLine.trim();
      if (!firstLine) return true;
      return countSubstr(joined, firstLine) > sub.baselineCount;
    }

    function detectEditableContext() {
      const socket = win.__wtTerminalSocket;
      if (!socket || socket.readyState !== win.WebSocket.OPEN) return { ok: false, reason: '连接未就绪' };
      if (term.options.disableStdin) return { ok: false, reason: '终端禁止输入' };
      if (editorTitle) return { ok: false, reason: '编辑器' };

      const b = term.buffer.active;
      if (b.viewportY !== b.baseY) return { ok: false, reason: '滚动历史中' };

      const s = snapshot(term);
      if (!s) return { ok: false, reason: '无终端行' };

      const footer = b.getLine(b.baseY + term.rows - 1)?.translateToString(true) || '';
      if (PAGER_FOOTER_RE.test(footer)) return { ok: false, reason: '全屏编辑器' };

      const prefix = s.cells.slice(0, s.x).join('');
      const prevLine = s.row > 0 ? (b.getLine(s.row - 1)?.translateToString(true) || '') : '';
      if (SECRET_RE.test(prefix) || (!prefix.trim() && SECRET_RE.test(prevLine))) {
        return { ok: false, reason: '疑似密码提示' };
      }

      // Suffix after cursor must be empty, right-aligned prompt after >=4 spaces, or muted placeholder.
      let rightBorderCol = s.cols;
      for (let i = s.cols - 1; i > s.x; i--) {
        const ch = s.cells[i];
        if (ch === '│' || ch === '┃') { rightBorderCol = i; break; }
        if (ch && ch !== ' ') break;
      }

      const suffixCells = s.cells.slice(s.x, rightBorderCol);
      const suffixDims = s.dims.slice(s.x, rightBorderCol);
      const hasSolidTextAfterCursor = suffixCells.some((c, i) => {
        if (!c || c === ' ') return false;
        if (suffixDims[i]) return false;
        // Allow far-right RPROMPT separated by >= 5 spaces.
        const before = suffixCells.slice(0, i);
        if (i >= 5 && before.slice(-5).every(x => x === ' ')) return false;
        return true;
      });
      if (hasSolidTextAfterCursor) {
        return { ok: false, reason: '光标后有正文' };
      }

      if (PROMPT_END_RE.test(prefix)) {
        anchoredPromptPrefix = prefix;
        anchoredRow = s.row;
        anchoredX = s.x;
        return { ok: true, s, prefix, promptX: s.x, maxCol: rightBorderCol };
      }

      // Keep anchored if user recalled history (e.g. ArrowUp) on the same recognized prompt row.
      if (anchoredPromptPrefix && s.row === anchoredRow && prefix.startsWith(anchoredPromptPrefix) && PROMPT_PREFIX_RE.test(prefix)) {
        return { ok: true, s, prefix, promptX: anchoredX, maxCol: rightBorderCol };
      }

      return { ok: false, reason: '非可编辑提示符' };
    }

    function getComputedFallback(styleEl) {
      if (styleEl && styleEl !== cachedStyleEl) {
        const css = win.getComputedStyle(styleEl);
        cachedStyleEl = styleEl;
        cachedRowsFont = css.fontFamily || '';
        cachedRowsColor = css.color || '';
      }
      return { fontFamily: cachedRowsFont, color: cachedRowsColor };
    }

    function applyGeometryAndMask(ctx) {
      if (pointerDownInEditor) return;
      const b = term.buffer.active;
      const s = ctx.s;
      const bounds = screen.getBoundingClientRect();
      if (!bounds.width || !bounds.height || !term.cols || !term.rows) return;
      const cellW = bounds.width / term.cols;
      const cellH = bounds.height / term.rows;
      const rowsEl = host.querySelector('.xterm-rows');
      const needFallback = !term.options.fontFamily || !(term.options.theme && term.options.theme.foreground);
      const fallback = needFallback ? getComputedFallback(rowsEl || host) : null;

      const visRow = s.row - b.viewportY;
      const leftPx = s.x * cellW;
      const topPx = visRow * cellH;
      const maxWidthPx = Math.max(cellW * 4, (ctx.maxCol - s.x) * cellW);

      const fontFamily = term.options.fontFamily || (fallback && fallback.fontFamily) || 'monospace';
      const fontSize = (term.options.fontSize || 15) + 'px';
      const letterSpacing = (term.options.letterSpacing || 0) + 'px';
      const fgColor = (term.options.theme && term.options.theme.foreground) || (fallback && fallback.color) || '#f1ece3';
      const cursorColor = (term.options.theme && term.options.theme.cursor) || '#ee9833';
      const layoutKey = [editor.value, fontFamily, fontSize, letterSpacing, cellH, leftPx, maxWidthPx, bounds.height, topPx].join('|');
      const geoKey = [fontFamily, fontSize, letterSpacing, fgColor, cursorColor, cellH, leftPx, maxWidthPx].join('|');

      if (geoKey !== lastGeoKey) {
        editor.style.fontFamily = fontFamily;
        editor.style.fontSize = fontSize;
        editor.style.letterSpacing = letterSpacing;
        editor.style.lineHeight = cellH + 'px';
        editor.style.color = fgColor;
        editor.style.caretColor = cursorColor;
        editor.style.left = leftPx + 'px';
        editor.style.width = maxWidthPx + 'px';
        lastGeoKey = geoKey;
      }

      let needed = parseFloat(editor.style.height) || cellH;
      if (layoutKey !== lastLayoutKey) {
        const prevScrollTop = editor.scrollTop;
        editor.style.height = cellH + 'px';
        const maxH = Math.max(cellH, Math.min(bounds.height * 0.45, bounds.height - 2));
        needed = Math.max(cellH, Math.min(maxH, editor.scrollHeight || cellH));
        if (needed <= cellH + 2 && !editor.value.includes('\n')) needed = cellH;
        editor.style.height = needed + 'px';
        editor.scrollTop = prevScrollTop;
        lastLayoutKey = layoutKey;
      }
      const finalTop = Math.max(0, Math.min(topPx, bounds.height - needed - 2));
      const startVisRow = Math.max(0, Math.floor(finalTop / cellH));
      const endVisRow = Math.min(term.rows - 1, Math.floor((finalTop + needed - 1) / cellH));
      if (editor.style.top !== finalTop + 'px') editor.style.top = finalTop + 'px';

      const needMask = (editor.value.length > 0 || composing) && rowsEl && win.CSS && win.CSS.supports;
      const maskKey = needMask ? [startVisRow, endVisRow, visRow, leftPx, maxWidthPx, bounds.width, cellH].join('|') : '';
      if (maskKey !== lastMaskKey) {
        restoreMask();
        lastMaskKey = maskKey;
        if (needMask) {
          for (let r = startVisRow; r <= endVisRow; r++) {
            const rowEl = rowsEl.children[r];
            if (!rowEl) continue;
            const holeLeft = r === visRow ? leftPx : Math.max(0, leftPx - cellW * 2);
            const holeRight = leftPx + maxWidthPx;
            const path = `path(evenodd, "M 0 0 H ${bounds.width} V ${cellH} H 0 Z M ${holeLeft} 0 H ${holeRight} V ${cellH} H ${holeLeft} Z")`;
            if (win.CSS.supports('clip-path', path)) {
              maskedRows.push({ el: rowEl, prev: rowEl.style.clipPath });
              rowEl.style.clipPath = path;
            }
          }
        }
      }
    }

    function hideEditor(clearDraft = false) {
      if (clearDraft && editor.value) editor.value = '';
      if (!isVisible() && !maskedRows.length && !lastLayoutKey && !lastGeoKey && !lastMaskKey) return;
      restoreMask();
      lastLayoutKey = '';
      lastGeoKey = '';
      lastMaskKey = '';
      editor.style.display = 'none';
      editor.style.pointerEvents = 'auto';
      host.classList.remove('wt-local-editor-active');
    }

    function sync(forceFocus = false) {
      syncScheduled = false;
      if (disposed) return;

      if (!enabled) {
        reason = '已手动关闭';
        hideEditor(true);
        return;
      }

      if (pendingSubmit) {
        reason = '等待发送确认';
        return;
      }

      const ctx = detectEditableContext();
      if (!ctx.ok) {
        reason = ctx.reason;
        // Preserve non-empty user draft across transient background redraws;
        // clear only if terminal switched to password/fullscreen/disconnected.
        if (editor.value.length > 0 && ['疑似密码提示', '连接未就绪', '全屏编辑器', '编辑器', '终端禁止输入'].includes(ctx.reason)) {
          hideEditor(true);
        } else if (editor.value.length === 0) {
          hideEditor(false);
        }
        return;
      }

      // Stay in raw mode if user explicitly pressed Escape on this prompt until prompt advances.
      if (suppressedRow !== -1) {
        if (ctx.s.row === suppressedRow && ctx.prefix === suppressedPrefix) {
          reason = '已按 Esc 切回原终端';
          hideEditor(false);
          return;
        }
        suppressedRow = -1;
        suppressedPrefix = '';
      }

      const activeInsideTerm = isTermTreeFocused() || forceFocus;
      if (!activeInsideTerm && !hasFocusedOnce) {
        reason = '终端未聚焦';
        hideEditor(false);
        return;
      }

      reason = '';
      editor.style.display = 'block';
      const hasFocus = activeInsideTerm || doc.activeElement === editor;
      host.classList.toggle('wt-local-editor-active', hasFocus);
      applyGeometryAndMask(ctx);

      if (activeInsideTerm && !pointerDown && !(term.hasSelection && term.hasSelection()) && doc.activeElement !== editor) {
        hasFocusedOnce = true;
        editor.focus({ preventScroll: true });
        host.classList.add('wt-local-editor-active');
      }
    }

    function scheduleSync(forceFocus = false) {
      if (syncScheduled || disposed) return;
      syncScheduled = true;
      win.requestAnimationFrame(() => sync(forceFocus));
    }

    function submitPayload(payload, fromLocalEditor = false) {
      if (!payload) {
        sendRaw('\r');
        return;
      }
      const firstLine = payload.split('\n')[0];
      const baselineScreen = readVisibleScreen();
      const baselineCount = countSubstr(baselineScreen, firstLine.trim());
      if (fromLocalEditor) {
        suppressedRow = -1;
        suppressedPrefix = '';
        hideEditor(true);
        focusHelper();
      }
      clearPendingSubmit();
      pendingSubmit = {
        text: payload,
        firstLine,
        baselineScreen,
        baselineCount,
        seenWrite: false,
        timer: win.setTimeout(() => finishSubmit(), 1200)
      };
      sendPaste(payload);
    }

    function submitDraft() {
      submitPayload(editor.value.replace(/\r\n?/g, '\n'), true);
    }

    // Intercept Enter, Escape, and empty-draft navigation/control keys inside local editor.
    listen(editor, 'keydown', e => {
      if (e.isComposing || e.keyCode === 229 || composing) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const s = snapshot(term);
        suppressedRow = s ? s.row : -1;
        suppressedPrefix = s ? s.cells.slice(0, s.x).join('') : '';
        hideEditor(true);
        focusHelper();
        return;
      }

      if (e.key === 'Enter') {
        if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
          // Shift+Enter inserts a local newline naturally in <textarea>.
          win.requestAnimationFrame(() => scheduleSync(true));
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        submitDraft();
        return;
      }

      // When draft is empty, let shell/TUI navigation & control keys pass directly to terminal.
      if (editor.value.length === 0) {
        if (e.key === 'Tab') {
          e.preventDefault();
          sendRaw(e.shiftKey ? '\x1b[Z' : '\t');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          sendRaw('\x1b[A');
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          sendRaw('\x1b[B');
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          sendRaw('\x1b[D');
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          sendRaw('\x1b[C');
          return;
        }
        if (e.key === 'Delete') {
          e.preventDefault();
          sendRaw('\x1b[3~');
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          sendRaw('\x7f');
          return;
        }
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.length === 1) {
          const code = e.key.toUpperCase().charCodeAt(0) - 64;
          if (code >= 1 && code <= 26) {
            e.preventDefault();
            sendRaw(String.fromCharCode(code));
            return;
          }
        }
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        // Ctrl+C with non-empty draft and no selection clears draft locally without bothering remote.
        if (editor.selectionStart === editor.selectionEnd) {
          e.preventDefault();
          editor.value = '';
          scheduleSync(true);
        }
      }
    });

    function clearTermSelection() {
      if (term.hasSelection && term.hasSelection() && term.clearSelection) {
        term.clearSelection();
      }
    }

    const onEditorPointerStart = e => {
      if (editor.value.length > 0 || composing) {
        pointerDownInEditor = true;
        pointerDown = false;
        e.stopPropagation();
        clearTermSelection();
      }
    };
    const stopIfEditorHasText = e => {
      if (editor.value.length > 0 || composing) {
        e.stopPropagation();
      }
    };
    listen(editor, 'mousedown', onEditorPointerStart);
    listen(editor, 'pointerdown', onEditorPointerStart);
    listen(editor, 'touchstart', onEditorPointerStart, { passive: true });
    listen(editor, 'click', stopIfEditorHasText);
    listen(editor, 'dblclick', stopIfEditorHasText);
    listen(editor, 'contextmenu', stopIfEditorHasText);
    listen(editor, 'paste', e => e.stopPropagation());
    listen(editor, 'copy', e => e.stopPropagation());
    listen(editor, 'cut', e => e.stopPropagation());

    listen(editor, 'input', () => {
      clearTermSelection();
      scheduleSync(true);
    });

    listen(editor, 'compositionstart', () => {
      composing = true;
      scheduleSync(true);
    });

    listen(editor, 'compositionend', () => {
      composing = false;
      scheduleSync(true);
    });

    listen(host, 'mousedown', e => {
      if (e.target === editor && (editor.value.length > 0 || composing)) return;
      pointerDown = true;
      // Let drags that start inside terminal pass cleanly over the overlay without textarea stealing mouseup/hover.
      if (isVisible()) editor.style.pointerEvents = 'none';
    }, true);

    listen(win, 'mouseup', () => {
      if (pointerDownInEditor) {
        pointerDownInEditor = false;
        editor.style.pointerEvents = 'auto';
        return;
      }
      if (!pointerDown) return;
      pointerDown = false;
      editor.style.pointerEvents = 'auto';
      if (term.hasSelection && term.hasSelection()) return;
      if (isTermTreeFocused() && suppressedRow === -1) {
        sync(true);
        win.setTimeout(() => {
          if (term.hasSelection && term.hasSelection()) return;
          if (isTermTreeFocused() && suppressedRow === -1 && doc.activeElement !== editor) sync(true);
        }, 0);
      }
    });

    listen(host, 'focusin', e => {
      if (e.target === editor) {
        hasFocusedOnce = true;
        host.classList.add('wt-local-editor-active');
        return;
      }
      if (e.target === getHelperTa()) {
        hasFocusedOnce = true;
        if (!pointerDown && !pointerDownInEditor && !(term.hasSelection && term.hasSelection())) sync(true);
      }
    });

    listen(win, 'blur', () => {
      pointerDown = false;
      pointerDownInEditor = false;
      editor.style.pointerEvents = 'auto';
      host.classList.remove('wt-local-editor-active');
    });

    listen(win, 'resize', () => scheduleSync(false));

    if (term.onWriteParsed) {
      disposables.push(term.onWriteParsed(() => {
        if (pendingSubmit) {
          pendingSubmit.seenWrite = true;
          if (bufferContainsSubmitted(pendingSubmit)) {
            finishSubmit();
          }
        }
        scheduleSync(false);
      }));
    }

    if (term.onResize) disposables.push(term.onResize(() => scheduleSync(false)));
    if (term.onScroll) disposables.push(term.onScroll(() => scheduleSync(false)));
    if (term.onTitleChange) {
      disposables.push(term.onTitleChange(title => {
        editorTitle = /(?:^|[\s/:\-])(?:vim?|nvim|nano|emacs|less|more|man|htop|btop|top|mc|tig|lazygit)(?:[\s:|\-]|$)/i.test(title);
        scheduleSync(false);
      }));
    }

    if (term.parser && term.parser.registerCsiHandler) {
      const modeHandler = () => params => {
        if (params.some(p => [47, 1047, 1049].includes(p))) {
          anchoredPromptPrefix = '';
          anchoredRow = -1;
          suppressedRow = -1;
          scheduleSync(false);
        }
        return false;
      };
      disposables.push(term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, modeHandler()));
      disposables.push(term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, modeHandler()));
    }

    const timer = win.setInterval(() => {
      if (!isVisible() && isTermTreeFocused() && suppressedRow === -1) sync(false);
    }, 150);

    return {
      setEnabled(value) {
        enabled = !!value;
        if (!enabled) {
          hideEditor(true);
          focusHelper();
        } else {
          sync(isTermTreeFocused());
        }
      },
      get enabled() { return enabled; },
      get pendingText() { return isVisible() ? editor.value : ''; },
      get pausedReason() { return reason; },
      submitText(text) { submitPayload(String(text || '').replace(/\r\n?/g, '\n'), false); },
      sendRaw(data) { sendRaw(String(data || '')); },
      dispose() {
        if (disposed) return;
        disposed = true;
        enabled = false;
        clearPendingSubmit();
        win.clearInterval(timer);
        for (const d of disposables) d.dispose();
        for (const off of listeners) off();
        hideEditor(true);
        editor.remove();
        styleEl.remove();
      }
    };
  }

  return { PredictionCore, cellWidth, snapshot, attach };
});
