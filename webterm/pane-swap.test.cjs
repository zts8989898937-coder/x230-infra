const {chromium}=require('/usr/lib/node_modules/playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});try{
 const context=await browser.newContext({viewport:{width:1440,height:900},hasTouch:true});
 await context.addInitScript(()=>{
  if(!localStorage.getItem('wt_state_v1'))localStorage.setItem('wt_state_v1',JSON.stringify({version:2,seq:1,paneSeq:3,activeId:1,tabs:[{id:1,name:'换位测试',activePaneId:'p1',root:{type:'split',dir:'h',ratio:.45,a:{type:'leaf',id:'p1',sess:'swap-one'},b:{type:'split',dir:'v',ratio:.6,a:{type:'leaf',id:'p2',sess:'swap-two'},b:{type:'leaf',id:'p3',sess:'swap-three'}}}}]}));
  class ES{constructor(){this.readyState=1}addEventListener(){}close(){}}window.EventSource=ES;
 });
 const servedHtml=fs.readFileSync(__dirname+'/index.html','utf8');
 assert.ok(servedHtml.includes('function swapPanePositions'));
 const shotDir='/home/zts/agent-share/工作产出/06-临时中转/2026-11-16/webterm-check';fs.mkdirSync(shotDir,{recursive:true});
 const page=await context.newPage(),errors=[];let frameLoads=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{const u=new URL(r.request().url());
  if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:servedHtml});
  if(u.pathname.startsWith('/tty')){frameLoads++;return r.fulfill({contentType:'text/html',body:'<body>same session</body>'});}
  return r.fulfill({json:u.pathname==='/session-cmds'?{cmds:{},agents:{}}:{pending:true}});
 });
 await page.goto('http://127.0.0.1:3902/');
 await page.evaluate(()=>{const p=paneEls.get('p1');openHistoryOverlay(p);p.querySelector('.hist-input').value='未发送的草稿';window.originalFrame=p.querySelector('iframe');});
 const pane=id=>page.locator('.pane[data-pane-id="'+id+'"]');
 async function drag(from,to){const g=await pane(from).locator('.pane-move').boundingBox(),t=await pane(to).boundingBox();await page.mouse.move(g.x+60,g.y+12);await page.mouse.down();await page.mouse.move(t.x+t.width/2,t.y+t.height/2,{steps:8});}
 await drag('p1','p3');assert.equal(await page.locator('.swap-target').count(),1);await page.screenshot({path:shotDir+'/pane-swap-desktop.png'});await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>listLeaves(active.root).map(l=>l.id)),['p3','p2','p1']);
 assert.equal(await pane('p1').locator('.hist-input').inputValue(),'未发送的草稿');
 assert.equal(await page.evaluate(()=>paneEls.get('p1').querySelector('iframe')===window.originalFrame),true);
 assert.equal(frameLoads,3);console.log('PASS nested pane swap preserves iframe, session and draft');
 assert.deepEqual(await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('wt_state_v1'));return [s.tabs[0].root.ratio,s.tabs[0].root.b.ratio,s.tabs[0].activePaneId]}),[.45,.6,'p1']);console.log('PASS split ratios and focus preserved; swapped layout persisted');
 await drag('p1','p2');await page.keyboard.press('Escape');await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>listLeaves(active.root).map(l=>l.id)),['p3','p2','p1']);
 assert.equal(await page.locator('.swap-target,.swap-source').count(),0);console.log('PASS Escape cancels without changing layout');
 const g=await pane('p1').locator('.pane-move').boundingBox();await page.mouse.move(g.x+30,g.y+12);await page.mouse.down();await page.mouse.move(0,0,{steps:4});await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>listLeaves(active.root).map(l=>l.id)),['p3','p2','p1']);console.log('PASS drop outside panes leaves layout intact');
 await page.reload();assert.deepEqual(await page.evaluate(()=>listLeaves(active.root).map(l=>l.id)),['p3','p2','p1']);console.log('PASS refresh restores swapped layout');
 await page.setViewportSize({width:1024,height:768});
 const client=await context.newCDPSession(page);
 const grip=await pane('p3').locator('.pane-move').boundingBox(),target=await pane('p2').boundingBox();
 await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:grip.x+30,y:grip.y+12}]});
 await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:target.x+target.width/2,y:target.y+target.height/2}]});
 await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.deepEqual(await page.evaluate(()=>listLeaves(active.root).map(l=>l.id)),['p2','p3','p1']);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));console.log('PASS 1024px touch drag swaps panes without page overflow');
 await page.screenshot({path:shotDir+'/pane-swap-touch.png'});
 assert.deepEqual(errors,[]);console.log('PASS no browser errors');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
