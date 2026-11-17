# X230 + HK 基础设施版本库与灾备恢复手册

本仓库集中托管 **X230（Arch Linux Agent 宿主机）** 与 **HK VPS（156.239.8.225）** 的非涉密代码、系统脚本、Systemd 编排、防火墙与 Nginx 配置（涉密口令与密钥统一存在本机 `~/.config/secrets/` 及 Restic/Google Drive 加密备份，不入 Git）。

## 目录结构

- `x230/bin/`：`/usr/local/bin/` 自定义运维、网络门禁、自动滚包、DSH 补丁与备份脚本
- `x230/systemd/`：自定义 `.service` / `.timer` / drop-in 与启用清单 `enabled-units.txt`
- `x230/etc/`：宿主防火墙 `nftables-x230-guard.conf`、Netdata、ntfy、Samba、自动滚包配置
- `x230/webapps/`：`docker-compose.yml`（脱敏版）
- `webterm/`：局域网/公网网页终端后端与折叠对话前端及回归测试
- `website/workspace/`：`stillfloating.top/workspace/` 工作区源码
- `hk/`：HK VPS Nginx 站点配置（脱敏 cookie）、Fail2ban 规则、`00-hardening.conf`、UFW 规则与 `hk-sync-gdrive.sh`

## 日常同步提交

```bash
cd /home/zts/agent-share/x230-infra
./sync-from-live.sh
git status
git diff
git commit -am "chore: sync live infra" && git push
```

## 换新机灾备恢复流程（< 30 分钟重建思路）

1. **取回加密备份仓库**：
   - 优先直连 HK：`sftp:root@156.239.8.225:/srv/restic/x230`
   - 若 HK 不可用，从 Google Drive 镜像取回：`rclone:gdrive:系统备份/x230-restic-hk-mirror`
2. **还原官方包与 AUR 包**：
   - 读取 `pkglist-official.txt` 批量装回：`sudo pacman -S --needed - < pkglist-official.txt`
3. **恢复 `/home/zts/.config/secrets/`、`/home/zts/.ssh/` 与 `/etc/`**：
   - `restic -r <repo> restore latest --target /tmp/restore --include /home/zts/.config/secrets --include /home/zts/.ssh --include /etc`
4. **恢复本仓库脚本与 systemd 单元**：
   - 将 `x230/bin/*` 拷回 `/usr/local/bin/`、`x230/systemd/*` 拷回 `/etc/systemd/system/`、`webterm/` 部署并按 `~/.config/secrets/` 填入凭据，按 `enabled-units.txt` 启用服务后跑 `boot-network-guard --check` 与 `docker compose up -d`。
