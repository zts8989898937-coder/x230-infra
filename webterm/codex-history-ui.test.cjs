const {chromium}=require('/usr/lib/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const server=fs.readFileSync(__dirname+'/server.js','utf8'),auth=server.match(/const USER = '([^']+)', PASS = '([^']+)'/);const browser=await chromium.launch({headless:true});try{
const context=await browser.newContext({httpCredentials:{username:auth[1],password:auth[2]}});
await context.addInitScript(()=>{localStorage.setItem('wt_state_v1',JSON.stringify({version:2,seq:1,paneSeq:1,activeId:1,tabs:[{id:1,name:'历史检查',activePaneId:'p1',root:{type:'leaf',id:'p1',sess:'s12-25'}}]}));class ES{addEventListener(){}close(){}}window.EventSource=ES;});
const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await p.route('**/tty/**',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));
await p.goto('http://192.168.8.120:3902/');
const info=await p.evaluate(async()=>{const pane=getFocusedPaneEl(),d=await(await fetch('/history?s=s12-25')).json();const s=ensureHistOverlay(pane);s.root.classList.add('open');pane.classList.add('hist-active');applyHistData(pane,d,true,false);s.showOlder=true;renderHistList(pane);return {source:d.historySource,count:d.turns.length,first:d.turns[0].id,last:d.turns.at(-1).id};});
assert.equal(info.source,'codex-rollout');assert.ok(info.count>=25);
for(const width of [1440,390]){await p.setViewportSize({width,height:900});await p.evaluate(()=>{const s=paneHistState.get(getFocusedPaneEl());s.showOlder=true;renderHistList(getFocusedPaneEl());});assert.equal(await p.locator('.hist-older-row').count(),info.count);assert.match(await p.locator('.hist-older-toggle').innerText(),new RegExp('全部对话 · '+info.count+' 轮'));await p.locator('.hist-older-row').first().click();assert.equal(await p.evaluate(()=>paneHistState.get(getFocusedPaneEl()).selectedKey),info.first);await p.locator('.hist-back-latest').click();assert.equal(await p.evaluate(()=>paneHistState.get(getFocusedPaneEl()).selectedKey),info.last);await p.screenshot({path:'/home/zts/agent-share/工作产出/06-临时中转/2026-11-16/webterm-check/full-codex-history-'+width+'.png'});console.log('PASS real LAN history '+width+'px: '+info.count+' rounds; first/latest selectable');}
assert.deepEqual(errors,[]);console.log('PASS no browser errors');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
