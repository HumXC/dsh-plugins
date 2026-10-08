# dsh-openpencil-workspace

把 OpenPencil 编辑器放进 DSH 对话顶部的 OpenPencil 页签，接管聊天消息中的本地 .op 文件链接。点击文件链接、卡片按钮或 Better Sidebar 文件树中的 .op 文件后打开画布。

## Better Sidebar 可选适配

检测到 betterSidebar 服务后，自动注册 OpenPencil 文件预览器（扩展名 op、优先级 100、fetchStrategy: none），支持当前验证的 dsh-better-sidebar 0.24.1；没有安装该插件时，聊天链接与顶部页签照常使用。服务卸载时注销预览器，重新加载时重新注册，不修改 Better Sidebar 发行文件。

点击 .op 后，适配器调用现有文件打开接口并切换到顶部 OpenPencil 页签，成功后关闭此次打开的 .op 预览标签并收起整个侧栏，不显示中转页，也不跳转到文件浏览器预览。其他标签和文件树状态保留，关闭预览不会关闭顶部画布。失败或取消当前画布的关闭操作时保留侧栏和预览标签并显示原因，可点击“重试”。原位切换路径会取消旧请求，过期响应不会再替换当前画布；等待期间切换会话或侧栏标签时，也不会关闭或收起后来打开的界面。Better Sidebar 会先更新标签再挂载预览器，因此仍可能短暂出现空白预览区域。

可在 Better Sidebar 的文件预览器设置中关闭 OpenPencil 预览器，恢复 .op 的原有预览方式。

## 行为

- 官方生成工具不再创建右侧独立工作台，也不再为它压缩聊天区域。生成中的画布可在后台保留，但不会自动切离 Chat。
- 在聊天中点击本地 .op 文件链接，直接激活顶部 OpenPencil 页签。官方卡片的“编辑画布”按钮也使用这个页签。
- 复用官方 ManagedOpenPencilEditor，保留原生启动、保存、恢复、关闭确认及选区工具；这个打开文件流程不调用 Jian 或独立渲染工具。
- 发现未保存恢复稿时，第一次确认用于载入画布，随后仍须保存才写入源文件并清理旧记录。取消载入后会另问是否永久放弃恢复稿：确认只清除恢复稿，保留磁盘上的源文件；再次取消则保留恢复稿，下次打开仍提示。没有隐式删除，也不自动覆盖源文件。
- 切到 Chat 或其他会话时，只隐藏编辑器。返回原会话时继续使用同一个 iframe，避免重新挂载丢失内存中的修改。
- 同时保留一个画布。切换文件使用官方关闭保护；后台生成请求不会替换其他文件或其他会话的编辑器。
- 复用官方工具栏显示文件名、保存状态、保存和关闭按钮。顶栏高 36px；保存与关闭共用 26px 高、相同边框、圆角和字体的样式。Ctrl+S（macOS 为 Command+S）仍走原生保存通路。
- “关闭”会调用官方关闭协议，撤销普通文件的编辑会话、停止对应原生进程并卸载 iframe；有未保存修改时确认，保存进行中禁用关闭。生成中的 live draft 只解除界面挂接，生成事务继续。
- 每个会话分别在当前浏览器 localStorage 记录最后一次进入就绪状态的 .op 文件路径。刷新网页或重启 DSH 后，首次进入空白 OpenPencil 页签时通过原文件打开接口恢复，重新校验文件与会话权限；编辑器运行时晚加载也支持恢复。只记录路径，不保存编辑令牌、文件内容或未发布 live draft。
- 当前有画布、该会话本次已打开过画布、或恢复期间用户手动打开/关闭画布时不自动替换。主动关闭后本次运行不自动重开，刷新后仍可恢复上次文件。切换会话或离开页签会取消未完成恢复。文件不存在时清理该条路径记录并保持空白；无权限、网络或启动失败时保留记录供下次刷新尝试，不循环重试或抢占 Chat。
- 不订阅会话输出，不收集文件，不保存文件列表，也不执行定时存在性检查。升级时会删除上一版文件列表的浏览器缓存。
- 普通文件链接仍交给原聊天文件处理器，原有行号参数也保留。Better Sidebar 中仅 .op 文件使用专用预览器，其他文件保持原有预览方式。

## 兼容范围与补丁

当前支持 DSH 0.2.0-rc.2 的客户端插槽接口、React 18 和 Node >=24.11.0。官方插件补丁严格支持 **@zseven-w/dsh-openpencil 0.1.0-rc.13**。

官方插件自行在 document.body 创建工作台，没有公开的宿主替换接口。因此这里对官方发行包的两个编译文件施加小补丁：

1. lib/client.js 的工作台工厂提前返回适配器，公开原编辑器组件和生命周期函数，转交顶部页签处理；原侧边栏工厂不会执行。同时增加可选 hideToolbar 参数、作用域明确的工具栏样式类，以及取消恢复后的明确丢弃确认；本插件当前显示原工具栏，保留原生保存消息处理和生命周期。
2. lib/index.js 公开一个进程内授权服务，文件打开端点用它取得官方文档和编辑器能力。

脚本同时检查版本、两个完整文件的 SHA-256 和补丁锚点；两个文件都验证通过后才修改。原始内容保存在官方包中的 .dsh-openpencil-workspace-backup。重复应用与恢复都是幂等操作，副本被改过或版本未知时会拒绝操作。

