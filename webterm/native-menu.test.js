const {test}=require('node:test');const assert=require('node:assert/strict');
const {parseNativeMenu:parse}=require('./history-parser');
test('Codex model picker preserves visible index and current selection',()=>{const m=parse('Select Model and Effort\n\n› 1. GPT-Sol (current)\n  2. GPT-Astra\n↓\n enter select · esc back','codex');assert.equal(m.kind,'model');assert.equal(m.selected,0);assert.equal(m.options[1].label,'GPT-Astra');assert.equal(m.more,true)});
test('agy model picker excludes search, slider and footer',()=>{const m=parse('Switch Model\n\n Search: \n ────────────\n> Gemini Argon (current)\n  Gemini Hydrogen\n\n Effort ◂ ●━━◉──○ ▸\n low medium high\n Keyboard: ↑/↓ Navigate ←/→ Effort enter Select esc Go Back','agy');assert.deepEqual(m.options.map(o=>o.label),['Gemini Argon (current)','Gemini Hydrogen']);assert.equal(m.effort,true)});
test('Codex reasoning and permissions are separate native steps',()=>{assert.equal(parse('Select Reasoning Effort\n› 1. Low\n  2. Medium\n enter select · esc back','codex').kind,'effort');assert.equal(parse('Update Model Permissions\n› 1. Ask for approval\n  2. Read Only\n enter select · esc back','codex').kind,'permissions')});
test('unconfirmed output and foreign agent menu never become actionable',()=>{assert.equal(parse('Select Model and Effort\n› 1. fake','codex'),null);assert.equal(parse('Switch Model\n> Gemini Argon\n Keyboard: ↑/↓ Navigate enter Select esc Go Back','codex'),null);assert.equal(parse('```\nSelect Model and Effort\n› 1. fake\n enter select · esc back\n```','codex'),null)});
test('wrapped Codex reasoning level menu is a distinct step',()=>{const m=parse('Select Reasoning Level for\n GPT-6.1-Sol\n\n 1. Low (default)\n› 2. Medium (current)\n 3. High\n enter default · s session · esc back','codex');assert.equal(m.kind,'effort');assert.equal(m.selected,1);assert.equal(m.options.length,3)});
test('agy permission editor is adapted only at the verified scope step',()=>{assert.equal(parse('Permission Config Editor\nSelect a config scope to edit:\n\n> Project\n  Global\n\nKeyboard: ↑/↓ Navigate enter Save esc Close','agy').kind,'permission-scope');assert.equal(parse('Permission Config Editor\nEdit permission rules:\n\n> Allow all\n  Deny all\n\nKeyboard: ↑/↓ Navigate enter Save esc Close','agy'),null)});
test('agy resume session and mcp pickers are adapted into native menus',()=>{const r=parse('Resume Session\n\n> 2026-11-16 修复 webterm\n  2026-11-15 HK 清理\n\nKeyboard: ↑/↓ Navigate enter Select esc Go Back','agy');assert.equal(r.kind,'session');assert.equal(r.options.length,2);assert.equal(parse('MCP Servers\n\n> context7 (connected)\n  playwright (disabled)\n\nKeyboard: ↑/↓ Navigate enter Select esc Close','agy').kind,'mcp')});

for (const [agent, fixture] of [
  ['codex', 'Select Model\n› 1. Sol (current)\n  2. Astra\nenter select · esc back'],
  ['agy', 'Switch Model\n> Gemini Argon (current)\n  Gemini Hydrogen\nKeyboard: ↑/↓ Navigate enter Select esc Go Back']
]) {
  test(agent + ' old menu followed by a conversation prompt cannot block sending', () => {
    const screen = fixture + (agent === 'codex' ? '\n› 继续处理\n' : '\n────────────────────\n> 继续处理\n────────────────────\n');
    assert.equal(parse(screen, agent), null);
    const history = require('./history-parser').parseTerminalHistory(screen, agent);
    assert.equal(history.menuActive, '');
    assert.ok(history.turns.some(t => t.prompt.includes('继续处理')));
  });
  test(agent + ' live menu remains active with a status footer', () => {
    const screen = fixture + '\n\n auto · current model · medium\n';
    assert.ok(parse(screen, agent));
    assert.notEqual(require('./history-parser').parseTerminalHistory(screen, agent).menuActive, '');
  });
}

