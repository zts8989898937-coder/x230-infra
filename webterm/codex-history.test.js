const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {createCodexHistoryReader}=require('./codex-history');
const line=o=>JSON.stringify(o)+'\n';
const msg=(role,text,id)=>({type:'response_item',payload:{type:'message',role,id,content:[{type:role==='user'?'input_text':'output_text',text}]}});
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'wt-history-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const base=path.join(home,'.codex');await fs.mkdir(path.join(base,'sessions'),{recursive:true});const db=new DatabaseSync(path.join(base,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,rollout_path TEXT)');t.after(()=>db.close());const file=path.join(base,'sessions','one.jsonl');db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('thread-one','Test thread','initial prompt','/work',file);await fs.writeFile(file,line({type:'session_meta',payload:{id:'thread-one',cwd:'/work'}})+Array.from({length:25},(_,i)=>line(msg('user','问题'+i,'u'+i))+line(msg('assistant','回复'+i,'a'+i))).join(''));return {home,db,file,read:createCodexHistoryReader({home})};}
test('full native history returns 25 rounds even without terminal scrollback',async t=>{const f=await fixture(t);const out=await f.read('⠙ Test thread | /work','/work');assert.equal(out.turns.length,25);assert.equal(out.threadId,'thread-one');assert.equal(out.turns[0].prompt,'问题0');});
test('wrong directory, unknown or duplicate title never selects an unrelated conversation',async t=>{const f=await fixture(t);assert.equal(await f.read('Test thread | /other','/other'),null);assert.equal(await f.read('Unknown | /work','/work'),null);f.db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('thread-two','Test thread','other','/work',f.file);assert.equal(await f.read('Test thread | /work','/work'),null);});
test('incremental append handles partial JSON, then catches the completed message once',async t=>{const f=await fixture(t);await f.read('Test thread | /work','/work');const next=line(msg('user','追加问题','u26'));await fs.appendFile(f.file,next.slice(0,-5));assert.equal((await f.read('Test thread | /work','/work')).turns.length,25);await fs.appendFile(f.file,next.slice(-5));const out=await f.read('Test thread | /work','/work');assert.equal(out.turns.length,26);assert.equal(out.turns.at(-1).prompt,'追加问题');assert.equal((await f.read('Test thread | /work','/work')).turns.length,26);});
test('file reset reloads rather than mixing old history; mismatched identity is rejected',async t=>{const f=await fixture(t);await f.read('Test thread | /work','/work');await fs.writeFile(f.file,line({type:'session_meta',payload:{id:'wrong',cwd:'/work'}})+line(msg('user','wrong session','new')));assert.equal(await f.read('Test thread | /work','/work'),null);});
test('concurrent polling does not duplicate appended rounds',async t=>{const f=await fixture(t);await f.read('Test thread | /work','/work');await fs.appendFile(f.file,line(msg('user','并发追加','u26')));const results=await Promise.all(Array.from({length:8},()=>f.read('Test thread | /work','/work')));for(const out of results)assert.equal(out.turns.length,26);});
test('rollout paths outside Codex session storage are rejected',async t=>{const f=await fixture(t);const outside=path.join(f.home,'outside.jsonl');await fs.copyFile(f.file,outside);f.db.prepare('UPDATE threads SET rollout_path=?').run(outside);assert.equal(await f.read('Test thread | /work','/work'),null);});

test('folded history retains the final_answer that follows commentary', async t => {
  const f = await fixture(t);
  const read = () => f.read('Test thread | /work', '/work');
  const assistant = (phase, text) => {
    const record = msg('assistant', text);
    record.payload.phase = phase;
    return line(record);
  };
  await fs.appendFile(f.file, line(msg('user', '看看当前有哪些记忆')) +
    assistant('commentary', '我先检查。'));
  assert.equal((await read()).turns.at(-1).reply, '我先检查。');

  await fs.appendFile(f.file, assistant('analysis', '内部分析') +
    assistant('final_answer', '完整回答\n\n- 第一项\n- 第二项'));
  assert.equal((await read()).turns.at(-1).reply, '我先检查。\n\n完整回答\n\n- 第一项\n- 第二项');
});

test('same-title histories use exact visible prompts and reject ambiguous or stale matches', async t => {
  const f = await fixture(t);
  const other = path.join(path.dirname(f.file), 'two.jsonl');
  f.db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)')
    .run('thread-two', 'Test thread', 'other', '/work', other);
  const first = '请保留现有会话，并检查手机窄屏下的对话布局';
  const second = '我需要针对 Safari 浏览器的特点进行针对性的优化';
  const shared = '检查完整记录里是否有重复出现的消息';
  const append = (file, ...prompts) => fs.appendFile(file, prompts.map(prompt => line(msg('user', prompt))).join(''));
  const read = (...prompts) => f.read('Test thread | /work', '/work', prompts.map(prompt => ({ prompt })));

  await append(f.file, first, second);
  await fs.writeFile(other, line({ type: 'session_meta', payload: { id: 'thread-two', cwd: '/work' } }));
  await append(other, shared, second, shared);
  assert.equal((await read(first, second.replace('的优化', '的\n优化')))?.threadId, 'thread-one');
  assert.equal((await read(shared))?.threadId, 'thread-two');
  assert.equal(await read(second), null);
  assert.equal(await read(second, first), null);
  assert.equal(await read('继续'), null);
  assert.equal(await read(first), null);
  await append(other, first, second);
  assert.equal(await read(first, second), null);
  await fs.unlink(other);
  assert.equal(await read(first, second), null);
});

test('a unique title cannot override conflicting visible prompts', async t => {
  const f = await fixture(t);
  assert.equal(await f.read('Test thread | /work', '/work', [
    { prompt: 'A visible question from a different terminal' }
  ]), null);
});

test('oversized rollout files fall back without being loaded', async t => {
  const f = await fixture(t);
  await fs.truncate(f.file, 64 * 1024 * 1024 + 1);
  assert.equal(await f.read('Test thread | /work', '/work'), null);
});
