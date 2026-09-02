/**
 * DBusMenu 服务(§8,com.canonical.dbusmenu)。
 * 与 TrayService 共享同一个 service name,挂在 /MenuBar。
 * GetLayout 每次调用即时构建(数据量小,简单可靠);revision 变更时发 LayoutUpdated。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dbus = require("@deltachat/dbus-next") as typeof import("@deltachat/dbus-next");
import type { Variant } from "@deltachat/dbus-next";

import { MENU_PATH } from "./tray.js";

export const MENU_IFACE = "com.canonical.dbusmenu";

/** 菜单节点(宿主构建)。 */
export interface MenuNode {
  id: number;
  label: string;
  enabled?: boolean;
  /** 菜单图标:系统主题图标名(DBusMenu icon-name 属性;不传图像文件)。 */
  iconName?: string;
  children?: MenuNode[];
  /** 与菜单点击绑定的业务载荷(session id 等),Event 回调时带回。 */
  data?: string;
  /** 分隔线项。 */
  separator?: boolean;
}

export interface MenuCallbacks {
  /** 当前菜单树(顶层根项)。 */
  getRoot(): MenuNode[];
  /** 菜单项被点击等。 */
  onEvent(id: number, eventId: string, data: unknown): void;
}

interface RuntimeIface2 {
  $name: string;
  $emitter: { emit(event: string, ...args: unknown[]): void };
  $signals?: Record<string, { name: string; signature: string; signatureTree: unknown[] }>;
}

/** 根节点(id=0)属性:libdbusmenu 会查询它(label/enabled/visible/children-display)。 */
export function rootProps(): Record<string, Variant<unknown>> {
  return {
    label: new dbus.Variant("s", ""),
    visible: new dbus.Variant("b", true),
    "children-display": new dbus.Variant("s", "submenu"),
  };
}

/** 节点属性表(a{sv},variant 值)。 */
function propsOf(node: MenuNode): Record<string, Variant<unknown>> {
  const props: Record<string, Variant<unknown>> = {
    label: new dbus.Variant("s", node.label),
    enabled: new dbus.Variant("b", node.enabled !== false),
    visible: new dbus.Variant("b", true),
  };
  // libdbusmenu:icon-data 属性类型是 'ay'(裸 RGBA 字节),不是 a(iiay)!
  if (node.iconName) {
    // 系统主题图标名:库通过图标主题加载,无需图像数据
    props["icon-name"] = new dbus.Variant("s", node.iconName);
  }
  if (node.children?.length) {
    // libdbusmenu 对带子菜单的项会告警 "child-display ... (null)";显式声明
    props["children-display"] = new dbus.Variant("s", "submenu");
  }
  if (node.separator) {
    props.type = new dbus.Variant("s", "separator");
  }
  return props;
}

/**
 * 递归构建 GetLayout 用的节点结构 [id, props, children]。
 * 协议官方 XML:children 是 av(array of variant),每个元素是 Variant 包裹的
 * (ia{sv}av) 结构体 —— 早期草案用 ai,必须用 av(KDE/waybar 按 av 解)。
 */
function toStruct(node: MenuNode, depth: number): [number, Record<string, Variant<unknown>>, Variant<unknown>[]] {
  const children =
    depth === 0
      ? []
      : (node.children ?? []).map((c) => {
          const s = toStruct(c, depth > 0 ? depth - 1 : depth);
          return new dbus.Variant("(ia{sv}av)", s);
        });
  return [node.id, propsOf(node), children];
}

class MenuInterface extends dbus.interface.Interface {
  constructor(private svc: DbusMenuService) {
    super(MENU_IFACE);
  }

  // ---- 方法(官方 XML 全集) ----
  /**
   * 规范(官方 XML out: u 与 (ia{sv}av)):
   *  - parentId=0:返回 "u revision + 单个根结构体(id=0, props={}, children=全部顶层菜单项)"
   *  - parentId>0:返回该子树(节点本身 + 按深度递归的 children)
   * 这里必须返回单个 (ia{sv}av),而不是数组 —— libdbusmenu/quickshell 都按
   * "(u(ia{sv}av))" 严格解析,返回数组会报 "Getting layout failed"。
   */
  GetLayout(parentId: number, recursionDepth: number, _propertyNames: string[]): [number, unknown[]] {
    const depth = recursionDepth < 0 ? -1 : recursionDepth;
    if (parentId !== 0) {
      const node = this.svc.nodes().find((n) => n.id === parentId);
      if (!node) return [this.svc.revision, [0, {}, []]];
      return [this.svc.revision, toStruct(node, depth < 0 ? -1 : depth)];
    }
    // 根 children = getRoot() 顶层项(勿用递归扁平的 nodes():会把子项错误提升为顶层)
    const top = this.svc.cb.getRoot();
    const rootChildren = top.map((n) => new dbus.Variant("(ia{sv}av)", toStruct(n, depth < 0 ? -1 : depth)));
    return [this.svc.revision, [0, rootProps(), rootChildren]];
  }

  GetGroupProperties(ids: number[], propertyNames: string[]): [number, Record<string, Variant<unknown>>][] {
    const nodes = this.svc.nodes();
    const list: [number, MenuNode | null][] =
      ids.length === 0
        ? nodes.map((n) => [n.id, n] as [number, MenuNode])
        : ids.map((id) => [id, nodes.find((n) => n.id === id) ?? null]);
    // 协议:propertyNames 非空时只返回请求的属性
    const filter = (props: Record<string, Variant<unknown>>): Record<string, Variant<unknown>> => {
      if (propertyNames.length === 0) return props;
      const out: Record<string, Variant<unknown>> = {};
      for (const k of propertyNames) if (props[k] !== undefined) out[k] = props[k];
      return out;
    };
    return list.map(([id, node]) => [id, filter(node ? propsOf(node) : rootProps())]);
  }

