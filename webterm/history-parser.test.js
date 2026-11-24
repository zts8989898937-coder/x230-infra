const {test}=require('node:test');const assert=require('node:assert/strict');
const {parseTerminalHistory:parse}=require('./history-parser');
test('shell command overrides an old agent banner',()=>assert.equal(parse('OpenAI Codex\n\n╭╴ zts at /\n╰─ >','fish').agent,''));
test('prompt-like lines inside fenced code remain reply content',()=>{const d=parse('> 测试\n\n```text\n\n> echoed text\n```\n\n> 下一轮\n\n完成','agy');assert.equal(d.turns.length,2);assert.match(d.turns[0].reply,/> echoed text/)});
test('ANSI prompts and multiline replies survive',()=>{const d=parse('\x1b[1;34m› 问题\x1b[0m\n\n答案\n下一行\n\n› 第二问\n\n第二答','codex');assert.equal(d.turns.length,2);assert.equal(d.turns[0].prompt,'问题');assert.equal(d.turns[0].reply,'答案\n下一行');assert.match(d.turns[0].promptAnsi,/\x1b/)});
test('model menus do not create fake dialogue turns',()=>{const d=parse('› 问题\n\n回答\n\n  Select Model and Effort\n\n› 1. GPT-6.1-Sol (current)\n  2. GPT-6-Astra\n\n enter select · esc back','codex');assert.equal(d.turns.length,1);assert.equal(d.turns[0].reply,'回答');assert.equal(d.menuActive,'Select Model and Effort')});
test('numbered user prompts are preserved outside menus',()=>{const d=parse('› 1. 请解释网络分层\n\n回答','codex');assert.equal(d.turns.length,1);assert.equal(d.turns[0].prompt,'1. 请解释网络分层')});
test('agy live composer and task footer stay out of replies',()=>{const d=parse('> 问题\n\n正在处理\n\n────────────────────\n>\n────────────────────\n\n● [00:56:01] echo hello running','agy');assert.equal(d.turns[0].reply,'正在处理')});
test('Codex working footer and tips are not dialogue',()=>{const d=parse('› 问题\n\n正在处理\n\n• Working (17m 09s • esc to interrupt)\n\n› Tip: Use /vim to toggle Vim editing in the composer','codex');assert.equal(d.turns.length,1);assert.equal(d.turns[0].reply,'正在处理')});
test('terminal frame examples inside code stay intact',()=>{const d=parse('> 展示终端\n\n```text\n────────────────────\n>\n────────────────────\n```','agy');assert.match(d.turns[0].reply,/>\n/)});
test('agy Orchestrator Argon footer and running chrome are parsed cleanly',()=>{const d=parse('> /model\n\n> 实测问题\n\n真实回复\n⣾  Running command...\n└ Tip: Use /feedback to share your experience with the team.\n────────────────────\n>\n────────────────────\n● [01:40:27] cmd running\nPress up to edit queued messages          auto · Orchestrator (Argon) · high','agy');assert.equal(d.model,'Orchestrator (Argon) · high');assert.equal(d.turns.length,1);assert.equal(d.turns[0].prompt,'实测问题');assert.equal(d.turns[0].reply,'真实回复')});

test('Codex at phone width keeps prompt continuation and hides its queue status', () => {
  const bg = '\x1b[48;2;40;40;40m';
  const first = '我需要针对 Safari 浏览器的特点进行针对性的';
  const footer = '\n  GPT-6.2-Sol medium · / · 回应问候\n  tab to queue message';
  for (const continuation of ['  优化', '\x1b[0m  ' + bg + '优化\x1b[49m']) {
    const capture = bg + '› ' + first + '\n' + continuation +
      '\n\x1b[49m  有实际缩进的回复' + footer;
    const { turns } = parse(capture, 'codex');
    assert.equal(turns[0].prompt, first + '\n优化');
    assert.equal(turns[0].reply, '  有实际缩进的回复');
  }
});

test('Codex model is read from the status line rather than the dialogue', () => {
  const dialogue = '› 当前模型是什么\n\n你可以试用 GPT-6.2-Sol xhigh。';
  assert.equal(parse(dialogue, 'codex').model, '');
  assert.equal(parse(dialogue + '\n  GPT-6.2-Sol medium · / · 回应问候', 'codex').model,
    'GPT-6.2-Sol medium');
});

