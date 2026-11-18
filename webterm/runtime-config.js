function loadConfig(env = process.env) {
  const password = env.WEBTERM_PASS;
  if (!password || !password.trim() || password === '<REDACTED_SEE_SECRETS>') {
    throw new Error('Set WEBTERM_PASS to a private password before starting webterm.');
  }
  return {
    user: env.WEBTERM_USER || 'zts',
    password,
    host: env.WEBTERM_HOST || '127.0.0.1',
  };
}

module.exports = { loadConfig };
