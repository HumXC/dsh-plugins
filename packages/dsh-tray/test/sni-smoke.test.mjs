import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const dbus = require("@deltachat/dbus-next");
const { TrayService } = require("../lib/tray.js");
const { DbusMenuService } = require("../lib/menu.js");
const { buildSnapshot, buildMenuNodes, NEW_SESSION_ID } = require("../lib/present.js");
const { SessionStateTracker } = require("../lib/state.js");

test("SNI ownership handles primary/already and rejects queued/existing", async () => {
    const makeBus = (reply, log) => ({ requestName: async () => reply, export: () => { }, unexport: () => log.push("unexport"), releaseName: async () => log.push("release") });
    for (const reply of [dbus.RequestNameReply.PRIMARY_OWNER, dbus.RequestNameReply.ALREADY_OWNER]) {
        const log = []; const tray = new TrayService({ snapshot: () => ({ status: "Active", pixmap: [], tooltipTitle: "", tooltipBody: "" }), onActivate() { }, onSecondaryActivate() { }, onContextMenu() { } });
        await tray.start(makeBus(reply, log)); await tray.stop(); assert.deepEqual(log, ["unexport", "release"]);
    }
    for (const reply of [dbus.RequestNameReply.IN_QUEUE, dbus.RequestNameReply.EXISTS]) {
        const log = []; const tray = new TrayService({ snapshot: () => ({ status: "Active", pixmap: [], tooltipTitle: "", tooltipBody: "" }), onActivate() { }, onSecondaryActivate() { }, onContextMenu() { } });
        await assert.rejects(() => tray.start(makeBus(reply, log)), /未获得所有权/); assert.deepEqual(log, ["release"]);
    }
});

