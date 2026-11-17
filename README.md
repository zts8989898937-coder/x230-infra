# x230-infra

X230（Arch Linux Agent 宿主机）与香港 VPS（WordPress + 反向隧道入口）的基础设施版本库与灾备恢复配置（已做密钥脱敏处理）。

## 仓库结构

| 目录 | 说明 |
|---|---|
| `x230/bin/` | `/usr/local/bin/` 运维、网络门禁、自动滚包、DSH 补丁与备份脚本 |
| `x230/systemd/` | 自定义 `.service` / `.timer` / drop-in 与 `enabled-units.txt` |
| `x230/etc/` | 防火墙 `nftables-x230-guard.conf`、Netdata、ntfy、Samba、自动滚包配置 |
| `x230/webapps/` | 自托管 Docker 服务栈 `docker-compose.yml`（脱敏版） |
| `webterm/` | 网页终端后端、tmux 会话脚本、折叠对话与配额面板前端及测试 |
| `website/workspace/` | [stillfloating.top/workspace/](https://stillfloating.top/workspace/) 私人工作区源码 |
| `hk/` | HK VPS Nginx 站点配置（脱敏）、Fail2ban、SSHD 加固与 UFW 规则 |

## 日常同步（双推 Gitea + GitHub）

```bash
./sync-from-live.sh
git status
git commit -am "chore: sync live infra"
git push origin main
```

`sync-from-live.sh` 会在收集线上配置后自动脱敏内联凭据与会话 Cookie。

## 灾备恢复

详细重建步骤见 [RECOVER.md](./RECOVER.md)。
