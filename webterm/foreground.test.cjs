const { chromium, devices, webkit } = require('/usr/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
const session = 'foreground-test';

const mobileBrowser = process.env.WEBTERM_TEST_WEBKIT ? webkit : chromium;

for (const [profile, browserType, settings] of [
  ['desktop', chromium, {}],
  ['iPhone', mobileBrowser, devices['iPhone 13']],
  ...(mobileBrowser === webkit ? [['iPad', webkit, devices['iPad Pro 11 landscape']]] : [])
]) {
  test(profile + ' resumes the terminal safely', async t => {
    const browser = await browserType.launch();
    t.after(() => browser.close());
    const context = await browser.newContext(settings);
    const page = await context.newPage();
    const pageErrors = [];
    let historyTurns = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(sess => {
      if (window.top !== window) return;
      localStorage.setItem('wt_state_v1', JSON.stringify({
        version: 2, seq: 1, paneSeq: 1, activeId: 1,
        tabs: [{id: 1, name: '测试', activePaneId: 'p1', root: {type: 'leaf', id: 'p1', sess}}]
      }));
      let hidden = false;
      Object.defineProperty(document, 'hidden', {get: () => hidden});
      window.setHiddenForTest = value => {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      };
      window.resumeAfterMinuteForTest = async () => {
        const now = Date.now;
        window.setHiddenForTest(true);
        try {
          Date.now = () => now() + 61000;
          window.setHiddenForTest(false);
          window.dispatchEvent(new Event('pageshow'));
          window.dispatchEvent(new Event('focus'));
          await new Promise(resolve => setTimeout(resolve, 450));
        } finally {
          Date.now = now;
        }
      };
      window.historyConnections = [];
      window.EventSource = class extends EventTarget {
        constructor(url) {
          super();
          this.readyState = 1;
          if (url.startsWith('/history-stream')) window.historyConnections.push(this);
        }
        close() { this.readyState = 2; }
      };
    }, session);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: html});
      if (url.pathname.startsWith('/tty')) {
        return route.fulfill({contentType: 'text/html', body: '<script>window.__wtSocket={readyState:1};window.term={};</script>'});
      }
      if (url.pathname === '/history') return route.fulfill({json: {sess: session, cmd: 'fish', turns: historyTurns}});
      if (url.pathname === '/screen') return route.fulfill({json: {text: '已恢复的终端画面'}});
      return route.fulfill({json: {}});
    });
    await page.goto('http://127.0.0.1:3902/');
    await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.__wtSocket?.readyState === 1);

    await t.test('a fresh online event retries a terminal that exhausted its retries', async () => {
      const reconnected = await page.evaluate(async () => {
        const frame = getFocusedPaneEl().querySelector('iframe');
        frame.contentWindow.__wtSocket.readyState = 3;
        frame.dataset.autoRetries = '4';
        frame.dataset.connectSince = String(Date.now() - 20000);
        window.dispatchEvent(new Event('online'));
        await new Promise(resolve => setTimeout(resolve, 450));
        return frame.src.includes('arg=foreground-test&retry=');
      });
      assert.equal(reconnected, true);
    });

    await t.test('a healthy terminal keeps its iframe on a short tab switch', async () => {
      const unchanged = await page.evaluate(async () => {
        const frame = getFocusedPaneEl().querySelector('iframe');
        const doc = frame.contentDocument;
        const url = frame.src;
        setHiddenForTest(true);
        setHiddenForTest(false);
        window.dispatchEvent(new Event('focus'));
        await new Promise(resolve => setTimeout(resolve, 450));
        return doc === frame.contentDocument && frame.src === url;
      });
      assert.equal(unchanged, true);
    });

    await t.test('a minute in background reconnects a possibly stale native socket once', async () => {
      const requestUrls = [];
      const recordRequest = request => {
        if (new URL(request.url()).pathname === '/tty/') requestUrls.push(request.url());
      };
      page.on('request', recordRequest);
      try {
        await page.evaluate(() => resumeAfterMinuteForTest());
        assert.equal(requestUrls.length, 1);
        assert.match(requestUrls[0], /arg=foreground-test&retry=/);
      } finally {
        page.off('request', recordRequest);
      }
    });

    await t.test('a folded terminal reconnects on reveal after a minute away', async () => {
      const result = await page.evaluate(async () => {
        const pane = getFocusedPaneEl();
        const frame = pane.querySelector('iframe');
        const originalUrl = frame.src;
        openHistoryOverlay(pane);
        await resumeAfterMinuteForTest();
        const keptFolded = pane.classList.contains('hist-active') && frame.src === originalUrl;
        closeHistoryOverlay(pane);
        return {keptFolded, reconnectedOnReveal: frame.src !== originalUrl && frame.src.includes('arg=foreground-test&retry=')};
      });
      assert.deepEqual(result, {keptFolded: true, reconnectedOnReveal: true});
    });

    await t.test('leaving and restoring a cached page reopens one history stream and keeps the draft', async () => {
      const result = await page.evaluate(async () => {
        const pane = getFocusedPaneEl();
        focusPaneById(pane.dataset.paneId);
        openHistoryOverlay(pane);
        await refreshHistPane(pane);
        const st = paneHistState.get(pane);
        st.inputEl.value = '未发送的草稿';
        st.inputEl.dispatchEvent(new Event('input', {bubbles: true}));
        st.searchEl.focus();
        const stream = st.es;
        const connections = historyConnections.length;
        window.dispatchEvent(new Event('pagehide'));
        const closedWhileAway = stream.readyState === 2;
        window.dispatchEvent(new Event('pageshow'));
        window.dispatchEvent(new Event('focus'));
        await new Promise(resolve => setTimeout(resolve, 450));
        const newStreams = historyConnections.length - connections;
        const revision = st.streamRevision || 0;
        stream.dispatchEvent(new MessageEvent('hist', {data: JSON.stringify({sess: pane.dataset.sess, cmd: 'claude', turns: []})}));
        return {closedWhileAway, newStreams, draft: st.inputEl.value,
          oldEventsIgnored: (st.streamRevision || 0) === revision,
          searchStillFocused: document.activeElement === st.searchEl,
          historyStillOpen: st.root.classList.contains('open')};
      });
      assert.deepEqual(result, {closedWhileAway: true, newStreams: 1, draft: '未发送的草稿', oldEventsIgnored: true,
        searchStillFocused: true, historyStillOpen: true});
    });

    if (profile !== 'desktop') {
      await t.test('refits the visible area after the keyboard closes while Safari is in the background', async () => {
        const initial = await page.evaluate(() => {
          const viewport = window.visualViewport;
          const fullHeight = Math.round(viewport.height);
          window.testViewportHeight = fullHeight - 180;
          Object.defineProperty(viewport, 'height', {get: () => window.testViewportHeight});
          viewport.dispatchEvent(new Event('resize'));
          return {fullHeight, keyboardHeight: fullHeight - 180};
        });
        await page.waitForFunction(height => Math.abs(document.getElementById('app').getBoundingClientRect().height - height) < 1, initial.keyboardHeight, {timeout: 10000, polling: 50});
        await page.evaluate(height => {
          setHiddenForTest(true);
          window.dispatchEvent(new Event('pagehide'));
          setHiddenForTest(false);
          window.dispatchEvent(new Event('pageshow'));
          // The browser's viewport can settle after pageshow without another resize event.
          setTimeout(() => { window.testViewportHeight = height; }, 220);
        }, initial.fullHeight);
        await page.waitForFunction(height => Math.abs(document.getElementById('app').getBoundingClientRect().height - height) < 1, initial.fullHeight, {timeout: 10000, polling: 50});
        await page.evaluate(height => {
          window.testViewportHeight = height;
          window.dispatchEvent(new Event('focus'));
        }, initial.keyboardHeight);
        await page.waitForFunction(height => Math.abs(document.getElementById('app').getBoundingClientRect().height - height) < 1, initial.keyboardHeight, {timeout: 10000, polling: 50});
      });
    }

    await t.test('a stalled history stream reconnects and fetches the missed reply', async () => {
      await page.evaluate(async () => {
        const pane = getFocusedPaneEl();
        openHistoryOverlay(pane);
        await refreshHistPane(pane);
        const stream = paneHistState.get(pane).es;
        stream.dispatchEvent(new Event('open'));
        const now = Date.now;
        try {
          Date.now = () => now() + 10000;
          stream.dispatchEvent(new MessageEvent('heartbeat', {data: '{}'}));
          Date.now = () => now() + 15000;
          syncHistStreams();
          if (stream.readyState !== 1) throw Error('closed a stream that was still receiving heartbeats');
        } finally {
          Date.now = now;
        }
      });
      historyTurns = [{index: 1, summary: '测试补收', prompt: '测试补收', reply: '补收到的回复'}];
      const replaced = await page.evaluate(() => {
        const st = paneHistState.get(getFocusedPaneEl());
        const stream = st.es;
        const now = Date.now;
        try {
          Date.now = () => now() + 26000;
          syncHistStreams();
        } finally {
          Date.now = now;
        }
        return st.es !== stream && stream.readyState === 2;
      });
      assert.equal(replaced, true, 'an apparently open but silent stream should be replaced');
      await page.locator('.hist-list').getByText('补收到的回复').waitFor({timeout: 4000});
    });

    assert.deepEqual(pageErrors, []);
  });
}
