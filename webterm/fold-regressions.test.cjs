const {chromium, devices} = require('/usr/lib/node_modules/playwright');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync(process.env.WEBTERM_TEST_INDEX || __dirname + '/index.html', 'utf8');

test('folded conversation regressions on desktop LAN and mobile HTTPS', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const mobile of [false, true]) await t.test(mobile ? '390px HTTPS touch' : '1440px LAN desktop', async t => {
    const context = await browser.newContext({
      ...(mobile ? devices['iPhone 13'] : {}),
      viewport: {width:mobile ? 390 : 1440, height:900}
    });
    const errors = [];
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    await context.addInitScript(() => {
      localStorage.setItem('wt_state_v1', JSON.stringify({version:2, seq:1, paneSeq:1, activeId:1, tabs:[
        {id:1, name:'fixture', activePaneId:'p1', root:{type:'leaf', id:'p1', sess:'fixture'}}
      ]}));
      window.testConnection = new EventTarget();
      testConnection.effectiveType = '4g';
      Object.defineProperty(navigator, 'connection', {value:testConnection});
      window.streams = [];
      window.EventSource = class extends EventTarget {
        constructor() { super(); this.readyState = 1; streams.push(this); }
        close() { this.readyState = 2; }
        emit(type, data) { this.dispatchEvent(new MessageEvent(type, {data:JSON.stringify(data)})); }
      };
    });
    await page.route('**/*', route => {
      const {pathname} = new URL(route.request().url());
      if (pathname === '/') return route.fulfill({contentType:'text/html', body:html});
      if (pathname.startsWith('/tty')) return route.fulfill({contentType:'text/html', body:'<body></body>'});
      return route.fulfill({json:pathname === '/history' ? {pending:true} : {}});
    });
    await page.goto(mobile ? 'https://fold-fixture.invalid/' : 'http://127.0.0.1:3902/');
    await page.evaluate(() => {
      window.pane = getFocusedPaneEl();
      window.st = ensureHistOverlay(pane);
      pane.classList.add('hist-active');
      st.root.classList.add('open');
      clearInterval(st.liveTimer);
      window.refreshLive = st.refreshLive;
      st.refreshLive = () => {};
      window.turn = (reply, id = 'one') => ({index:1, id, prompt:'question', summary:'question', reply, lineCount:reply.split('\n').length});
      window.snapshot = (digest, reply) => ({sess:'fixture', cmd:'codex', agent:'codex', digest, turns:[turn(reply)]});
      window.frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      openHistStream(pane);
    });

    const run = (name, fn) => t.test(name, () => page.evaluate(fn));
    await run('rejects a tail against a different snapshot and reconnects', async () => {
      const es = st.es;
      es.emit('hist', snapshot('a','original')); await frame();
      es.emit('hist-tail', {baseDigest:'missing', digest:'c', turnCount:1, turn:turn('unexpected')});
      await frame();
      if (st.data.digest !== 'a' || st.es === es) throw Error('incorrect tail applied or stream not reset');
    });

    await run('receives chained tails while a selection holds the rendered snapshot', async () => {
      openHistStream(pane);
      const es = st.es;
      es.emit('hist', snapshot('a','original')); await frame();
      const sel = getSelection(), range = document.createRange();
      range.selectNodeContents(st.listEl.querySelector('.hist-reply'));
      sel.removeAllRanges(); sel.addRange(range);
      es.emit('hist-tail', {baseDigest:'a', digest:'b', turnCount:1, turn:turn('held')});
      await frame();
      const updated = {index:1, id:'replacement', prompt:'new prompt', summary:'new prompt', reply:'latest'};
      es.emit('hist-tail', {baseDigest:'b', digest:'c', turnCount:1, turn:updated});
      await frame();
      if (st.data.digest !== 'a') throw Error('render changed during selection');
      sel.removeAllRanges();
      await frame();
      if (st.data.digest !== 'c' || st.data.turns[0].id !== 'replacement') throw Error('latest data missing after selection');
    });

    await run('a reply updates when its Braille text changes', async () => {
      openHistStream(pane);
      st.es.emit('hist', snapshot('braille-1', 'Braille ⠁')); await frame();
      st.es.emit('hist', snapshot('braille-2', 'Braille ⠂')); await frame();
      if (!st.listEl.querySelector('.hist-reply').textContent.includes('⠂')) throw Error('Braille update was lost');
    });

    await run('pager preview updates an older line when its tail stays the same', () => {
      const rest = Array.from({length:35}, (_, i) => 'unchanged line ' + i + ' '.repeat(45)).join('\n');
      try {
        st.data.menuActive = 'Pager';
        st.renderNativeMenu(null, 'before\n' + rest, 'q');
        st.renderNativeMenu(null, 'after\n' + rest, 'q');
        if (!st.root.querySelector('.hist-native-preview').textContent.startsWith('after')) throw Error('pager lost updated rows');
      } finally { st.data.menuActive = ''; st.renderNativeMenu(null); }
    });

    await run('autocomplete Enter cannot confirm a CLI picker', async () => {
      let sends = 0;
      const orig = window.fetch;
      window.fetch = (url, init) => {
        if (url.startsWith('/screen?')) return Promise.resolve(Response.json({text:'menu', nativeMenu:st.nativeMenu}));
        if (url === '/send') { sends++; return Promise.resolve(Response.json({ok:true})); }
        return orig(url, init);
      };
      try {
        st.renderNativeMenu({agent:'codex', title:'Select Model', options:[{label:'Sol'}], selected:0, signature:'menu'});
        st.inputEl.value = '/mo';
        st.inputEl.setSelectionRange(3,3);
        st.inputEl.dispatchEvent(new Event('input'));
        st.inputEl.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
        await frame();
        if (sends || st.inputEl.value === '/mo') throw Error('menu stole autocomplete Enter');
      } finally { window.fetch = orig; st.renderNativeMenu(null); }
    });

    await run('a pager key uses current terminal state before sending', async () => {
      st.data.menuActive = 'Pager';
      st.renderNativeMenu(null, 'Pager', 'q');
      let sent = false;
      const orig = window.fetch;
      window.fetch = (url, init) => {
        if (url.startsWith('/screen?')) return Promise.resolve(Response.json({text:'prompt', menuActive:''}));
        if (url === '/send') { sent = true; return Promise.resolve(Response.json({ok:true})); }
        return orig(url, init);
      };
      try {
        st.root.querySelector('[data-native-raw-key="q"]').click();
        await new Promise(resolve => setTimeout(resolve, 260));
        if (sent) throw Error('sent q to a terminal that already left the pager');
      } finally { window.fetch = orig; st.data.menuActive = ''; st.renderNativeMenu(null); }
    });

    await run('a stale fallback menu hides after verification', async () => {
      const olderRefresh = st.refreshLive;
      if (!olderRefresh) throw Error('missing refresh');
      const orig = window.fetch;
      const waiters = [];
      window.fetch = (url, init) => url.startsWith('/screen?')
        ? new Promise(resolve => waiters.push(resolve)) : orig(url, init);
      try {
        st.data.menuActive = 'Pager';
        st.renderNativeMenu(null, 'Pager', 'q');
        st.root.querySelector('[data-native-raw-key="q"]').click();
        await frame();
        if (waiters.length !== 1) throw Error('screen was not verified before key submission');
        waiters[0](Response.json({text:'prompt', menuActive:''}));
        await frame();
        if (!st.root.querySelector('.hist-native').hidden) throw Error('menu remained visible');
      } finally { window.fetch = orig; st.data.menuActive = ''; st.renderNativeMenu(null); }
    });

    await run('an older screen response cannot reopen a menu cleared by a newer verification', async () => {
      const orig = window.fetch;
      const waiters = [];
      window.fetch = (url, init) => url.startsWith('/screen?')
        ? new Promise(resolve => waiters.push(resolve)) : orig(url, init);
      try {
        st.refreshLive = refreshLive;
        st.data.menuActive = 'Pager';
        st.renderNativeMenu(null, 'Pager', 'q');
        const old = st.refreshLive(true);
        st.root.querySelector('[data-native-raw-key="q"]').click();
        await frame();
        if (waiters.length !== 2) throw Error('missing verification request');
        waiters[1](Response.json({text:'prompt', menuActive:''}));
        await frame();
        waiters[0](Response.json({text:'pager', menuActive:'Pager', menuCloseKey:'q'}));
        await old;
        if (!st.root.querySelector('.hist-native').hidden) throw Error('old response reopened menu');
      } finally { window.fetch = orig; st.refreshLive = () => {}; st.data.menuActive = ''; st.renderNativeMenu(null); }
    });

    await run('a transient network hint does not replace a healthy history connection', () => {
      openHistStream(pane);
      const es = st.es;
      const now = Date.now;
      try {
        testConnection.effectiveType = '3g';
        testConnection.dispatchEvent(new Event('change'));
        syncHistStreams();
        if (st.es !== es) throw Error('SSE reconnected on a single hint');
        Date.now = () => now() + 4500;
        syncHistStreams();
        if (st.es === es) throw Error('SSE ignored sustained slow link');
      } finally {
        Date.now = now;
        testConnection.effectiveType = '4g';
        testConnection.dispatchEvent(new Event('change'));
      }
    });

    await run('dismissed command output can reappear after it leaves the screen', () => {
      st.renderSlashOutput('same', '\x1b[31msame');
      st.slashOutEl.querySelector('button').click();
      st.renderSlashOutput('');
      st.renderSlashOutput('same', '\x1b[32msame');
      if (st.slashOutEl.hidden) throw Error('identical new command output stayed dismissed');
    });

    if (mobile) await run('a canceled touch gesture on Copy keeps the selection', async () => {
      const sel = getSelection(), range = document.createRange();
      range.selectNodeContents(st.listEl.querySelector('.hist-reply'));
      sel.removeAllRanges(); sel.addRange(range);
      await new Promise(resolve => setTimeout(resolve, 150));
      const button = st.selPopEl.querySelector('[data-sel="copy"]');
      const touch = new Touch({identifier:1, target:button, clientX:100, clientY:100});
      button.dispatchEvent(new TouchEvent('touchstart', {bubbles:true, cancelable:true, touches:[touch], changedTouches:[touch]}));
      button.dispatchEvent(new TouchEvent('touchcancel', {bubbles:true, cancelable:true, changedTouches:[touch]}));
      if (sel.isCollapsed || !st.pendingSel) throw Error('copy was executed at touchstart');
      sel.removeAllRanges();
    });

    await run('copy fallback cleans up and keeps compose focus when copying throws', () => {
      st.inputEl.focus();
      const initialCount = document.querySelectorAll('textarea').length;
      const original = document.execCommand;
      document.execCommand = () => { throw Error('unsupported'); };
      try {
        if (copyViaTextarea('fixture')) throw Error('copy incorrectly reported success');
        if (document.querySelectorAll('textarea').length !== initialCount || document.activeElement !== st.inputEl) {
          throw Error('fallback leaked textarea or lost compose focus');
        }
      } finally { document.execCommand = original; }
    });

    await run('upward input immediately pauses and exposes the jump button', () => {
      applyHistData(pane, snapshot('scroll', Array.from({length:110}, (_, i) => 'reply ' + i).join('\n')), true, false);
      st.listEl.dispatchEvent(new WheelEvent('wheel', {deltaY:-120}));
      if (st.stickToBottom || st.jumpEl.hidden) throw Error('upward intent did not update controls');
    });

    await run('an identical prompt in a new thread does not inherit long-reply expansion', () => {
      const long = Array.from({length:130}, (_, i) => 'line ' + i).join('\n');
      const a = {...snapshot('one','short'), historySource:'codex-rollout', threadId:'first'};
      const b = {...snapshot('two', long), historySource:'codex-rollout', threadId:'second'};
      applyHistData(pane, a, true, false);
      applyHistData(pane, b, false, false);
      if (st.openLongTurns.size) throw Error('new thread inherited an older expansion');
    });

    if (mobile) await run('keyboard viewport leaves the compose controls on screen with a long menu', async () => {
      const vv = window.visualViewport;
      Object.defineProperty(vv, 'height', {configurable:true, value:320});
      Object.defineProperty(vv, 'scale', {configurable:true, value:1});
      st.inputEl.focus();
      st.renderNativeMenu({agent:'codex', title:'Select Model', options:Array.from({length:30}, (_, i) => ({label:'Model '+ i})), selected:0, signature:'long-menu'});
      vv.dispatchEvent(new Event('resize'));
      try {
        await frame();
        if (st.inputEl.getBoundingClientRect().bottom > document.getElementById('app').getBoundingClientRect().bottom) {
          throw Error('compose clipped by long menu after keyboard resize: ' + JSON.stringify([st.inputEl.getBoundingClientRect().bottom, document.getElementById('app').getBoundingClientRect().bottom, st.root.clientHeight, st.root.querySelector('.hist-native').offsetHeight]));
        }
      } finally {
        delete vv.height; delete vv.scale; vv.dispatchEvent(new Event('resize'));
        st.renderNativeMenu(null);
      }
    });

    await run('unrelated history metadata does not acknowledge a pending send', () => {
      st.pendingSendEl.hidden = false;
      st.pendingSendTxtEl.textContent = 'waiting';
      applyHistData(pane, {...st.data, model:'new model'}, false, false);
      if (st.pendingSendEl.hidden) throw Error('metadata dismissed pending message');
      st.pendingSendEl.hidden = true;
    });
  });
});
