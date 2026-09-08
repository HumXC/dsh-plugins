# dsh-tray

DSH 的 Linux StatusNotifierItem 托盘插件：显示会话关注状态、悬浮提示和 DBusMenu。

## 行为

- 状态优先级为红（错误）、黄（待人工介入）、绿（完成未查看）、运行中；其他会话运行不会遮住完成绿点。
- 菜单标签和 session/title 事件实时更新；菜单身份在插件生命周期内单调稳定，过期点击安全忽略。
- 左键优先导航关注会话；没有关注会话时打开已认证的 DSH Web 根页面。
- 新会话操作先从完整会话集合复用未命名空闲会话，否则携带预分配 SessionId 创建一次。

## Host-Web 通信

导航使用 alpha5 官方 Gateway 的 `trayNavigation/watch` Remote 流，与页面其他流共享 WebSocket carrier，不再占用每个标签一条挂起的 HTTP 请求。每次流重连都会注册最新 presence；Host 一项导航只选择一个存活且正在等待的标签，绝不广播或自动重试已投递项。`/dsh-tray` authenticated custom RPC 仅保留短请求 `presence/update`、`presence/disconnect` 和 `navigation/ack`。

当没有存活标签时，Host 将意图保存在内存队列，并且最多为该意图调用一次 `ctx.connection.authenticatedUrl(baseUrl)`。启动 URL 不含目标查询参数，认证重定向到干净根页面；10 秒全局启动冷却可合并同一引导阶段的多个请求。Host 重启会丢弃未持久化意图，用户可再次点击。

浏览器标签以临时 clientId 上报完整的焦点、可见性和 `SessionListState.current`。相同状态通知会合并去重，每 20 秒强制一次心跳。仅存活、可见、聚焦、当前会话匹配且最近 45 秒内上报过 presence 的标签才提供自动已读证据。导航连接活动可以维持客户端存活，但不能延长焦点证据的有效期；无活动的客户端由 45 秒 TTL 清理。客户端保留最多 128 个、最长 120 秒的已完成意图 ID，避免重复投递副作用。已读状态未变化时不重复写存储，托盘和菜单展示未变化时不重复发送刷新信号。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| webBaseUrl | 运行时推导 | HTTP(S) DSH Web origin；Host trust preflight 拒绝不受信 authority |
| iconSize | 22 | 托盘图标尺寸，限制在 16..256 |
| iconOutline | false | 浅色面板增加深色描边 |
| iconColor | #4d6bfe | logo 填充色 |
| dotGreen | #22c55e | 完成状态点颜色 |
| dotYellow | #eab308 | 待人工介入颜色 |
| dotRed | #ef4444 | 异常颜色 |

插件保留每 20,000 ms 一次的低频会话清扫，作为遗漏事件的收敛后备，不是导航或 presence 轮询。

## 安装与验证

安装发布包：`pnpm add dsh-tray`。从本仓库根目录构建和验证：

```bash
nix develop --no-write-lock-file -c pnpm --filter dsh-tray typecheck
nix develop --no-write-lock-file -c pnpm --filter dsh-tray test
```

构建先运行 `scripts/generate-remote.mjs`，由官方 alpha5 Typert 生成器从 Host Service 生成 `lib/typert.host.*` 与 `lib/typert.remote-client.*`，再编译 Host 和浏览器 bundle；不要手改这些产物。Gateway、Registry、Protocol 与生成器固定为 `0.1.2-alpha.5`。仓库的 pnpm patch 修复该生成器对外部 npm Protocol 声明的识别；升级生成器时应运行对应回归测试，并在官方修复后移除补丁。

完整验证需要 Node.js >=22 和独立 Linux DBus 会话。`test/run-bus-tests.sh` 为每个测试预加载 opener/子进程隔离，不访问真实桌面。发布内容包含 `lib`、`bundle.yml`、`README.md` 与本包 `LICENSE`。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