test("SNI + DBusMenu 冒烟(需独立 session bus)", async (t) => {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
        t.skip("无 DBUS_SESSION_BUS_ADDRESS:请用独立 dbus-daemon 运行");
        return;
    }
    const activateCalls = [];
    const viewed = {
        lastViewedAt: () => undefined,
        markViewed: (id, at) => { viewedCalls.push([id, at]); },
    };
    const viewedCalls = [];
    const tracker = new SessionStateTracker(viewed);
    // 造一个"已完成未查看"会话 → green focus → SNI status Active
    tracker.applyEvent("sess-1", { type: "turn/end", seq: 1, time: 5000, reasonKind: "completed" });
    tracker.setTitle("sess-1", "示例任务");

    let menuById = new Map();
    const tray = new TrayService({
        snapshot: () => buildSnapshot(tracker.focus(), { iconSize: 22 }),
        onActivate: (x, y) => activateCalls.push([x, y]),
        onSecondaryActivate: () => { },
        onContextMenu: () => { },
    });
    const menu = new DbusMenuService({
        getRoot: () => {
            const r = buildMenuNodes(tracker.listMenu(20), {});
            menuById = r.byId;
            return r.root;
        },
        onEvent: () => { },
    });

    const bus = dbus.sessionBus();
    let cbus;
    try {

        // —— mock watcher:验证 RegisterStatusNotifierItem ——
        const registrations = [];
        class Watcher extends dbus.interface.Interface {
            constructor() {
                super("org.kde.StatusNotifierWatcher");
            }
            RegisterStatusNotifierItem(service) {
                registrations.push(service);
            }
        }
        Watcher.configureMembers({
            methods: { RegisterStatusNotifierItem: { inSignature: "s", outSignature: "" } },
        });
        await bus.requestName("org.kde.StatusNotifierWatcher", dbus.NameFlag.ALLOW_REPLACEMENT);
        bus.export("/StatusNotifierWatcher", new Watcher());


        await tray.start(bus);
        await menu.start(bus);
        await tray.notifyWatcher(bus); // 菜单对象就绪后才注册(时序测试)

        // 协议允许重复注册(NameOwnerChanged 兜底可能补一次);断言包含即可
        assert.ok(registrations.includes(tray.name), "已向 watcher 主动注册: " + JSON.stringify(registrations));

        // —— 客户端读 SNI 属性(标准 org.freedesktop.DBus.Properties.Get) ——
        cbus = dbus.sessionBus();
        const svc = await cbus.getProxyObject(tray.name, "/StatusNotifierItem");
        const sni = svc.getInterface("org.kde.StatusNotifierItem");
        const Props = svc.getInterface("org.freedesktop.DBus.Properties");
        const getProp = async (name) => {
            const v = await Props.Get("org.kde.StatusNotifierItem", name);
            return v && typeof v === "object" && "value" in v ? v.value : v;
        };

        const status = await getProp("Status");
        assert.equal(status, "Active", "完成未查看应 Active");

        const menuPath = await getProp("Menu");
        assert.equal(menuPath, "/StatusNotifierItem/Menu");

        const pix = await getProp("IconPixmap");
        assert.ok(Array.isArray(pix), "IconPixmap 应为数组");
        const [w, h, buf] = pix[0];
        assert.ok(w === 16 && h === 16, "16px 尺寸: " + w + "x" + h);
        assert.ok(buf.length >= 16, "像素数据非空");
        let opaque = 0;
        for (let i = 0; i < buf.length; i += 4) if (buf[i + 3] > 0) opaque += 1;
        assert.ok(opaque > 30, "16px 应有白色像素,实际 " + opaque);

        assert.equal(await getProp("IconName"), "", "IconName 置空以走 pixmap(避免 GTK 紫黑占位)");
        assert.ok((await getProp("AttentionIconPixmap")).length >= 2, "AttentionIconPixmap 填主图");

        const tip = await getProp("ToolTip");
        assert.ok(tip[1].length >= 2, "tooltip 带多尺寸图标(" + tip[1].length + ")");
        assert.match(tip[3], /已完成/, "tooltip 正文含状态");

        // —— 方法回调 ——
        await sni.Activate(10, 20);
        assert.deepEqual(activateCalls, [[10, 20]]);

        // —— DBusMenu ——
        const msvc = await cbus.getProxyObject(tray.name, "/StatusNotifierItem/Menu");
        const dm = msvc.getInterface("com.canonical.dbusmenu");
        const MenuProps = msvc.getInterface("org.freedesktop.DBus.Properties");
        const envV = await MenuProps.Get("com.canonical.dbusmenu", "Version");
        assert.equal(envV.value, 3);

        const lay = await dm.GetLayout(0, -1, []);
        const [revision, rootNode] = lay;
        assert.ok(revision >= 1, "revision >= 1");
        // 协议:u + 单个根 (ia{sv}av),根.children(av)=顶层菜单项
        assert.equal(rootNode[0], 0, "根 id=0");
        const topItems = rootNode[2].map((v) => v.value);
        const ids = topItems.map((n) => n[0]);
        assert.ok(ids.includes(NEW_SESSION_ID), "含新会话项: " + JSON.stringify(ids));
        const sessionNode = topItems.find((n) => n[0] === 100);
        assert.ok(sessionNode, "会话项 id=100 存在");
        assert.match(sessionNode[1].label.value, /示例任务/, "菜单 label 用会话标题");
        assert.equal(menuById.get(100), "sess-1", "menu 映射");
        // 菜单图标用系统主题图标名(icon-name,Adwaita symbolic 精确名),不传图像数据
        const iconV = sessionNode[1]["icon-name"];
        assert.ok(iconV && iconV.signature === "s", "icon-name 类型 s,实际: " + (iconV && iconV.signature));
        assert.ok(
            ["checkbox-checked-symbolic", "appointment-soon-symbolic", "window-close-symbolic", "system-run-symbolic"].includes(iconV.value),
            "icon-name 为 Adwaita symbolic 精确名(运行中也有对齐图标): " + iconV.value,
        );
        // 顶层只有:新会话、分隔线、两个会话(workspace 仅在“新会话”子项里)
        const topIds = topItems.map((n) => n[0]).sort((a, b) => a - b);
        assert.deepEqual(topIds, [1, 2, 100], "顶层项集合(不含被扁平化的子项): " + JSON.stringify(topIds));

        // —— 点击 Event → onEvent 触发 markViewed 由宿主处理(此处直接模拟) ——
        await dm.Event(100, "clicked", new dbus.Variant("s", ""), 0);
        tracker.markViewed("sess-1", 9000);
        const fAfter = tracker.focus();
        assert.equal(fAfter.level, 0, "查看后绿点消失");

        // 工作区子菜单:getRoot 带 workspaces 时新增子项
        const wsRoot = buildMenuNodes(tracker.listMenu(20), { workspaces: [{ id: "w1", title: "示例工作区" }] });
        const newItem = wsRoot.root.find((n) => n.id === 1);
        assert.ok(newItem.children.length === 1, "工作区子菜单一项");
        const wsChild = newItem.children[0];
        assert.equal(wsChild.data, "ws:w1", "工作区子项 data");
        assert.equal(wsRoot.byId.get(wsChild.id), "ws:w1", "工作区映射");

        // GetGroupProperties 数组输出(防 dbus-next 多输出误解)
        {
            const gp = await dm.GetGroupProperties([1], []);
            assert.ok(Array.isArray(gp) && gp.length >= 1, "GetGroupProperties 返回数组");
            assert.equal(gp[0][0], 1, "GetGroupProperties id 正确");
        }

        // markDirty(节流 200ms)后 revision 增加
        const r1 = await dm.GetLayout(0, -1, []);
        menu.markDirty();
        await new Promise((res) => setTimeout(res, 250)); // 等节流生效
        const r2 = await dm.GetLayout(0, -1, []);
        assert.ok(r2[0] > r1[0], "markDirty 增加 revision");
    } finally {
        try { tray.stop(); } catch { }
        try { menu.stop(); } catch { }
        try { cbus?.disconnect(); } catch { }
        try { bus.disconnect(); } catch { }
    }
});