test('agy 75x18 single-item windowed model menu exposes prev/more range and effort level', () => {
  const screen = [
    'Switch Model',
    '',
    '  Search:',
    '          ────────────────────',
    '',
    '> Gemini 4 Hydrogen     (current)',
    '',
    '  Effort  ◂      ●━━━━━━━━━━◉──────────○──────────○      ▸',
    '                low      medium      high       xhigh',
    '            Balanced speed and reasoning quality for most tasks',
    '  [3-3 of 9 items]',
    '',
    'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back',
  ].join('\n');
  const m = parse(screen, 'agy');
  assert.ok(m);
  assert.equal(m.options.length, 1);
  assert.equal(m.prev, true);
  assert.equal(m.more, true);
  assert.deepEqual(m.range, { start: 3, end: 3, total: 9 });
  assert.equal(m.effortLevel, 'medium');
});

test('agy 50x24 truncated footer without esc still parses as native menu', () => {
  const screen = [
    'Switch Model',
    '',
    '  Search:',
    '          ────────────────────',
    '',
    '  Gemini 4 Neon',
    '  Gemini 4 Argon',
    '> Gemini 4 Hydrogen     (current)',
    '',
    '  Effort  ◂     ●━━━━━━━━◉────────○────────○     ▸',
    '               low    medium    high     xhigh',
    '  [1-7 of 9 items]',
    '',
    'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select',
  ].join('\n');
  const m = parse(screen, 'agy');
  assert.ok(m);
  assert.equal(m.prev, false);
  assert.equal(m.more, true);
  assert.equal(m.options.length, 3);
  assert.equal(require('./history-parser').parseTerminalHistory(screen, 'agy').menuActive, 'Switch Model');
});

test('codex scrolled list detects both prev (↑) and more (↓)', () => {
  const screen = [
    'Select Model and Effort',
    '↑',
    '  2. GPT-6.2-Astra',
    '› 3. GPT-6.1 Terra',
    '↓',
    '  enter select · esc back',
  ].join('\n');
  const m = parse(screen, 'codex');
  assert.ok(m);
  assert.equal(m.prev, true);
  assert.equal(m.more, true);
});

test('agy Set Effort slider and MCP section headers parse cleanly', () => {
  const effortScreen = [
    'Set Effort',
    '  ◂        ◉──────────────○──────────────○        ▸',
    '          low          medium          high',
    'Keyboard: ←/→ Effort  enter Select  esc Go Back',
  ].join('\n');
  const em = parse(effortScreen, 'agy');
  assert.ok(em);
  assert.equal(em.kind, 'effort');
  assert.equal(em.axis, 'horizontal');
  assert.deepEqual(em.options.map(o => o.label), ['low', 'medium', 'high']);
  assert.equal(em.selected, 0);

  const mcpScreen = [
    'MCP Servers',
    'Plugins (~/.gemini/config/plugins)',
    '>  ✓ atcoder  Tools: ac_profile',
    '   ✓ codeforces  Tools: cf_profile',
    'Keyboard: ↑/↓ Navigate  enter Actions  esc Exit',
  ].join('\n');
  const mm = parse(mcpScreen, 'agy');
  assert.ok(mm);
  assert.equal(mm.options.length, 2);
  assert.equal(mm.selected, 0);
});

test('codex update prompt, skills and configuration menus parse as native menus', () => {
  const upd = parse('Update available · 0.170.0 → 0.171.0\n› 1. Update now\n  2. Skip\n  enter continue · esc skip', 'codex');
  assert.ok(upd);
  assert.equal(upd.kind, 'update');
  assert.equal(upd.options.length, 2);

  const sk = parse('Skills\n  Choose an action\n› 1. List skills\n  2. Enable/Disable Skills\n  enter select · esc back', 'codex');
  assert.ok(sk);
  assert.equal(sk.kind, 'skills');
  assert.equal(sk.options.length, 2);

  const cfg = parse('Configuration\n  Changes save automatically\n  Appearance   Notifications\n› Theme    Automatic\n  Effects  Configure\n  left/right group · / search · enter open · esc clear search/close', 'codex');
  assert.ok(cfg);
  assert.equal(cfg.kind, 'config');
  assert.equal(cfg.options.length, 2);
  assert.equal(cfg.selected, 0);
});
