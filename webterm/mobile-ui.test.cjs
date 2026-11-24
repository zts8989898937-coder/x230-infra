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
      if (!localStorage.getItem('wt_state_v1')) {
        localStorage.setItem('wt_state_v1', JSON.stringify({ version: 2, seq: 8, paneSeq: 8, activeId: 8, tabs }));
      }
      window.EventSource = class { addEventListener() {} close() {} };
    });
    await page.route('**/*', route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (pathname.startsWith('/tty')) {
        return route.fulfill({ contentType: 'text/html', body: '<textarea class="xterm-helper-textarea"></textarea>' });
      }
      if (pathname === '/history') return route.fulfill({ json: { pending: true } });
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

    await t.test('an undersized pane keeps a usable terminal viewport', async () => {
      const pane = page.locator('.pane.focused');
      const viewport = await pane.evaluate(el => {
        const { width, height } = el.style;
        el.style.width = '1px';
        el.style.height = '1px';
        const win = el.querySelector('iframe').contentWindow;
        const dimensions = [win.innerWidth, win.innerHeight];
        Object.assign(el.style, { width, height });
        return dimensions;
      });
      assert.ok(viewport[0] >= 176 && viewport[1] >= 112, JSON.stringify(viewport));
    });

    await t.test('holding an arrow never queues overlapping requests or repeats after release', async () => {
      await page.evaluate(() => {
        closeHistoryOverlay(getFocusedPaneEl());
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

    await t.test('folded mode gives the input more room and keeps terminal commands available', async () => {
      const keybar = page.locator('#mobile-keybar');
      const toolbarUpload = page.locator('#upload-btn');
      assert.equal(await keybar.isVisible(), true);
      assert.equal(await toolbarUpload.isVisible(), true);

      await page.locator('#hist-btn').tap();
      const history = page.locator('.pane.focused .pane-hist.open');
      assert.equal(await keybar.isVisible(), false);
      assert.equal(await toolbarUpload.isVisible(), false);
      for (const selector of ['[data-act="hist-upload"]', '.hist-send', '[data-send="ctrlc"]']) {
        assert.equal(await history.locator(selector).isVisible(), true);
      }
      const compose = history.locator('.hist-compose');
      const input = compose.locator('.hist-input');
      const sess = await page.locator('.pane.focused').getAttribute('data-sess');
      await input.fill('未发出的草稿');
      assert.equal(await history.locator('.hist-live').evaluate(el => el.open), false);
      for (const [key, raw] of [['up', '\x1b[A'], ['down', '\x1b[B']]) {
        await compose.locator('[data-terminal-key="' + key + '"]').tap({timeout: 2000});
        assert.deepEqual(await page.evaluate(() => window.mobileTestSends.at(-1)), { s: sess, raw });
        await page.evaluate(() => window.mobileTestFinish.at(-1)({ ok: true }));
      }
      assert.equal(await input.inputValue(), '未发出的草稿');
      await history.locator('[data-act="live"]').tap();
      assert.equal(await history.locator('.hist-live [data-terminal-key="up"]').isVisible(), true);
      assert.equal(await history.locator('.hist-live [data-terminal-key="enter"]').isVisible(), true);
      await history.locator('[data-act="close"]').tap();
      assert.equal(await keybar.isVisible(), true);
      assert.equal(await toolbarUpload.isVisible(), true);
    });

    await t.test('restored splits show one selectable pane on phones and both panes at desktop size', async () => {
      const savedRoot = await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('wt_state_v1'));
        const tab = state.tabs.find(t => t.id === state.activeId);
        tab.root = {
          type: 'split', dir: 'h', ratio: 0.5, a: tab.root,
          b: { type: 'leaf', id: 'p10', sess: 'test-10' }
        };
        state.paneSeq = 10;
        localStorage.setItem('wt_state_v1', JSON.stringify(state));
        return tab.root;
      });
      const closedSessions = [];
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/close') closedSessions.push(request.url());
      });
      await page.reload();
      const panes = page.locator('.pane:visible');
      const picker = page.locator('#mobile-pane-select');
      for (const id of ['split-h', 'split-v', 'close-pane']) {
        assert.equal(await page.locator('#' + id).isVisible(), false);
      }
      assert.equal(await panes.count(), 1);
      assert.equal(await page.locator('.resizer').count(), 0);
      assert.equal(await panes.evaluate(el => el.offsetWidth === el.parentElement.clientWidth), true);
      await picker.selectOption('p10');
      assert.equal(await panes.evaluate(el => el.dataset.sess), 'test-10');
      await page.keyboard.press('Alt+d');
      await page.keyboard.press('Alt+w');
      await page.setViewportSize({ width: 844, height: 390 });
      assert.equal(await panes.count(), 1);
      assert.equal(await picker.isVisible(), true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.resizer').waitFor({ state: 'visible' });
      assert.equal(await panes.count(), 2);
      assert.equal(await picker.isVisible(), false);
      assert.equal(await page.locator('#split-h').isVisible(), true);
      assert.deepEqual(await page.evaluate(() => active.root), savedRoot);
      assert.deepEqual(closedSessions, []);
    });

    await t.test('the narrow folded page keeps just one toolbar row and hides a stale jump button', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(origin + '/?public=1');
      await page.evaluate(() => {
        const tab = active;
        const leaf = findLeaf(tab.root, tab.activePaneId);
        tab.root = leaf;
        render();
        const pane = getFocusedPaneEl();
        openHistoryOverlay(pane);
        const reply = Array.from({ length: 80 }, (_, i) => '测试回复 ' + i).join('\n');
        window.applyMobileHistory = text => applyHistData(pane, {
          agent: 'codex', turns: [{ index: 1, summary: 'Safari 输入测试', prompt: 'Safari 输入测试', reply: text }]
        }, false, false);
        window.applyMobileHistory(reply);
        const st = paneHistState.get(pane);
        st.listEl.scrollTop = 0;
        st.listEl.dispatchEvent(new Event('scroll'));
      });
      const jump = page.locator('.pane.focused .hist-jump');
      assert.equal(await jump.isVisible(), true);
      await page.evaluate(() => window.applyMobileHistory('简短回复'));
      assert.equal(await jump.isVisible(), false);
      assert.equal(await page.locator('#paste').isVisible(), false);
      const status = await page.locator('#quota-pill').boundingBox();
      const wallpaper = await page.locator('#wall-btn').boundingBox();
      assert.ok(Math.abs(status.y - wallpaper.y) <= 2);

      const input = page.locator('.pane.focused .hist-input');
      await input.tap();
      await input.evaluate(el => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '/mo';
        el.setSelectionRange(3, 3);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      const completion = page.locator('.pane.focused .hist-ac');
      assert.equal(await completion.isVisible(), false);
      await input.dispatchEvent('compositionend', { bubbles: true });
      assert.equal(await completion.isVisible(), true);

      await context.grantPermissions(['clipboard-read'], { origin });
      await input.evaluate(el => {
        el.value = '待发送的草稿';
        el.focus();
        el.setSelectionRange(2, 4);
        window.readTestClipboard = navigator.clipboard.readText.bind(navigator.clipboard);
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        const button = document.createElement('button');
        button.textContent = '测试复制';
        button.style.cssText = 'position:fixed;top:45%;left:25%;z-index:999';
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => copyTextTop('复制的终端文字'));
        document.body.append(button);
      });
      const copy = await page.getByRole('button', { name: '测试复制' }).boundingBox({ timeout: 2000 });
      assert.ok(copy && copy.width && copy.height);
      await page.mouse.click(copy.x + copy.width / 2, copy.y + copy.height / 2);
      assert.deepEqual(await input.evaluate(el => [el === document.activeElement, el.selectionStart, el.selectionEnd]), [true, 2, 4]);
      assert.equal(await page.evaluate(() => window.readTestClipboard()), '复制的终端文字');
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
