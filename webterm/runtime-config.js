const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readPrivateConfig(home = os.homedir()) {
  const file = path.join(home, '.config', 'secrets', 'webterm.json');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 8192) {
      throw new Error('unsafe config');
    }
    const config = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config');
    return config;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error('Check the private webterm configuration and its permissions.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function loadConfig(env = process.env, local = {}) {
  const password = env.WEBTERM_PASS || local.password;
  if (typeof password !== 'string' || !password.trim() || password === '<REDACTED_SEE_SECRETS>') {
    throw new Error('Set WEBTERM_PASS to a private password before starting webterm.');
  }
  const user = env.WEBTERM_USER || local.user || 'zts';
  if (typeof user !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(user)) throw new Error('Invalid WEBTERM_USER.');
  return {
    user,
    password,
    host: env.WEBTERM_HOST || local.host || '127.0.0.1',
  };
}

module.exports = { loadConfig, readPrivateConfig };
