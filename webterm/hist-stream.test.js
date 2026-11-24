const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { validSession } = require('./request-policy');

test('HTTP history stream binds tails to the delivered revision and resends edited earlier turns', {timeout:5000}, async t => {
  const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const digest = source.slice(source.indexOf('function stableHistoryDigest'), source.indexOf('function handleHistory('));
  const watcher = source.slice(source.indexOf('const sessionWatchers'), source.indexOf('function readStr', source.indexOf('const sessionWatchers')));
  let history = {sess:'fixture', turns:[{index:1, summary:'first', lineCount:1, reply:'aaa'}, {index:2, summary:'last', lineCount:1, reply:'xxx'}]};
  const {handleHistoryStream, poke} = vm.runInNewContext(digest + watcher + '\n({handleHistoryStream, poke: () => sessionWatchers.get("fixture").poke()})', {
    URL, crypto, validSession, setInterval, clearInterval, setTimeout, clearTimeout,
    captureSessionHistory: (_sess, done) => setImmediate(() => done(null, structuredClone(history)))
  });
  const server = http.createServer(handleHistoryStream);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pending = [];
  const abort = new AbortController();
  t.after(() => { abort.abort(); server.closeAllConnections(); server.close(); });
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/?s=fixture&delta=1&net=wan', {signal:abort.signal});
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async () => {
    while (!pending.length) {
      const {value, done} = await reader.read();
      assert.equal(done, false);
      buffer += decoder.decode(value, {stream:true});
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const match = frame.match(/^event: (hist(?:-tail)?)\ndata: (.+)$/);
        if (match) pending.push({event:match[1], data:JSON.parse(match[2])});
      }
    }
    return pending.shift();
  };
  const original = await next();
  assert.equal(original.event, 'hist');
  history.turns[1].reply = 'yyy';
  poke();
  const tail = await next();
  assert.equal(tail.event, 'hist-tail');
  await t.test('delta names the prior digest', () => assert.equal(tail.data.baseDigest, original.data.digest));

  history.turns[0].reply = 'bbb';
  history.turns[1].reply = 'zzz';
  poke();
  const changed = await next();
  await t.test('same-length correction in an earlier reply forces a full frame', () => {
    assert.equal(changed.event, 'hist');
    assert.equal(changed.data.turns[0].reply, 'bbb');
  });
});

test('history digests preserve Braille in a reply', () => {
  const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const code = source.slice(source.indexOf('function stableHistoryDigest'), source.indexOf('function handleHistory('));
  const digest = vm.runInNewContext(code + '\nstableHistoryDigest', {crypto});
  assert.notEqual(digest({turns:[{reply:'Braille ⠁'}]}), digest({turns:[{reply:'Braille ⠂'}]}));
});

test('slow stream coalesces pending updates while its socket is backed up', async t => {
  const {EventEmitter} = require('node:events');
  const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const digest = source.slice(source.indexOf('function stableHistoryDigest'), source.indexOf('function handleHistory('));
  const watcher = source.slice(source.indexOf('const sessionWatchers'), source.indexOf('function readStr'));
  let reply = 'initial';
  const {handleHistoryStream, poke} = vm.runInNewContext(digest + watcher + '\n({handleHistoryStream, poke: () => sessionWatchers.get("fixture").poke()})', {
    URL, crypto, validSession, setInterval, clearInterval, setTimeout, clearTimeout,
    captureSessionHistory: (_sess, done) => setImmediate(() => done(null, {turns:[{index:1, reply}]}))
  });
  const req = Object.assign(new EventEmitter(), {url:'/?s=fixture&delta=1&net=slow', headers:{}});
  const frames = [];
  const res = Object.assign(new EventEmitter(), {
    writableNeedDrain:false,
    writeHead() {},
    write(frame) {
      frames.push(frame);
      if (frame.startsWith('event: hist')) this.writableNeedDrain = true;
      return !this.writableNeedDrain;
    }
  });
  t.after(() => res.emit('close'));
  handleHistoryStream(req, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.filter(s => s.startsWith('event: hist')).length, 1);
  reply = 'middle'; poke();
  await new Promise(resolve => setImmediate(resolve));
  reply = 'latest'; poke();
  await new Promise(resolve => setTimeout(resolve, 480));
  assert.equal(frames.filter(s => s.startsWith('event: hist')).length, 1);
  res.writableNeedDrain = false;
  res.emit('drain');
  assert.equal(frames.filter(s => s.startsWith('event: hist')).length, 2);
  assert.match(frames.at(-1), /latest/);
});

test('a slow-only watcher uses the slow sampling interval', async t => {
  const {EventEmitter} = require('node:events');
  const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const digest = source.slice(source.indexOf('function stableHistoryDigest'), source.indexOf('function handleHistory('));
  const watcher = source.slice(source.indexOf('const sessionWatchers'), source.indexOf('function readStr'));
  const delays = [];
  const handle = vm.runInNewContext(digest + watcher + '\nhandleHistoryStream', {
    URL, crypto, validSession, setInterval, clearInterval, clearTimeout,
    setTimeout: (_fn, delay) => delays.push(delay),
    captureSessionHistory: (_sess, done) => setImmediate(() => done(null, {turns:[{reply:'fixture'}]}))
  });
  const req = Object.assign(new EventEmitter(), {url:'/?s=fixture&net=slow', headers:{}});
  const res = Object.assign(new EventEmitter(), {writeHead() {}, write() {}});
  t.after(() => res.emit('close'));
  handle(req, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delays, [450]);
});
