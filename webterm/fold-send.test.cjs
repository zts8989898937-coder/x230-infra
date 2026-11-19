const { chromium } = require('/usr/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const parser = require('./history-parser');
(async () => {
 const browser = await chromium.launch({headless:true});
 const failures = [], errors = [];
 for (const width of [1440,390]) {
  const context = await browser.newContext({viewport:{width,height:900}});
  await context.addInitScript(() => {
   localStorage.setItem('wt_state_v1',JSON.stringify({version:2,seq:1,paneSeq:1,activeId:1,tabs:[{id:1,name:'发送回归',activePaneId:'p1',root:{type:'leaf',id:'p1',sess:'send-regression'}}]}));
   window.EventSource=class {constructor(){this.readyState=1}addEventListener(){}close(){}};
  });
  const page = await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  let posts=[],screen={text:'Ready for next message',nativeMenu:null,menuActive:''},screenFailure=false;
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(__dirname+'/index.html','utf8')});
   if(u.pathname.startsWith('/tty'))return route.fulfill({contentType:'text/html',body:'<body></body>'});
   if(u.pathname==='/screen')return route.fulfill(screenFailure?{status:503,json:{error:'unavailable'}}:{json:screen});
   if(u.pathname==='/send'){posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}})}
   return route.fulfill({json:u.pathname==='/session-cmds'?{cmds:{},agents:{}}:{pending:true}});
  });
  await page.goto('http://127.0.0.1:3902/');
  await page.evaluate(()=>{const p=getFocusedPaneEl(),s=ensureHistOverlay(p);s.root.classList.add('open');p.classList.add('hist-active');applyHistData(p,{sess:'send-regression',agent:'codex',cmd:'codex',turns:[],menuActive:''},true,false);clearInterval(s.liveTimer)});
  const menu={agent:'codex',kind:'model',title:'Select Model',options:[{label:'Sol'}],selected:0,signature:'menu'};
  async function seed(){await page.evaluate(m=>{const s=paneHistState.get(getFocusedPaneEl());s.data.menuActive='Select Model';s.renderNativeMenu(m);s.liveBusy=false},menu);await page.locator('.hist-input').fill('退出菜单后的消息')}
  async function check(name,fn){try{await fn();console.log('PASS',width,name)}catch(e){failures.push(width+' '+name);console.log('FAIL',width,name,e.message)}}
  await check('stale menu cannot permanently block sending',async()=>{await seed();await page.locator('.hist-send').click();await page.waitForTimeout(180);assert.equal(posts.length,1);assert.equal(posts[0].text,'退出菜单后的消息');assert.equal(await page.locator('.hist-input').inputValue(),'')});
  for (const agent of ['codex', 'agy']) {
   await check(agent + ' residual terminal menu cannot block sending', async () => {
    const text = agent === 'codex'
     ? 'Select Model\n› 1. Sol (current)\n  2. Astra\nenter select · esc back\n› 继续处理\n'
     : 'Switch Model\n> Gemini Argon (current)\n  Gemini Hydrogen\nKeyboard: ↑/↓ Navigate enter Select esc Go Back\n────────────────────\n> 继续处理\n────────────────────\n';
    screen = {text, nativeMenu:parser.parseNativeMenu(text, agent), menuActive:parser.parseTerminalHistory(text, agent).menuActive};
    posts=[]; await seed(); await page.locator('.hist-send').click();
    await page.waitForTimeout(180);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].text, '退出菜单后的消息');
    assert.equal(await page.locator('.hist-input').inputValue(), '');
   });
  }
  posts=[];screen={text:'Select Model',nativeMenu:menu,menuActive:'Select Model'};
  await check('active menu keeps draft and receives no message',async()=>{await seed();await page.locator('.hist-send').click();await page.waitForTimeout(120);assert.equal(posts.length,0);assert.equal(await page.locator('.hist-input').inputValue(),'退出菜单后的消息')});
  await check('Enter in compose confirms active agy picker and preserves draft',async()=>{
   const agyMenu={...menu,agent:'agy',title:'Switch Model',signature:'agy-menu'};
   screen={text:'Switch Model',nativeMenu:agyMenu,menuActive:'Switch Model'};posts=[];
   await page.evaluate(m=>{const s=paneHistState.get(getFocusedPaneEl());s.data.menuActive='Switch Model';s.renderNativeMenu(m)},agyMenu);
   await page.locator('.hist-input').fill('保留此草稿');await page.locator('.hist-input').press('Enter');
   await page.waitForTimeout(350);assert.equal(posts.length,1);assert.equal(posts[0].raw,'\r');assert.equal(posts[0].text,undefined);
   assert.equal(await page.locator('.hist-input').inputValue(),'保留此草稿');
  });
  await check('Enter on focused option confirms instead of selecting it again',async()=>{
   posts=[];await page.locator('[data-native-option="0"]').focus();await page.keyboard.press('Enter');
   await page.waitForTimeout(350);assert.equal(posts.length,1);assert.equal(posts[0].raw,'\r');
  });
  await check('Enter on another focused option selects it without confirming the old model',async()=>{
   const m={...menu,agent:'agy',title:'Switch Model',options:[{label:'First'},{label:'Second'}],selected:0,signature:'two-options'};
   screen={text:'Switch Model',nativeMenu:m,menuActive:'Switch Model'};posts=[];
   await page.evaluate(m=>paneHistState.get(getFocusedPaneEl()).renderNativeMenu(m),m);
   await page.locator('[data-native-option="1"]').focus();await page.keyboard.press('Enter');
   await page.waitForTimeout(350);assert.equal(posts.length,1);assert.equal(posts[0].raw,'\x1b[B');
  });
  screen={text:'Select Model',nativeMenu:menu,menuActive:'Select Model'};
  posts=[];screenFailure=true;
  await check('failed menu verification preserves draft',async()=>{await seed();await page.locator('.hist-send').click();await page.waitForTimeout(120);assert.equal(posts.length,0);assert.equal(await page.locator('.hist-input').inputValue(),'退出菜单后的消息');assert.equal(await page.locator('.hist-send').isEnabled(),true)});
  await check('Enter does not confirm when picker verification fails',async()=>{
   posts=[];await seed();await page.locator('.hist-input').press('Enter');
   await page.waitForTimeout(120);assert.equal(posts.length,0);
   assert.equal(await page.locator('.hist-input').inputValue(),'退出菜单后的消息');
  });
  screenFailure=false;screen={text:'Ready',nativeMenu:null,menuActive:''};posts=[];
  await check('rapid clicks during menu verification send once',async()=>{await seed();await page.evaluate(()=>{const b=document.querySelector('.hist-send');b.click();b.click()});await page.waitForTimeout(180);assert.equal(posts.length,1)});
  posts=[];
  await check('normal Enter sends without a menu',async()=>{await page.evaluate(()=>{const s=paneHistState.get(getFocusedPaneEl());s.data.menuActive='';s.renderNativeMenu(null)});await page.locator('.hist-input').fill('普通回车发送测试');await page.locator('.hist-input').press('Enter');await page.waitForTimeout(120);assert.equal(posts.length,1);assert.equal(posts[0].text,'普通回车发送测试')});
  await check('live refresh clears obsolete fallback heading',async()=>{await seed();await page.evaluate(()=>paneHistState.get(getFocusedPaneEl()).refreshLive());assert.equal(await page.locator('.hist-native').isVisible(),false);assert.equal(await page.evaluate(()=>paneHistState.get(getFocusedPaneEl()).data.menuActive),'')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/home/zts/agent-share/工作产出/06-临时中转/2026-11-17/fold-send-fix/'+width+'.png'});
  await context.close();
 }
 assert.deepEqual(errors,[]);await browser.close();console.log(JSON.stringify({failures,browserErrors:errors}));process.exitCode=failures.length?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
