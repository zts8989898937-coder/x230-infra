#!/usr/bin/env bash
# Collect live X230 + HK infrastructure configs/scripts into this Git repo with secret redaction.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

mkdir -p x230/bin x230/systemd x230/etc x230/webapps webterm website/workspace hk/nginx hk/scripts hk/fail2ban/filter.d hk/fail2ban/jail.d hk/sshd

# 1. X230 /usr/local/bin (text scripts only, no *.bak*)
rm -f x230/bin/*
for f in /usr/local/bin/*; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  case "$base" in *.bak*) continue ;; esac
  if grep -qI . "$f" 2>/dev/null; then
    cp -a "$f" "x230/bin/$base"
  fi
done

# 2. X230 custom systemd units & drop-ins
rm -rf x230/systemd/*
for f in /etc/systemd/system/*.service /etc/systemd/system/*.timer /etc/systemd/system/*.socket; do
  [ -e "$f" ] || continue
  [ -L "$f" ] && continue
  cp -a "$f" x230/systemd/
done
for d in /etc/systemd/system/*.service.d; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  mkdir -p "x230/systemd/$name"
  cp -a "$d"/*.conf "x230/systemd/$name/" 2>/dev/null || true
done
systemctl list-unit-files --state=enabled --no-legend | awk '{print $1}' | sort > x230/systemd/enabled-units.txt

# 3. X230 key /etc configs + webapps compose
cp -a /etc/nftables-x230-guard.conf x230/etc/nftables-x230-guard.conf 2>/dev/null || true
cp -a /etc/netdata/netdata.conf x230/etc/netdata.conf 2>/dev/null || true
sudo cat /etc/ntfy/server.yml > x230/etc/ntfy-server.yml 2>/dev/null || true
cp -a /etc/samba/smb.conf x230/etc/smb.conf 2>/dev/null || true
cp -a /etc/arch-auto-roll.conf x230/etc/arch-auto-roll.conf 2>/dev/null || true
cp -a /home/zts/agent-share/webapps/docker-compose.yml x230/webapps/docker-compose.yml 2>/dev/null || true

# 4. Webterm clean source + tests (excluding pastes/uploads/baks)
rm -rf webterm/*
for f in /home/zts/agent-share/webterm/*; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  case "$base" in *.bak*|*.log) continue ;; esac
  cp -a "$f" "webterm/$base"
done

# 5. Blog workspace frontend/backend files
rm -rf website/workspace/*
for f in /home/zts/agent-share/agent_misson/网站维护/workspace/*.{php,js,css,svg}; do
  [ -f "$f" ] || continue
  cp -a "$f" website/workspace/
done

# 6. HK VPS nginx/fail2ban/sshd/scripts snapshot
ssh -o BatchMode=yes hk 'tar -cf - \
  --exclude="*.bak*" \
  /www/server/panel/vhost/nginx/*.conf \
  /www/backup/backup.sh \
  /usr/local/bin/hk-sync-gdrive.sh \
  /etc/fail2ban/filter.d/dsh-auth.conf \
  /etc/fail2ban/filter.d/wp-login.conf \
  /etc/fail2ban/filter.d/webterm-auth.conf \
  /etc/fail2ban/jail.d/*.conf \
  /etc/fail2ban/jail.d/*.local \
  /etc/ssh/sshd_config.d/00-hardening.conf 2>/dev/null' | tar -xf - -C hk/ --transform='s|^www/server/panel/vhost/nginx/|nginx/|; s|^www/backup/|scripts/|; s|^usr/local/bin/|scripts/|; s|^etc/fail2ban/|fail2ban/|; s|^etc/ssh/sshd_config.d/|sshd/|' 2>/dev/null || true
ssh -o BatchMode=yes hk 'ufw status numbered' > hk/ufw-status.txt 2>/dev/null || true

# 7. Sanitize any inline credentials/cookies before Git commit (without storing literals in this script)
python3 - <<'PY'
import pathlib, re

root = pathlib.Path('.')
patterns = [
    (re.compile(r"const USER = 'zts', PASS = '[^']+';"), "const USER = 'zts', PASS = process.env.WEBTERM_PASS || '<REDACTED_SEE_SECRETS>';"),
    (re.compile(r'((?:PASSWORD|PASS|TOKEN|COOKIE|auth_basic|secret)[=:\s"\']+)(?:zts\d{4,}|[0-9a-f]{32})', re.I), r'\1<REDACTED>'),
    (re.compile(r'(set-cookie|dsh_ok=)[0-9a-f]{32}', re.I), r'\1<REDACTED_DSH_COOKIE>'),
    (re.compile(r'("[0-9a-f]{32}"\s+"off";)'), '"<REDACTED_DSH_COOKIE>" "off";'),
    (re.compile(r'(--pass\s+)\S+'), r'\1<REDACTED>'),
    (re.compile(r'x230-[0-9a-f]{6}\b'), 'x230-<REDACTED_TOPIC>'),
]

# Also redact exact values listed in ~/.config/secrets/webapps.md & dsh-ok-cookie.txt dynamically
extra = []
for sp in [pathlib.Path.home() / '.config/secrets/webapps.md', pathlib.Path.home() / '.config/secrets/dsh-ok-cookie.txt']:
    if sp.exists():
        for tok in re.findall(r'(?:PASS|TOKEN|dsh_ok)=([^\s#]+)|^([0-9a-f]{32})$', sp.read_text(errors='ignore'), re.M):
            val = next((x for x in tok if x), '')
            if len(val) >= 6:
                extra.append(val)

for p in root.rglob('*'):
    if not p.is_file() or '.git' in p.parts or p.name == 'sync-from-live.sh':
        continue
    if p.suffix in ('.png', '.jpg', '.webp', '.ico', '.pdf'):
        continue
    try:
        txt = p.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        continue
    orig = txt
    for rx, rep in patterns:
        txt = rx.sub(rep, txt)
    for val in extra:
        txt = txt.replace(val, '<REDACTED>')
    if txt != orig:
        p.write_text(txt, encoding='utf-8')
PY

echo "sync-from-live completed cleanly."