test('AGY exited slash commands and autocomplete ghosts do not create fake turns', () => {
  const capture = [
    '> /model',
    '  ⎿  Exited /model command',
    '> /skills  List available skills',
    '  ↑/↓ Navigate · enter Select · tab Complete',
    'esc to cancel                               auto · Claude Sonnet 5.5 · low',
    '  ⎿  Exited /effort command',
    '> 真正的问题',
    '真正的回答',
  ].join('\n');
  const d = parse(capture, 'agy');
  assert.equal(d.turns.length, 1);
  assert.equal(d.turns[0].prompt, '真正的问题');
  assert.equal(d.turns[0].reply, '真正的回答');
});

test('Codex /diff pager, /theme, /config, /resume and /status output are recognized cleanly', () => {
  const diffPager = 'diff --git a/x b/x\n~\n──────────────────────── 100% ─\n ↑/↓ to scroll · pgup/pgdn to page\n q close';
  const dp = parse(diffPager, 'codex');
  assert.equal(dp.menuActive, '终端分页视图');
  assert.equal(dp.menuCloseKey, 'q');
  assert.equal(dp.turns.length, 0);

  const theme = 'Type to filter themes...\n  catppuccin-latte\n› catppuccin-mocha (current)\n↓\n  enter select · esc back';
  const tp = parse(theme, 'codex');
  assert.equal(tp.menuActive, 'Select Theme');
  assert.equal(tp.turns.length, 0);

  const statusOut = '  Permissions: Workspace\n  Context window: 100% left (0 used / 128K)\n  5h limit: 100% left\n› Ask Codex to do anything\n  GPT-6.2-Sol medium · /';
  const sp = parse(statusOut, 'codex');
  assert.equal(sp.turns.length, 0);
  assert.match(sp.slashOutput, /Context window: 100% left/);
});

test('Codex local command output stays outside ordinary turns', () => {
  for (const command of ['/status', '/mcp']) {
    const output = command === '/mcp'
      ? '🔌 MCP Tools\n  example-tool'
      : '│ OpenAI Codex │\n│ Model: GPT-6.2-Sol │\n│ 5h limit: 100% left │';
    for (const lead of ['› ', '']) {
      const parsed = parse('› question\n\nanswer\n\n' + lead + command + '\n' + output + '\n› Ask Codex to do anything', 'codex');
      assert.equal(parsed.turns.length, 1);
      assert.equal(parsed.turns[0].reply, 'answer');
      assert.ok(parsed.slashOutput.includes(command === '/mcp' ? 'example-tool' : '5h limit'));
    }
  }
});

test('fenced command output examples stay in the reply', () => {
  const p = parse('› question\n\n```text\n/status\n5h limit: 80%\n/mcp\n🔌 MCP Tools\n```','codex');
  assert.equal(p.slashOutput, '');
  assert.match(p.turns[0].reply, /5h limit: 80%/);
});

test('an old picker in shell scrollback cannot block shell input', () => {
  const p = parse('Select Model\n› 1. Sol (current)\nenter select · esc back\n╭╴ zts at /\n╰─ >', 'fish');
  assert.equal(p.menuActive, '');
});

test('a fence marker with trailing text does not close the fence around menu examples', () => {
  const p = parse('› question\n\n```text\n```example\nSelect Model\n› Sol\nenter select · esc back\n```', 'codex');
  assert.equal(p.menuActive, '');
  assert.match(p.turns[0].reply, /enter select · esc back/);
});

test('inline theme picker leaves the preceding conversation intact', () => {
  const p = parse('› question\n\nanswer\n\nType to filter themes...\n  latte\n› mocha (current)\nenter select · esc back', 'codex');
  assert.equal(p.menuActive, 'Select Theme');
  assert.equal(p.turns[0]?.reply, 'answer');
});

test('a single quota label in a normal answer is not command output', () => {
  const p = parse('› Explain the setting\n\nThis example uses:\nWeekly limit: other value', 'codex');
  assert.equal(p.slashOutput, '');
  assert.match(p.turns[0].reply, /Weekly limit: other value/);
});