  /** 批量事件:逐条派发,返回无法识别的 id(实现无失败项,恒空)。 */
  EventGroup(events: [number, string, unknown, number][]): number[] {
    for (const [id, eventId, data] of events) {
      this.svc.cb.onEvent(id, eventId, data);
    }
    return [];
  }

  /** 批量"即将显示":本实现无延迟加载,恒不要求更新。 */
  AboutToShowGroup(ids: number[]): [number[], number[]] {
    void ids;
    return [[], []];
  }

  /** 单项"即将显示":根或父项有子项即认为需要重绘(客户端据此发 GetLayout)。 */
  AboutToShow(parentId: number): boolean {
    const nodes = this.svc.nodes();
    const root = nodes.find((n) => n.id === parentId);
    if (!root) return nodes.length > 0;
    return (root.children?.length ?? 0) > 0;
  }

  GetProperty(id: number, name: string): Variant<unknown> {
    if (id === 0) {
      const p0 = rootProps();
      const v0 = p0[name];
      if (!v0) throw new dbus.DBusError("org.freedesktop.DBus.Error.InvalidArgs", "no such property: " + name);
      return v0;
    }
    const node = this.svc.nodes().find((n) => n.id === id);
    if (!node) throw new dbus.DBusError("org.freedesktop.DBus.Error.InvalidArgs", "no such menu id: " + id);
    const props = propsOf(node);
    const v = props[name];
    if (!v) throw new dbus.DBusError("org.freedesktop.DBus.Error.InvalidArgs", "no such property: " + name);
    return v;
  }

  Event(id: number, eventId: string, data: unknown, timestamp: number): void {
    this.svc.cb.onEvent(id, eventId, data);
    void timestamp;
  }

  // ---- 属性(官方 XML 全集:Version/TextDirection/Status/IconThemePath) ----
  get Version(): number {
    return 3;
  }
  get TextDirection(): string {
    return "auto";
  }
  get Status(): string {
    return "normal";
  }
  get IconThemePath(): string[] {
    return [];
  }
}

MenuInterface.configureMembers({
  methods: {
    // 官方 XML:GetLayout 返回 (u revision, a(ia{sv}av) layout) —— 两个输出值!
    // 注意绝不能写成 "(ua(ia{sv}av))" 单 struct:libdbusmenu 严格按 (u(ia{sv}av))
    // 解析,多包一层会报 "返回类型 (ua(ia{sv}av)) 但预期 (u(ia{sv}av))" 且菜单不显示。
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "aias", outSignature: "a(ia{sv})" },
    GetProperty: { inSignature: "is", outSignature: "v" },
    Event: { inSignature: "isvu", outSignature: "" },
    EventGroup: { inSignature: "a(isvu)", outSignature: "ai" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
    AboutToShowGroup: { inSignature: "ai", outSignature: "aiai" },
  },
  properties: {
    Version: { signature: "u", access: dbus.interface.ACCESS_READ },
    TextDirection: { signature: "s", access: dbus.interface.ACCESS_READ },
    Status: { signature: "s", access: dbus.interface.ACCESS_READ },
    IconThemePath: { signature: "as", access: dbus.interface.ACCESS_READ },
  },
  signals: {
    // 官方 XML:LayoutUpdated(u revision, i parent);ItemsPropertiesUpdated(a(ia{sv}) a(ias));ItemActivationRequested(i u)
    LayoutUpdated: { signature: "ui" },
    ItemsPropertiesUpdated: { signature: "a(ia{sv})a(ias)" },
    ItemActivationRequested: { signature: "iu" },
  },
});

export class DbusMenuService {
  private ifaceRef: MenuInterface | undefined;
  private busRef: import("@deltachat/dbus-next").MessageBus | undefined;
  private revisionValue = 1;

  constructor(readonly cb: MenuCallbacks) {}

  get revision(): number {
    return this.revisionValue;
  }

  /** 当前菜单树(扁平化全部节点以便按 id 查找)。 */
  nodes(): MenuNode[] {
    const flat: MenuNode[] = [];
    const walk = (list: MenuNode[]): void => {
      for (const n of list) {
        flat.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(this.cb.getRoot());
    return flat;
  }

  async start(bus: import("@deltachat/dbus-next").MessageBus): Promise<void> {
    this.busRef = bus;
    this.ifaceRef = new MenuInterface(this);
    bus.export(MENU_PATH, this.ifaceRef);
  }

  private dirtyTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 菜单内容变化:节流合并后 revision+1 并广播 LayoutUpdated(revision u, parent i)。
   * 会话事件频率可能很高,若不节流,每次事件都广播会导致 waybar 的 dbusmenu-gtk
   * 持续重建菜单、无法稳定显示(revision 会暴涨到数千)。
   */
  markDirty(): void {
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = undefined;
      this.revisionValue += 1;
      const iface = this.ifaceRef as unknown as RuntimeIface2 | undefined;
      const options = iface?.$signals?.LayoutUpdated;
      if (iface && options) {
        iface.$emitter.emit("signal", options, [this.revisionValue, 0]);
      }
    }, 200);
  }

  stop(): void {
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    if (this.busRef && this.ifaceRef) {
      try {
        this.busRef.unexport(MENU_PATH, this.ifaceRef);
      } catch {
        /* ignore */
      }
      this.ifaceRef = undefined;
    }
  }
}