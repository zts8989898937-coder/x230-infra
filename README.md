# x230-infra

Arch Linux 自托管服务与远程入口的通用运维脚本、应用模块和架构路线。

| 目录 | 说明 |
|---|---|
| `x230/bin/` | 运维与维护工具源码；包含环境相关逻辑，使用前按自己的环境配置并审查 |
| `webterm/` | 网页终端源码与测试 |
| `website/workspace/` | 工作区前后端模块 |
| `examples/` | 通用服务、容器和代理配置示例 |
| `docs/` | 架构与实现路线 |

需要搭建同类环境时，可从[恢复路线](RECOVER.md)开始，参考 `examples/` 建立服务编排。实际配置及运行数据由部署者独立维护。

## 2026-11-18 公开版更新

移除运行配置与防火墙快照，新增 systemd、Compose 和 nginx 示例，停用自动采集入口。 [查看更新提交](https://github.com/zts8989898937-coder/x230-infra/commit/87cae34047e070a529d9f94c634d630c547f597f)

[公开范围](PUBLIC_SCOPE.md) · [架构说明](docs/ARCHITECTURE.md) · [后续路线](docs/ROADMAP.md)

## 网页终端配置

启动前通过私有环境设置 `WEBTERM_PASS`，或将配置放在服务账户的 `~/.config/secrets/webterm.json` 中，由该账户持有且权限为 `0600`。JSON 字段为 `password`、`user`、`host`、`origins` 和 `cookieKey`。环境变量 `WEBTERM_USER`、`WEBTERM_HOST`、`WEBTERM_ORIGINS`、`WEBTERM_COOKIE_KEY` 会覆盖相应字段。

默认只监听回环地址。如果需要通过局域网或反向代理访问，配置允许的完整来源（协议、主机和非默认端口）。`WEBTERM_ORIGINS` 使用逗号分隔。HTTPS 反向代理应经回环地址连接并覆盖 `Host`、`X-Forwarded-Proto` 和 `X-Real-IP`。为保持重启后的 Cookie 有效，生成并私下保存 32 字节的随机签名密钥，使用 64 位十六进制字符串。
