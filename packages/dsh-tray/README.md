# dsh-tray

DSH(DeepSeek Harness)的 Linux 系统托盘插件:基于 StatusNotifierItem 在桌面状态栏显示会话状态点、悬浮提示、激活跳转与右键菜单。

## 功能特性

- **状态点**:托盘图标按会话状态显示绿 / 黄 / 红状态点(见下节规则);
- **悬浮提示**:展示当前会话标题与状态,提示图标随状态着色;
- **激活跳转**:左键激活托盘项,跳转到当前会话(无会话时新建);
- **右键菜单**:新建会话 + 会话列表(仅显示"运行中"或"有事件未查看"的会话),点击菜单项直接跳转;
- **Web 已读同步**:浏览器中打开 / 聚焦会话后,托盘自动清除该会话的未读状态点;
- **事件驱动**:全部基于 DSH 宿主事件(会话创建 / 运行 / 完成 / 阻塞 / 错误 / 导航),无轮询。

## 状态点规则

| 会话状态 | 托盘显示 |
| --- | --- |
| idle / 未运行 | 无状态点 |
| 运行中 | 无状态点 |
| 完成(未查看) | 绿点 |
| 运行中且有事件(阻塞 / 错误) | 黄点 |
| 阻塞 / 错误(未查看) | 红点(图标右下角小圆点) |

状态判定以时间先后为准:完成或出错时间晚于"已查看"时间即显示未读状态点;在浏览器中查看会话后立即清除。

## 会话菜单

- 只显示**运行中**或**有事件(完成 / 阻塞 / 错误)未查看**的会话;
- 已查看且无事件的历史会话不进入菜单;
- 菜单项图标标注状态:运行中 / 完成 / 警告 / 错误,均使用系统图标主题(如 Adwaita)的 symbolic 图标。

## 已读同步(Web)

- 浏览器端注入脚本监听 localStorage 中 dsh.sessions.current 键的写入,读取当前会话 id 后通过 POST /plugins/dsh-tray/viewed 上报;
- 每次 dsh web 启动生成随机 token(不持久化),请求需携带 token,不匹配返回 401;
- 宿主收到上报后调用 markViewed 并刷新托盘与菜单;
- 因此重启 dsh web 后,旧页面需硬刷新(Ctrl+Shift+R)以获取新 token。

## 安装

```bash
# 方式一:发布后安装
pnpm add dsh-tray

# 方式二:本地拷贝到 profile(开发时)
cp -r packages/dsh-tray <profile>/node_modules/dsh-tray
```

在 profile 的 cordis.patch.yml 或 bundle.yml 中引入插件并(可选)覆盖配置,重启 dsh web 生效。插件同时注册 host 端(托盘)与 web 端(已读同步注入脚本)。

## 配置

插件通过 Config schema(cordis 配置)提供以下可选项:

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| webBaseUrl | 运行时推导 | web 前端基础 URL(scheme + host + port),用于跳转链接 |
| eventsPath | /plugins/dsh-tray/events | 导航事件通道路径 |
| iconSize | 22 | 托盘图标尺寸(px) |
| iconOutline | false | 浅色面板兜底:图标加 1px 深色描边 |
| iconColor | #4d6bfe | logo 填充色(DSH 品牌蓝) |
| dotGreen | #22c55e | 完成状态点颜色 |
| dotYellow | #eab308 | 需人工介入状态点颜色 |
| dotRed | #ef4444 | 异常状态点颜色 |

示例:

```yaml
- id: dsh-tray
  config:
    iconSize: 24
    iconColor: "#4d6bfe"
```

## 构建与测试

```bash
pnpm run build       # tsc + tsdown → lib/(含 client 入口)
pnpm run typecheck   # 仅类型检查
pnpm test            # 构建 + test/run-bus-tests.sh(需要可用的 dbus 会话)
```

总线测试覆盖协议冒烟、状态机、图标渲染、菜单构建、跳转、通道与已读同步等;dbus 偶发竞争时重跑即可。

## 许可证

MIT
