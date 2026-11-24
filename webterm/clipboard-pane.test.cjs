const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {chromium} = require('/usr/lib/node_modules/playwright');
const {test} = require('node:test');

test('clipboard image stays with the pane active when paste starts', async () => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {value: {
        read: () => new Promise(resolve => {
          window.completeClipboardRead = () => resolve([{
            types: ['image/png'],
            getType: async () => new Blob(['test'], {type: 'image/png'}),
          }]);
        }),
      }});
      localStorage.setItem('wt_state_v1', JSON.stringify({
        version: 2, seq: 1, paneSeq: 2, activeId: 1,
        tabs: [{id: 1, name: '验收', activePaneId: 'p1', root: {
          type: 'split', dir: 'h', ratio: 0.5,
          a: {type: 'leaf', id: 'p1', sess: 'paste-origin'},
          b: {type: 'leaf', id: 'p2', sess: 'paste-other'},
        }}],
      }));
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.pathname === '/'
        ? route.fulfill({contentType: 'text/html', body: html})
        : route.fulfill({json: {}});
    });
    await page.goto('http://127.0.0.1:3902/');
    const target = await page.evaluate(async () => {
      const uploaded = [];
      upload = async (_blob, pane) => { uploaded.push(pane.dataset.sess); };
      const pending = pasteFromClipboard();
      setPaneFocus('p2', false);
      if (active.activePaneId !== 'p2') throw Error('the pane switch did not take effect');
      completeClipboardRead();
      await pending;
      return uploaded;
    });
    assert.deepEqual(target, ['paste-origin']);
  } finally {
    await browser.close();
  }
});
