const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

function exchange(port, route, { method = 'GET', headers = {}, body, upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    if (upgrade) req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

test('webterm authentication, origin checks and file boundaries', { timeout: 20000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'webterm-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push(req.headers);
    res.end('upstream');
  });
  upstream.on('upgrade', (req, socket) => {
    upstreamRequests.push(req.headers);
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const password = crypto.randomBytes(18).toString('hex');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { HOME: home, PATH: process.env.PATH, WEBTERM_USER: 'fixture', WEBTERM_PASS: password,
      WEBTERM_ORIGINS: 'https://terminal.example.test', WEBTERM_PORT: '0', WEBTERM_TTY_PORT: String(upstream.address().port) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  const lines = createInterface({ input: child.stdout });
  const port = await Promise.race([
    once(lines, 'line').then(([line]) => Number(line.match(/^webterm listening on (\d+)$/)?.[1])),
    exited.then(() => { throw new Error('fixture server stopped'); })
  ]);
  assert.ok(port);
  const origin = 'http://127.0.0.1:' + port;
  const basic = { Authorization: 'Basic ' + Buffer.from('fixture:' + password).toString('base64') };
  const initial = await exchange(port, '/', { headers: basic });
  assert.equal(initial.status, 200);
  assert.equal(initial.headers['cache-control'], 'no-store');
  const cookieLine = initial.headers['set-cookie'][0];
  assert.match(cookieLine, /; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(cookieLine, /; Secure/);
  const cookie = { Cookie: cookieLine.split(';')[0] };
  assert.equal((await exchange(port, '/', { headers: cookie })).status, 200);
  assert.equal((await exchange(port, '/', { headers: { Cookie: cookie.Cookie + 'x' } })).status, 401);
  const https = await exchange(port, '/', { headers: { ...basic, Host: 'terminal.example.test', 'X-Forwarded-Proto': 'https' } });
  assert.match(https.headers['set-cookie'][0], /; Secure$/);
  assert.equal((await exchange(port, '/', { headers: { ...basic, Host: 'invalid.example.test' } })).status, 400);

  await t.test('only same-origin authenticated requests can mutate', async () => {
    assert.equal((await exchange(port, '/close?s=fixture', { headers: cookie })).status, 405);
    for (const headers of [cookie, { ...cookie, Origin: 'https://other.example.test' }]) {
      assert.equal((await exchange(port, '/history-poke?s=fixture', { method: 'POST', headers })).status, 403);
    }
    const headers = { ...cookie, Origin: origin };
    assert.equal((await exchange(port, '/history-poke?s=fixture', { method: 'POST', headers })).status, 200);
    assert.equal((await exchange(port, '/send?s=fixture', { method: 'POST', headers, body: '{}' })).status, 415);
  });

  await t.test('only sanctioned ttyd HTTP and WebSocket paths reach the upstream', async () => {
    assert.equal((await exchange(port, '/tty/?arg=fixture', { headers: { ...basic, ...cookie } })).status, 200);
    assert.equal(upstreamRequests.at(-1)['x-auth-user'], 'fixture');
    assert.equal(upstreamRequests.at(-1).authorization, undefined);
    assert.equal(upstreamRequests.at(-1).cookie, undefined);
    assert.equal((await exchange(port, '/tty/unknown', { headers: cookie })).status, 404);
    const headers = { ...cookie, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') };
    assert.equal((await exchange(port, '/tty/ws?arg=fixture', { upgrade: true, headers })).status, 403);
    assert.equal((await exchange(port, '/tty/ws?arg=fixture', { upgrade: true, headers: { ...headers, Origin: origin } })).status, 101);
    assert.equal(upstreamRequests.at(-1).cookie, undefined);
    assert.equal(upstreamRequests.length, 2);
  });

  await t.test('wallpapers and completion stay within their allowed directories', async () => {
    const walls = path.join(home, 'Pictures', 'Wallpapers');
    await fs.mkdir(walls, { recursive: true });
    await fs.writeFile(path.join(walls, 'fixture.png'), 'image');
    await fs.symlink('/dev/null', path.join(walls, 'link.png'));
    await fs.symlink(os.tmpdir(), path.join(home, 'outside'));
    assert.equal((await exchange(port, '/wallpaper/fixture.png', { headers: cookie })).body, 'image');
    assert.equal((await exchange(port, '/wallpaper/link.png', { headers: cookie })).status, 404);
    const listed = await exchange(port, '/wallpapers', { headers: cookie });
    assert.deepEqual(JSON.parse(listed.body), ['fixture.png']);
    const complete = await exchange(port, '/complete?q=out', { headers: cookie });
    assert.deepEqual(JSON.parse(complete.body).items, []);
    assert.equal((await exchange(port, '/complete?q=outside%2F', { headers: cookie })).status, 200);
    assert.deepEqual(JSON.parse((await exchange(port, '/complete?q=outside%2F', { headers: cookie })).body).items, []);
  });

  await t.test('streamed uploads use private files and do not overwrite existing content', async () => {
    const headers = { ...cookie, Origin: origin };
    const first = await exchange(port, '/upload?name=fixture.txt', { method: 'POST', headers, body: 'first' });
    const second = await exchange(port, '/upload?name=fixture.txt', { method: 'POST', headers, body: 'second' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = JSON.parse(first.body).path;
    const b = JSON.parse(second.body).path;
    assert.notEqual(a, b);
    assert.equal(await fs.readFile(a, 'utf8'), 'first');
    assert.equal(await fs.readFile(b, 'utf8'), 'second');
    assert.equal((await fs.stat(a)).mode & 0o777, 0o600);
    const directory = path.dirname(a);
    assert.equal((await exchange(port, '/upload?name=empty.txt', { method: 'POST', headers })).status, 400);
    assert.equal((await exchange(port, '/paste', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/html' }, body: 'fixture' })).status, 415);
    assert.equal((await exchange(port, '/paste', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: 'fixture' })).status, 200);
    assert.equal((await fs.readdir(directory)).length, 2);
  });
});
