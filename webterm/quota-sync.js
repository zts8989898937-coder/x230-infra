#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const { getQuota } = require('./quota');

const REMOTE_PATH = '/www/wwwroot/192.0.2.10/wp-content/sf-private/quota.json';

async function main() {
  const data = await getQuota({ force: true, waitCli: true });

  const payload = JSON.stringify({
    updatedAt: data.updatedAt,
    providers: data.providers,
    vpn: data.vpn,
    usage: data.usage
  });

  const remoteCmd =
    `umask 027 && tmp="${REMOTE_PATH}.tmp.$$" && cat > "$tmp" && ` +
    `chown www:www "$tmp" && chmod 640 "$tmp" && mv -f "$tmp" "${REMOTE_PATH}"`;

  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'hk', remoteCmd], {
    input: payload,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 20000
  });

  console.log('synced ok:', data.updatedAt, (data.providers || []).map(p => `${p.id}:${p.status}`).join(','));
  process.exit(0);
}

main().catch(err => {
  console.error('quota-sync failed:', err && err.message ? err.message : err);
  process.exit(1);
});
