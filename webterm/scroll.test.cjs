const {chromium}=require('/usr/lib/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const context=await browser.newContext({viewport:{width:1440,height:900},hasTouch:true});
 await context.addInitScript(()=>{localStorage.setItem('wt_state_v1',JSON.stringify({version:2,seq:1,paneSeq:2,activeId:1,tabs:[{id:1,name:'滚动检查',activePaneId:'p1',root:{type:'split',dir:'h',ratio:.5,a:{type:'leaf',id:'p1',sess:'scroll-check'},b:{type:'leaf',id:'p2',sess:'unused'}}}]}));class ES{constructor(){this.readyState=1}addEventListener(){}close(){}}window.EventSource=ES;});
 const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await p.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:fs.readFileSync(__dirname+'/index.html','utf8')});if(u.pathname.startsWith('/tty'))return r.fulfill({contentType:'text/html',body:'<body></body>'});return r.fulfill({json:u.pathname==='/session-cmds'?{cmds:{},agents:{}}:{pending:true}})});
 await p.goto('http://127.0.0.1:3902/');
 await p.evaluate(()=>{const pane=getFocusedPaneEl();const s=ensureHistOverlay(pane);s.root.classList.add('open');pane.classList.add('hist-active');const turns=Array.from({length:15},(_,i)=>({index:i+1,summary:'检查问题'+i,prompt:'检查问题'+i,reply:Array.from({length:100},(_,j)=>'这是 Codex 的回复，第 '+j+' 行。').join('\n'),lineCount:102}));applyHistData(pane,{sess:'scroll-check',cmd:'codex',agent:'codex',model:'test',turns,totalLines:1530},true,false)});
 async function metrics(){return p.evaluate(()=>{const s=paneHistState.get(getFocusedPaneEl());return {height:s.listEl.clientHeight,total:s.listEl.scrollHeight,top:s.listEl.scrollTop,follow:s.stickToBottom}})}
 async function wheelUp(){const r=await p.locator('.pane[data-pane-id=p1] .hist-list').boundingBox();await p.mouse.move(r.x+r.width/2,r.y+r.height/2);await p.mouse.wheel(0,-240);await p.waitForTimeout(180);}
 for(const [width,height,dir,older,live] of [[1440,900,'h',false,false],[1440,900,'v',true,false],[390,844,'v',true,false],[1440,900,'v',true,true]]){
  await p.setViewportSize({width,height});await p.evaluate(({dir,older,live})=>{active.root.dir=dir;applyLayout();const s=paneHistState.get(getFocusedPaneEl());s.showOlder=older;renderHistList(getFocusedPaneEl());s.liveEl.open=live;s.listEl.scrollTop=s.listEl.scrollHeight;},{dir,older,live});await p.waitForTimeout(100);
  const opened=await metrics();assert.ok(opened.height>=100,'history drawer must not squeeze reply');await p.evaluate(()=>{const s=paneHistState.get(getFocusedPaneEl());s.showOlder=false;renderHistList(getFocusedPaneEl());});await p.waitForTimeout(80);const before=await metrics();await wheelUp();const after=await metrics();console.log(JSON.stringify({width,height,dir,older,live,before,after}));
  await p.screenshot({path:'/home/zts/agent-share/工作产出/06-临时中转/2026-11-16/webterm-check/codex-scroll-'+width+'-'+dir+'-'+live+'.png'});assert.ok(before.height>=70,'reply scroll area must remain usable');assert.ok(after.top<before.top,'wheel must scroll reply upward');
 }

 await p.setViewportSize({width:1440,height:900});await p.evaluate(()=>{active.root.dir='h';applyLayout();const s=paneHistState.get(getFocusedPaneEl());s.liveEl.open=false;s.showOlder=true;renderHistList(getFocusedPaneEl());});
 await p.locator('.hist-older-row').nth(1).click();await p.waitForTimeout(150);
 assert.equal(await p.evaluate(()=>paneHistState.get(getFocusedPaneEl()).followLatest),false);
 assert.equal((await metrics()).top,0,'historical turn should start at its beginning after resize');
 const historical=await p.evaluate(()=>paneHistState.get(getFocusedPaneEl()).selectedKey);
 await p.evaluate(()=>{const pane=getFocusedPaneEl(),s=paneHistState.get(pane),turns=s.data.turns.map(t=>({...t}));turns[turns.length-1].reply+='\n新生成的一行';applyHistData(pane,{...s.data,turns},false,true);});await p.waitForTimeout(100);
 assert.equal(await p.evaluate(()=>paneHistState.get(getFocusedPaneEl()).selectedKey),historical);assert.equal((await metrics()).top,0);
 console.log('PASS historical turn stays at top and selected while latest reply streams');
 await p.locator('.hist-back-latest').click();await p.waitForTimeout(100);
 assert.equal((await metrics()).follow,true);await wheelUp();const paused=await metrics();
 await p.evaluate(()=>{const pane=getFocusedPaneEl(),s=paneHistState.get(pane),turns=s.data.turns.map(t=>({...t}));turns[turns.length-1].reply+='\n下一行生成';applyHistData(pane,{...s.data,turns},false,true);});await p.waitForTimeout(120);
 assert.ok(Math.abs((await metrics()).top-paused.top)<2,'streaming should not pull reader back to bottom');
 await p.locator('.hist-jump').click();await p.waitForTimeout(100);const resumed=await metrics();assert.ok(resumed.total-resumed.top-resumed.height<=2);
 console.log('PASS scrolling up pauses auto-follow; jump resumes latest');
 await p.setViewportSize({width:390,height:844});await p.waitForTimeout(100);
 const box=await p.locator('.pane[data-pane-id=p1] .hist-list').boundingBox(),client=await context.newCDPSession(p);const beforeTouch=await metrics();
 await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+35}]});
 for(let n=1;n<=5;n++){await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width/2,y:box.y+35+n*20}]});await p.waitForTimeout(20);}
 await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(200);
 assert.ok((await metrics()).top<beforeTouch.top,'touch should scroll reply up');console.log('PASS mobile touch scroll');
 assert.deepEqual(errors,[]);console.log('PASS scrolling layouts');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
