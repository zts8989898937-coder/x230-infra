const { chromium, webkit, devices } = require('/usr/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

const engine = process.env.WEBTERM_TEST_WEBKIT ? webkit : chromium;
const origin = 'http://127.0.0.1:3902';
const html = readFileSync(process.env.WEBTERM_TEST_INDEX || __dirname + '/index.html', 'utf8');

test('mobile terminal', async t => {
  const browser = await engine.launch({ executablePath: process.env.WEBTERM_TEST_BROWSER });
  try {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      viewport: { width: 390, height: 844 }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      const tabs = Array.from({ length: 8 }, (_, index) => {
        const id = index + 1;
        const pane = 'p' + id;
        return { id, name: '测试标签 ' + id, activePaneId: pane, root: { type: 'leaf', id: pane, sess: 'test-' + id } };
      });
      localStorage.setItem('wt_state_v1', JSON.stringify({ version: 2, seq: 8, paneSeq: 8, activeId: 8, tabs }));
      window.EventSource = class { addEventListener() {} close() {} };
    });
    await page.route('**/*', route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (pathname.startsWith('/tty')) {
        return route.fulfill({ contentType: 'text/html', body: '<textarea class="xterm-helper-textarea"></textarea>' });
      }
      return route.fulfill({ json: { cmds: {}, agents: {} } });
    });
    await page.goto(origin);

    await t.test('active tab and add button remain visible with many tabs', async () => {
      const positions = await page.evaluate(() => {
        const list = document.querySelector('#tablist').getBoundingClientRect();
        const tab = document.querySelector('.tab.active').getBoundingClientRect();
        const add = document.querySelector('#add').getBoundingClientRect();
        const wrap = document.querySelector('#tabs-wrap').getBoundingClientRect();
        return { tabVisible: tab.left >= list.left - 1 && tab.right <= list.right + 1,
          addVisible: add.right <= wrap.right + 1, width: document.documentElement.scrollWidth };
      });
      assert.deepEqual(positions, { tabVisible: true, addVisible: true, width: 390 });
      await page.locator('#add').tap();
      assert.equal(await page.locator('.tab.active .tname').textContent(), 'fish 9');
    });

    await t.test('tab changes leave the soft keyboard closed until the user taps the input', async () => {
      await page.evaluate(() => {
        const pane = getFocusedPaneEl();
        const state = ensureHistOverlay(pane);
        state.root.classList.add('open');
        pane.classList.add('hist-active');
        document.activeElement.blur();
        focusActive();
      });
      assert.equal(await page.locator('.pane.focused .hist-input').evaluate(el => el === document.activeElement), false);
      await page.locator('.pane.focused .hist-input').tap();
      assert.equal(await page.locator('.pane.focused .hist-input').evaluate(el => el === document.activeElement), true);
    });

    await t.test('holding an arrow never queues overlapping requests or repeats after release', async () => {
      await page.evaluate(() => {
        window.mobileTestSends = [];
        window.mobileTestFinish = [];
        const fetchPage = window.fetch;
        window.fetch = (url, options) => {
          if (url !== '/send') return fetchPage(url, options);
          window.mobileTestSends.push(JSON.parse(options.body));
          return new Promise(resolve => window.mobileTestFinish.push(resolve));
        };
      });
      const arrow = page.locator('[data-mkey=up]');
      await arrow.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true });
      await page.waitForTimeout(550);
      const pending = await page.evaluate(() => window.mobileTestSends.length);
      await arrow.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true });
      await page.evaluate(() => window.mobileTestFinish.forEach(resolve => resolve({ ok: true })));
      await page.waitForTimeout(150);
      assert.equal(pending, 1);
      const sends = await page.evaluate(() => window.mobileTestSends);
      assert.equal(sends.length, 1);
      assert.equal(sends[0].raw, '\x1b[A');
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
