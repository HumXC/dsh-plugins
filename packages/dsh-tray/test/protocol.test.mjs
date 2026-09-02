/**
 * 协议一致性测试:起真实 dbus 服务,Introspect 拿 XML,
 * 对照官方协议 XML(KDE kf5 / com.canonical.dbusmenu)逐成员核对存在性与签名。
 * 跑在 run-bus-tests.sh 提供的独立 daemon 上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dbus = require("@deltachat/dbus-next");
import { TrayService } from "../lib/tray.js";
import { DbusMenuService } from "../lib/menu.js";

const SNI_PROP = {
  Category: "s", Id: "s", Title: "s", Status: "s", WindowId: "i", IconThemePath: "s",
  Menu: "o", ItemIsMenu: "b", IconName: "s", IconPixmap: "a(iiay)", OverlayIconName: "s",
  OverlayIconPixmap: "a(iiay)", AttentionIconName: "s", AttentionIconPixmap: "a(iiay)",
  AttentionMovieName: "s", ToolTip: "(sa(iiay)ss)",
};
const SNI_METHOD_IN = {
  ProvideXdgActivationToken: "s", ContextMenu: "ii", Activate: "ii", SecondaryActivate: "ii", Scroll: "is",
};
const SNI_SIGNALS = ["NewTitle", "NewIcon", "NewAttentionIcon", "NewOverlayIcon", "NewMenu", "NewToolTip", "NewStatus"];
const DM_PROP = { Version: "u", TextDirection: "s", Status: "s", IconThemePath: "as" };
const DM_METHOD_OUT = {
  GetLayout: "special",
  GetGroupProperties: "a(ia{sv})",
  GetProperty: "v",
  Event: "",
  EventGroup: "ai",
  AboutToShow: "b",
  AboutToShowGroup: "aiai",
};
const DM_SIGNALS = ["LayoutUpdated", "ItemsPropertiesUpdated", "ItemActivationRequested"];

test("协议与官方 XML 一致(SNI + DBusMenu)", async () => {
  const bus = dbus.sessionBus();
  class Watcher extends dbus.interface.Interface {
    constructor() { super("org.kde.StatusNotifierWatcher"); }
    RegisterStatusNotifierItem() {}
  }
  Watcher.configureMembers({ methods: { RegisterStatusNotifierItem: { inSignature: "s", outSignature: "" } } });
  await bus.requestName("org.kde.StatusNotifierWatcher", dbus.NameFlag.ALLOW_REPLACEMENT);
  bus.export("/StatusNotifierWatcher", new Watcher());

  const tray = new TrayService({
    snapshot: () => ({ status: "Active", pixmap: [[16, 16, Buffer.alloc(16 * 16 * 4)]], tooltipTitle: "t", tooltipBody: "b" }),
    onActivate: () => {}, onSecondaryActivate: () => {}, onContextMenu: () => {},
  });
  const menu = new DbusMenuService({ getRoot: () => [{ id: 1, label: "hi" }], onEvent: () => {} });
  try {
    await tray.start(bus);
    await menu.start(bus);
    await tray.notifyWatcher(bus);

    const sniObj = await bus.getProxyObject(tray.name, "/StatusNotifierItem");
    const sniXml = await sniObj.getInterface("org.freedesktop.DBus.Introspectable").Introspect();
    assert.ok(sniXml.includes('<interface name="org.kde.StatusNotifierItem">'), "SNI 接口存在");
    for (const [n, sig] of Object.entries(SNI_PROP)) {
      assert.ok(sniXml.includes('name="' + n + '" type="' + sig + '"'), "SNI 属性 " + n + " type " + sig);
    }
    for (const n of Object.keys(SNI_METHOD_IN)) {
      assert.ok(sniXml.includes('name="' + n + '"'), "SNI 方法 " + n + " 存在");
    }
    for (const n of SNI_SIGNALS) assert.ok(sniXml.includes('name="' + n + '"'), "SNI 信号 " + n);

    const mObj = await bus.getProxyObject(tray.name, "/StatusNotifierItem/Menu");
    const dmXml = await mObj.getInterface("org.freedesktop.DBus.Introspectable").Introspect();
    assert.ok(dmXml.includes('<interface name="com.canonical.dbusmenu">'), "dbusmenu 接口存在");
    for (const [n, sig] of Object.entries(DM_PROP)) {
      assert.ok(dmXml.includes('name="' + n + '" type="' + sig + '"'), "dbusmenu 属性 " + n + " type " + sig);
    }
    for (const n of Object.keys(DM_METHOD_OUT)) {
      assert.ok(dmXml.includes('name="' + n + '"'), "dbusmenu 方法 " + n + " 存在");
    }
    for (const n of DM_SIGNALS) assert.ok(dmXml.includes('name="' + n + '"'), "dbusmenu 信号 " + n);

    // —— 方法签名与行为:实际调用验证(比 introspection 文本更真实) ——
    const dm = mObj.getInterface("com.canonical.dbusmenu");
    const [rev, rootNode] = await dm.GetLayout(0, -1, []);
    assert.equal(typeof rev, "number", "GetLayout revision u");
    assert.equal(rootNode[0], 0, "GetLayout 根 id=0");
    assert.ok(Array.isArray(rootNode[2]), "根 children 是 av");

    assert.equal(await dm.AboutToShow(0), true, "AboutToShow(0) 返回 b");

    const gp = await dm.GetGroupProperties([1], ["label"]);
    assert.ok(Array.isArray(gp) && gp.length === 1, "GetGroupProperties 数组");
    assert.ok(gp[0][1]["label"] !== undefined && gp[0][1]["enabled"] === undefined, "propertyNames 过滤生效");

    const pv = await dm.GetProperty(1, "label");
    assert.equal(pv.signature, "s", "GetProperty 返回 variant");

    await dm.Event(1, "clicked", new dbus.Variant("s", ""), 0); // 无错

    let threw = false;
    try { await dm.GetProperty(9999, "label"); } catch { threw = true; }
    assert.ok(threw, "GetProperty 未知 id 抛错");

    // SNI 方法:直接调用不抛错即签名可用
    const sni = sniObj.getInterface("org.kde.StatusNotifierItem");
    const P2 = sniObj.getInterface("org.freedesktop.DBus.Properties");
    await sni.Activate(1, 1);
    await sni.SecondaryActivate(1, 1);
    await sni.ContextMenu(1, 1);
    await sni.ProvideXdgActivationToken("tok");
    await sni.Scroll(1, "vertical");
    await P2.Get("org.kde.StatusNotifierItem", "ToolTip");
  } finally {
    try { tray.stop(); } catch {}
    try { menu.stop(); } catch {}
    bus.disconnect();
  }
});