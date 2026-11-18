const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./runtime-config');

test('missing, empty and redacted passwords stop startup without exposing the value', () => {
  for (const value of [undefined, '', '   ', '<REDACTED_SEE_SECRETS>']) {
    assert.throws(() => loadConfig({ WEBTERM_PASS: value }), /^Error: Set WEBTERM_PASS to a private password before starting webterm\.$/);
  }
});

test('configured credentials are used with a loopback default', () => {
  const result = loadConfig({ WEBTERM_PASS: 'test-only-value' });
  assert.equal(result.password, 'test-only-value');
  assert.equal(result.host, '127.0.0.1');
  assert.equal(result.user, 'zts');
});

test('an explicit local interface and username override defaults', () => {
  const result = loadConfig({ WEBTERM_PASS: 'test-only-value', WEBTERM_HOST: '192.0.2.30', WEBTERM_USER: 'example' });
  assert.equal(result.host, '192.0.2.30');
  assert.equal(result.user, 'example');
});
