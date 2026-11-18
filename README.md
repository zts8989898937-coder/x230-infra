# x230-infra

Arch Linux 自托管服务与远程入口的通用运维脚本、应用模块和架构路线。

| 目录 | 说明 |
|---|---|
| `x230/bin/` | 运维与维护工具源码；包含环境相关逻辑，使用前按自己的环境配置并审查 |
| `webterm/` | 网页终端源码与测试 |
| `website/workspace/` | 工作区前后端模块 |
| `examples/` | 通用服务、容器和代理配置示例 |
| `docs/` | 架构与实现路线 |

真实系统配置、启用服务清单和防火墙状态属于私有备份，不随公开代码发布。原 `sync-from-live.sh` 自动采集入口已停用，避免再次把整机配置当作源码上传。

公开范围见 [PUBLIC_SCOPE.md](PUBLIC_SCOPE.md)，恢复思路见 [RECOVER.md](RECOVER.md)。
