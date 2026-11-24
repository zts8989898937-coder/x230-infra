const { chromium, devices } = require('/usr/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const html = fs.readFileSync(process.env.WEBTERM_TEST_INDEX || path.join(__dirname, 'index.html'), 'utf8');

for (const width of [1440, 390]) {
  test(`folded conversation at ${width}px`, async t => {
    const browser = await chromium.launch({ executablePath: process.env.WEBTERM_TEST_BROWSER });
    try {
      const context = await browser.newContext({
        ...(width === 390 ? devices['iPhone 13'] : {}),
        viewport: {width, height: 900}
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
      await page.addInitScript(() => {
        localStorage.setItem('wt_state_v1', JSON.stringify({
          version: 2, seq: 2, paneSeq: 2, activeId: 1,
          tabs: [1, 2].map(id => ({
            id, name: '测试会话 ' + id, activePaneId: 'p' + id,
            root: {type: 'leaf', id: 'p' + id, sess: 'fold-test-' + id}
          }))
        }));
        window.EventSource = class { addEventListener() {} close() {} };
        const interval = window.setInterval.bind(window);
        window.setInterval = (fn, delay, ...args) => delay === 800 ? 0 : interval(fn, delay, ...args);
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: html});
        if (url.pathname.startsWith('/tty')) return route.fulfill({contentType: 'text/html', body: '<body></body>'});
        if (url.pathname === '/history') {
          return route.fulfill({json: {sess: url.searchParams.get('s'), cmd: 'fish', turns: []}});
        }
        if (url.pathname === '/screen') return route.fulfill({json: {text: '测试终端画面'}});
        return route.fulfill({json: {}});
      });
      await page.goto('http://127.0.0.1:3902/');
      await t.test('stale poll does not fold a tab switched to the background', async () => {
        const opened = await page.evaluate(async () => {
          const pane = getFocusedPaneEl();
          const original = window.fetch;
          let respond;
          window.fetch = (url, init) => url === '/session-cmds'
            ? new Promise(resolve => { respond = resolve; })
            : original(url, init);
          const request = fetchActiveAgentFold();
          active = tabs[1];
          render();
          respond(Response.json({agents: {'fold-test-1': 'codex'}}));
          await request;
          window.fetch = original;
          return pane.classList.contains('hist-active');
        });
        assert.equal(opened, false);
      });

      await t.test('auto fold opens for the agent and closes after it exits', async () => {
        const result = await page.evaluate(async () => {
          const pane = getFocusedPaneEl();
          const original = window.fetch;
          let reply = {agents: {'fold-test-2': 'codex'}};
          window.fetch = (url, init) => url === '/session-cmds'
            ? Promise.resolve(Response.json(reply))
            : original(url, init);
          try {
            await fetchActiveAgentFold();
            const opened = pane.classList.contains('hist-active');
            reply = {cmds: {'fold-test-2': 'fish'}};
            for (let i = 0; i < 3; i++) await fetchActiveAgentFold();
            return {opened, closed: !pane.classList.contains('hist-active')};
          } finally {
            window.fetch = original;
          }
        });
        assert.deepEqual(result, {opened: true, closed: true});
      });

      await t.test('manual history stays open after the agent exits', async () => {
        const opened = await page.evaluate(async () => {
          const pane = getFocusedPaneEl();
          openHistoryOverlay(pane);
          const st = paneHistState.get(pane);
          await refreshHistPane(pane);
          st.data.runningAgent = 'codex';
          const original = window.fetch;
          window.fetch = (url, init) => url === '/session-cmds'
            ? Promise.resolve(Response.json({cmds: {'fold-test-2': 'fish'}}))
            : original(url, init);
          for (let i = 0; i < 3; i++) await fetchActiveAgentFold();
          window.fetch = original;
          return pane.classList.contains('hist-active');
        });
        assert.equal(opened, true);
      });

      await t.test('Tab uses the current path while the old suggestion is still visible', async () => {
        const result = await page.evaluate(async () => {
          const st = paneHistState.get(getFocusedPaneEl());
          const original = window.fetch;
          let release;
          const pending = new Promise(resolve => { release = resolve; });
          window.fetch = async (url, init) => {
            if (!String(url).startsWith('/complete?')) return original(url, init);
            const query = new URL(url, location.href).searchParams.get('q');
            if (query === './new') await pending;
            return Response.json({items: [{label: query + '-file', insert: query + '-file'}]});
          };
          const fill = value => {
            st.inputEl.value = value;
            st.inputEl.setSelectionRange(value.length, value.length);
            st.inputEl.dispatchEvent(new Event('input', {bubbles: true}));
          };
          try {
            fill('./old');
            for (let i = 0; i < 40 && st.acItems[0]?.insert !== './old-file'; i++) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            if (st.acItems[0]?.insert !== './old-file') throw Error('original suggestion did not load');
            fill('./new');
            st.inputEl.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}));
            const beforeResponse = st.inputEl.value;
            release();
            await new Promise(resolve => setTimeout(resolve, 100));
            return {beforeResponse, completed: st.inputEl.value};
          } finally {
            window.fetch = original;
            fill('');
          }
        });
        assert.deepEqual(result, {beforeResponse: './new', completed: './new-file'});
      });

      await t.test('failed draft send does not send Alt+M', async () => {
        const result = await page.evaluate(async () => {
          const pane = getFocusedPaneEl();
          openHistoryOverlay(pane);
          const st = paneHistState.get(pane);
          const original = window.fetch;
          const sends = [];
          window.fetch = (url, init) => {
            if (url !== '/send') return original(url, init);
            sends.push(JSON.parse(init.body));
            return Promise.reject(new Error('response lost'));
          };
          st.inputEl.value = '待发送草稿';
          await st.triggerAltM();
          await new Promise(resolve => setTimeout(resolve, 200));
          window.fetch = original;
          return {sends, draft: st.inputEl.value};
        });
        assert.deepEqual(result, {sends: [{s: 'fold-test-2', text: '待发送草稿'}], draft: '待发送草稿'});
      });

      await t.test('rapid Alt+M sends the draft and shortcut once', async () => {
        const sends = await page.evaluate(async () => {
          const st = paneHistState.get(getFocusedPaneEl());
          const original = window.fetch;
          const payloads = [];
          window.fetch = async (url, init) => {
            if (url !== '/send') return original(url, init);
            payloads.push(JSON.parse(init.body));
            await new Promise(resolve => setTimeout(resolve, 50));
            return Response.json({ok: true});
          };
          st.inputEl.value = '只发送一次';
          await Promise.all([st.triggerAltM(), st.triggerAltM()]);
          await new Promise(resolve => setTimeout(resolve, 200));
          window.fetch = original;
          return payloads;
        });
        assert.deepEqual(sends, [{s: 'fold-test-2', text: '只发送一次'}, {s: 'fold-test-2', raw: '\x1bm'}]);
      });

      await t.test('Alt+M over history cannot send a shortcut into an open Agent menu', async () => {
        const payloads = await page.evaluate(async () => {
          const st = paneHistState.get(getFocusedPaneEl());
          st.data.menuActive = 'Select Model';
          st.searchEl.focus();
          const original = window.fetch;
          const sent = [];
          window.fetch = (url, init) => {
            if (url !== '/send') return original(url, init);
            sent.push(JSON.parse(init.body));
            return Promise.resolve(Response.json({ok: true}));
          };
          try {
            st.searchEl.dispatchEvent(new KeyboardEvent('keydown', {
              bubbles: true, cancelable: true, altKey: true, key: 'm', code: 'KeyM'
            }));
            await new Promise(resolve => setTimeout(resolve, 100));
            return sent;
          } finally {
            st.data.menuActive = '';
            window.fetch = original;
          }
        });
        assert.deepEqual(payloads, []);
      });

      await t.test('holding Alt+M sends one shortcut and keeps an unfocused draft', async () => {
        const result = await page.evaluate(async () => {
          const st = paneHistState.get(getFocusedPaneEl());
          st.searchEl.focus();
          st.inputEl.value = '保留未聚焦的草稿';
          const original = window.fetch;
          const sends = [];
          window.fetch = (url, init) => {
            if (url !== '/send') return original(url, init);
            sends.push(JSON.parse(init.body));
            return Promise.resolve(Response.json({ok: true}));
          };
          try {
            for (const repeat of [false, true]) {
              st.searchEl.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, altKey: true, key: 'm', code: 'KeyM', repeat
              }));
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            return {sends, draft: st.inputEl.value};
          } finally {
            window.fetch = original;
          }
        });
        assert.deepEqual(result, {sends: [{s: 'fold-test-2', raw: '\x1bm'}], draft: '保留未聚焦的草稿'});
      });

      if (process.env.WEBTERM_TEST_SHOTS) {
        await page.evaluate(() => {
          const pane = getFocusedPaneEl();
          applyHistData(pane, {
            sess: pane.dataset.sess, cmd: 'codex', agent: 'codex', runningAgent: 'codex',
            turns: [{index: 1, summary: '怎么查看已折叠的对话？', prompt: '怎么查看已折叠的对话？',
              reply: '点击上方的历史轮次可以展开查看。', lineCount: 3}]
          }, true, false);
        });
        assert.ok(await page.locator('.pane-hist.open .hist-input').isVisible());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({path: path.join(process.env.WEBTERM_TEST_SHOTS, `fold-${width}.png`)});
      }

      await t.test('holding Alt+H toggles the folded panel only once', async () => {
        const states = await page.evaluate(() => {
          const pane = getFocusedPaneEl();
          closeHistoryOverlay(pane);
          return [false, true, true].map(repeat => {
            window.dispatchEvent(new KeyboardEvent('keydown', {
              cancelable: true, altKey: true, key: 'h', code: 'KeyH', repeat
            }));
            return pane.classList.contains('hist-active');
          });
        });
        assert.deepEqual(states, [true, true, true]);
      });

      await t.test('a failed reconnect preserves the loaded history', async () => {
        const visible = await page.evaluate(async () => {
          const pane = getFocusedPaneEl();
          const st = paneHistState.get(pane);
          const data = {sess: st.sess, cmd: 'codex', agent: 'codex', turns: [
            {index: 1, summary: '保留此轮对话', prompt: '保留此轮对话', reply: '重连测试'}
          ]};
          st.searchEl.value = '';
          applyHistData(pane, data, true, false);
          const visible = () => st.listEl.textContent.includes('重连测试');
          const before = visible();
          const original = window.fetch;
          window.fetch = (url, init) => url.startsWith('/history?')
            ? Promise.resolve(new Response('', {status: 503}))
            : original(url, init);
          try {
            await refreshHistPane(pane);
            const during = visible();
            applyHistData(pane, data);
            return [before, during, visible()];
          } finally {
            window.fetch = original;
          }
        });
        assert.deepEqual(visible, [true, true, true]);
      });

      await t.test('terminal retry follows a recreated iframe', async () => {
        const state = await page.evaluate(() => {
          const pane = getFocusedPaneEl();
          const original = pane.querySelector('iframe');
          original.dataset.connectSince = '0';
          updateTerminalConnection(pane);
          dropFrame(pane);
          ensureFrame(pane);
          const staleNotice = !!pane.querySelector('.term-connection:not([hidden])');
          const frame = pane.querySelector('iframe');
          frame.dataset.connectSince = '0';
          updateTerminalConnection(pane);
          pane.querySelector('[data-connect="retry"]').click();
          return {staleNotice, retried: frame.src.includes('&retry='), sameSession: frame.src.includes('arg=fold-test-2')};
        });
        assert.deepEqual(state, {staleNotice: false, retried: true, sameSession: true});
      });

      await t.test('late history response cannot recreate a disposed overlay', async () => {
        const exists = await page.evaluate(async () => {
          const pane = getFocusedPaneEl();
          const original = window.fetch;
          let respond;
          window.fetch = (url, init) => url.startsWith('/history?')
            ? new Promise(resolve => { respond = resolve; })
            : original(url, init);
          const request = refreshHistPane(pane);
          disposeHistOverlay(pane);
          pane.remove();
          respond(Response.json({sess: 'fold-test-2', cmd: 'fish', turns: []}));
          await request;
          window.fetch = original;
          return paneHistState.has(pane);
        });
        assert.equal(exists, false);
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