官方插件更新可能覆盖补丁。请先执行 patch:check；已知旧 workspace 补丁会显示 outdated，再执行 apply 可升级工具栏和恢复稿处理，原始备份保持不变。未知版本需要更新适配和测试后才能应用，不会尝试猜测新版本结构。卸载本插件前应先恢复官方补丁，否则官方编辑按钮缺少接收方。

聊天导航装饰保留原插槽条目、注入缓存和子插槽归属；通过公开的注册/释放操作通知重绘，卸载时恢复原组件。SDK 插槽实现升级也应跑导航回归测试。

## 构建和测试

在仓库根目录通过 pnpm 工作区统一安装依赖、构建和测试：

```sh
pnpm install
pnpm --filter dsh-openpencil-workspace test
```

原生测试使用临时文档和临时 DSH_HOME，退出时关闭子进程并移除临时目录，不修改正式画布或设置：

```sh
pnpm --filter dsh-openpencil-workspace test:native /home/HumXC/.dsh/profiles/web/node_modules/@zseven-w/dsh-openpencil
pnpm --filter dsh-openpencil-workspace test:patch-integration \
  /home/HumXC/.dsh/profiles/web/node_modules/@zseven-w/dsh-openpencil \
  /home/HumXC/.npm-packages/lib/node_modules/@deepseek-ai/dsh
```

第二个测试复制真实官方包、应用补丁、加载后端入口、调用文件打开端点并启动原生编辑器，最后恢复副本并验证正式发行包的哈希未变。第二个路径参数为当前 DSH 安装包根目录，用来模拟宿主提供 SDK 的模块解析。

自动化覆盖导航、会话作用域、未保存状态、保存时禁用关闭、iframe 保持挂载、紧凑工具栏与按钮样式、旧缓存清除、最近文件持久化与刷新恢复、已删除文件清理、异步恢复取消及手动打开优先、后台生成不抢焦点、恢复稿确认/保留/明确丢弃/失败、补丁升级/回滚和文件权限。原生临时画布测试验证保存、外部修改冲突、关闭后进程停止和同一文件重开。Happy DOM 的样式和生命周期测试不能代替真实浏览器验收；实际 GUI 验收步骤见下方。

## 接入当前 profile

本包不会在安装生命周期自动修改官方插件。保存并关闭当前编辑器后，安装本包、施加补丁，再重启当前 DSH Web 进程并刷新原页面：

```sh
dsh plugin --profile web add /home/HumXC/dsh-plugins/packages/dsh-openpencil-workspace
node /home/HumXC/dsh-plugins/packages/dsh-openpencil-workspace/scripts/patch-openpencil.mjs check \
  /home/HumXC/.dsh/profiles/web/node_modules/@zseven-w/dsh-openpencil
node /home/HumXC/dsh-plugins/packages/dsh-openpencil-workspace/scripts/patch-openpencil.mjs apply \
  /home/HumXC/.dsh/profiles/web/node_modules/@zseven-w/dsh-openpencil
```

本地路径安装后修改源代码仍需重新构建。脚本、前后端编译包和 profile 配置的改变需要重启现有 DSH 实例并刷新网页；无需新开替代 Web 服务。

GUI 验收：

1. 刷新当前 DSH 页面，确认对话顶部有 OpenPencil 页签。
2. 点击聊天消息中的 .op 文件链接；编辑器应进入该页签，右侧原工作台不弹出。
3. 修改画布，切回 Chat，再切回 OpenPencil，确认修改保留；在画布中按 Ctrl+S 后文件应更新。
4. 有未保存修改时打开另一文件，确认原编辑器会请求处理修改，取消后仍保留原文件。
5. 运行一次生成流程，确认 Chat 不会自动失焦，画布可通过顶部页签或卡片按钮进入。
6. 在 Better Sidebar 文件树点击 .op，确认切换到顶部 OpenPencil 页签后关闭对应预览标签并收起整个侧栏；重新展开时该空白标签已移除，其他文件标签保留，顶部画布仍然可用。打开失败或取消画布切换时侧栏保留错误并可重试；等待期间切换会话或标签时不应误关或收起新界面。点击普通文件仍使用原预览器。在预览器设置关闭 OpenPencil 后，.op 恢复原有预览方式。
7. 确认顶栏显示文件名、保存状态、保存和关闭按钮，高度为 36px，保存与关闭样式一致，没有全屏按钮、文件下拉框或自动收集列表。
8. 点击“关闭”，确认画布卸载，重新点击同一文件可再次打开。有恢复稿时，取消载入后确认丢弃，再关闭重开应不再提示同一恢复稿；两次都取消则继续保留。
9. 打开一个已有 .op 文件并等画布就绪，刷新网页后进入同一会话的 OpenPencil 页签，应恢复该文件；其他会话的记录不混用。主动关闭后切回 Chat 再返回不应自动重开。已打开新文件时不会被旧恢复请求覆盖；删除记录对应的临时测试文件后刷新，页面应保持空白且该条记录被移除。

文件打开接口只接受本机同源请求，按会话沙箱检查文件路径及符号链接，拒绝只读会话。没有绕过会话文件权限，也不会因打开文件触发独立渲染。

## 回滚

先保存并关闭画布，然后恢复官方文件，再从 profile 移除本插件并重启 DSH：

```sh
node /home/HumXC/dsh-plugins/packages/dsh-openpencil-workspace/scripts/patch-openpencil.mjs restore \
  /home/HumXC/.dsh/profiles/web/node_modules/@zseven-w/dsh-openpencil
dsh plugin --profile web remove dsh-openpencil-workspace
```

恢复脚本会验证当前文件恰好是原始或本工具生成的补丁版本；不会覆盖人工改动。
