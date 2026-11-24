const { chromium, webkit } = require('/usr/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const session = 'codex-history-fixture';
const turns = Array.from({ length: 250 }, (_, index) => ({
  id: 'turn-' + index, index, summary: '问题 ' + index, prompt: '问题 ' + index,
  reply: '答复 ' + index, lineCount: 2
}));
const history = {
  sess: session, cmd: 'codex', agent: 'codex', runningAgent: 'codex', model: 'GPT-6.2-Sol medium',
  historySource: 'codex-rollout', turns
};

test('desktop and narrow layouts can open and search a 250-turn Codex history', async t => {
  const engine = process.env.WEBTERM_TEST_WEBKIT ? webkit : chromium;
  const browser = await engine.launch({ executablePath: process.env.WEBTERM_TEST_BROWSER });
  t.after(() => browser.close());

  for (const width of [1440, 390]) {
    await t.test(width + 'px', async t => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      t.after(() => context.close());
      await context.addInitScript(sess => {
        if (window.top !== window) return;
        localStorage.setItem('wt_state_v1', JSON.stringify({
          version: 2, seq: 1, paneSeq: 1, activeId: 1, tabs: [{
            id: 1, name: '历史检查', activePaneId: 'p1',
            root: { type: 'leaf', id: 'p1', sess }
          }]
        }));
        window.EventSource = class {
          addEventListener() {}
          close() {}
        };
      }, session);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let displayedHistory = history;
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname === '/history') return route.fulfill({ json: displayedHistory });
        if (url.pathname.startsWith('/tty')) {
          return route.fulfill({ contentType: 'text/html', body: '<body></body>' });
        }
        if (url.pathname === '/screen') return route.fulfill({ json: { text: '' } });
        return route.fulfill({ json: {} });
      });
      await page.goto('http://127.0.0.1:3902/');
      const toggle = page.locator('.hist-older-toggle');
      const rows = page.locator('.hist-older-row');
      await toggle.click();
      assert.match(await toggle.innerText(), /全部对话 · 250 轮/);
      assert.equal(await rows.count(), 250);
      assert.equal(await page.locator('.hist-agent-model').innerText(), history.model);
      await rows.first().click();
      assert.match(await page.locator('.hist-list').innerText(), /答复 0/);
      await page.locator('.hist-back-latest').click();
      assert.match(await page.locator('.hist-list').innerText(), /答复 249/);
      await page.locator('.hist-search').fill('问题 100');
      assert.match(await page.locator('.hist-list').innerText(), /答复 100/);
      const search = page.locator('.hist-search');
      const badge = page.locator('.hist-banner .hist-agent-model');
      assert.ok(await badge.isVisible());
      await search.fill('没有这条对话');
      assert.match(await page.locator('.hist-empty').innerText(), /没有匹配/);
      assert.ok(await badge.isVisible());
      assert.equal(await badge.innerText(), history.model);

      const apply = data => page.evaluate(data => applyHistData(getFocusedPaneEl(), data, false, false), data);
      displayedHistory = { ...history, turns: [] };
      await apply(displayedHistory);
      await search.clear();
      await badge.waitFor({ timeout: 2000 });
      assert.equal(await badge.innerText(), history.model);

      displayedHistory = {
        ...history, cmd: 'agy', agent: 'agy', runningAgent: 'agy', historySource: 'terminal',
        model: 'Gemini 4 Hydrogen · high', banner: '▀▄ Antigravity CLI', bannerCaptured: true,
        turns: turns.slice(0, 2)
      };
      await apply(displayedHistory);
      await badge.waitFor({ timeout: 2000 });
      assert.equal(await badge.innerText(), displayedHistory.model);
      assert.equal(await page.locator('.hist-banner-pre').count(), 0);
      const card = await page.locator('.hist-banner .hist-agent-card').elementHandle();
      await apply({ ...displayedHistory, turns: [{...turns[0]}, {...turns[1], reply: '新回复'}] });
      assert.ok(await card.evaluate(node => node.isConnected));
      await apply({ ...displayedHistory, model: 'Gemini 4 Neon · medium' });
      assert.equal(await badge.innerText(), 'Gemini 4 Neon · medium');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    });
  }
});
