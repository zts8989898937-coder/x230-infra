const { chromium } = require('/usr/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('fs');
(async()=>{
 const browser=await chromium.launch({headless:true}); const failures=[];
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.addInitScript(()=>{
  localStorage.setItem('wt_state_v1',JSON.stringify({version:2,seq:1,paneSeq:1,activeId:1,tabs:[{id:1,name:'检修样例',activePaneId:'p1',root:{type:'leaf',id:'p1',sess:'ui-test'}}]}));
  class ES {constructor(){this.readyState=1}addEventListener(){}close(){this.readyState=2}} window.EventSource=ES;
 });
 const page=await context.newPage();let errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const u=new URL(route.request().url());
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(__dirname+'/index.html','utf8')});
  if(u.pathname.startsWith('/tty'))return route.fulfill({contentType:'text/html',body:'<body></body>'});
  if(u.pathname==='/complete'){await new Promise(r=>setTimeout(r,250));return route.fulfill({json:{items:[{label:'old-path',insert:'/tmp/old-path',kind:'file'}]}})}
  return route.fulfill({json:u.pathname==='/session-cmds'?{cmds:{},agents:{}}:{pending:true}});
 });
 await page.clock.install();
 await page.goto('http://127.0.0.1:3902/');
 await page.evaluate(()=>{const p=getFocusedPaneEl();const s=ensureHistOverlay(p);s.root.classList.add('open');p.classList.add('hist-active');const turns=[1,2,3].map(index=>({index,summary:'问题'+index,prompt:'问题'+index,reply:'答复'+index+'\n'.repeat(2),lineCount:3}));applyHistData(p,{sess:'ui-test',cmd:'agy',agent:'agy',model:'Argon',cwd:'/',turns,totalLines:30},true,false)});
 async function test(name,fn){try{await fn();console.log('PASS',name)}catch(e){failures.push(name);console.log('FAIL',name,e.message)}}
 await test('metadata-only model updates',async()=>{assert.equal(await page.evaluate(()=>{const p=getFocusedPaneEl(),s=paneHistState.get(p);applyHistData(p,{...s.data,model:'Hydrogen'},false,true);return s.data.model}),'Hydrogen')});
 await test('uncertain send never falls back and duplicates',async()=>{assert.deepEqual(await page.evaluate(async()=>{const p=getFocusedPaneEl(),w=p.querySelector('iframe').contentWindow;let calls=0;w.term={paste(){calls++},input(){calls++}};const old=window.fetch;window.fetch=async()=>{throw Error('response lost')};const ok=await submitFromHist(p,'hello');window.fetch=old;return {ok,calls}}),{ok:false,calls:0})});
 await test('old path results cannot overwrite slash suggestions',async()=>{const input=page.locator('.hist-input');await input.fill('/tmp/o');await page.waitForTimeout(90);await input.fill('/model');await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>paneHistState.get(getFocusedPaneEl()).acMode),'slash')});
 await test('old drawer count matches rows',async()=>{await page.locator('.hist-older-toggle').click();const count=await page.locator('.hist-older-row').count();const label=await page.locator('.hist-older-toggle').innerText();assert.ok(label.includes(String(count)+' 轮'),`${label}, rows=${count}`)});
 await test('native menu controls exist and desktop skips the inline arrow buttons',async()=>{
  assert.equal(await page.locator('.hist-live [data-terminal-key="down"]').count(),1);
  assert.equal(await page.locator('.hist-compose [data-terminal-key="down"]').isVisible(),false);
 });
 await test('reopening retains search and selection',async()=>{assert.equal(await page.evaluate(()=>{const p=getFocusedPaneEl(),s=paneHistState.get(p);s.searchEl.value='问题';closeHistoryOverlay(p);openHistoryOverlay(p);return s.searchEl.value}),'问题')});
 await test('slash catalogs stay agent-specific',async()=>{assert.deepEqual(await page.evaluate(()=>({model:buildSlashItems('agy','/model').map(x=>x.label),wrong:buildSlashItems('agy','/sandbox').length,codex:buildSlashItems('codex','/model').map(x=>x.label)})),{model:['/model'],wrong:0,codex:['/model']})});
 await test('slash Enter accepts without sending',async()=>{await page.locator('.hist-input').fill('/mod');await page.locator('.hist-input').press('Enter');assert.match(await page.locator('.hist-input').inputValue(),/^\/model\s*$/)});
 await test('switching agents refreshes an already open slash list',async()=>{await page.locator('.hist-input').fill('/');assert.ok((await page.locator('.hist-ac-list').innerText()).includes('/credits'));await page.evaluate(()=>{const p=getFocusedPaneEl(),st=paneHistState.get(p);applyHistData(p,{...st.data,agent:'codex',cmd:'codex',runningAgent:'codex'},false,false)});assert.ok(!(await page.locator('.hist-ac-list').innerText()).includes('/credits'));assert.ok((await page.locator('.hist-ac-list').innerText()).includes('/review'))});
 await test('unsupported agent never borrows another command list',async()=>{assert.deepEqual(await page.evaluate(()=>buildSlashItems('kimi','/')),[])});
 await test('startup shell prompts are not shown as agent response',async()=>{await page.evaluate(()=>{const p=getFocusedPaneEl(),s=paneHistState.get(p);s.searchEl.value='';applyHistData(p,{sess:'ui-test',cmd:'codex',agent:'codex',turns:[],bannerCaptured:false,preamble:'╭╴ zts at /\n╰─ >\n╭╴ zts at /\n╰─ >',totalLines:4},true,false)});assert.equal(await page.locator('.hist-list').innerText().then(x=>x.includes('╰─')),false)});
 await test('known picker renders as web options without opening raw terminal',async()=>{assert.deepEqual(await page.evaluate(()=>{const s=paneHistState.get(getFocusedPaneEl());s.liveEl.open=false;s.renderNativeMenu({agent:'codex',kind:'model',title:'Select Model',options:[{label:'Sol'},{label:'Astra'}],selected:0,signature:'test'});return {visible:!s.root.querySelector('.hist-native').hidden,options:s.root.querySelectorAll('[data-native-option]').length,rawOpen:s.liveEl.open}}),{visible:true,options:2,rawOpen:false})});
 await test('message draft cannot be submitted into an active picker',async()=>{const fixture={agent:'codex',kind:'model',title:'Select Model',options:[{label:'Sol'},{label:'Astra'}],selected:0,signature:'test'};await page.route('**/screen**',r=>r.fulfill({json:{nativeMenu:fixture,menuActive:'Select Model',text:''}}));await page.evaluate(m=>paneHistState.get(getFocusedPaneEl()).renderNativeMenu(m),fixture);await page.locator('.hist-input').fill('保留草稿');await page.locator('.hist-send').click();assert.equal(await page.locator('.hist-input').inputValue(),'保留草稿');await page.evaluate(()=>paneHistState.get(getFocusedPaneEl()).renderNativeMenu(null));await page.unroute('**/screen**')});
 await test('input keeps terminal monospace font in a split pane',async()=>{assert.ok(await page.evaluate(()=>{const pane=getFocusedPaneEl();const oldWidth=pane.style.width;pane.style.width='650px';const cs=getComputedStyle(pane.querySelector('.hist-input'));const ok=/monospace/.test(cs.fontFamily)&&cs.fontSize==='13px';pane.style.width=oldWidth;return ok}))});
 await test('390px folded view fits the viewport',async()=>{await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await page.locator('.hist-input').boundingBox();assert.ok(box.width>100&&box.x+box.width<=390,JSON.stringify(box))});
 await test('stalled terminal offers retry and folded view without killing the session',async()=>{await page.clock.fastForward(12000);assert.equal(await page.locator('.term-connection:not([hidden])').count(),1);await page.evaluate(()=>closeHistoryOverlay(getFocusedPaneEl()));await page.locator('[data-connect="fold"]').click();assert.equal(await page.locator('.pane.hist-active').count(),1);assert.equal(await page.evaluate(()=>getFocusedPaneEl().dataset.sess),'ui-test')});
 await test('no browser errors',async()=>assert.deepEqual(errors,[]));
 console.log(JSON.stringify({failures}));await browser.close();process.exitCode=failures.length?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
