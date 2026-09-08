/**
 * StatusNotifierItem 服务(§7)。
 * 用 @deltachat/dbus-next(纯 JS fork)在 session bus 上导出
 * org.kde.StatusNotifierItem。属性全部是 getter —— 每次被读取时从
 * callbacks.snapshot() 取最新值,状态变更时由 refresh() 发信号通知 watcher。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dbus = require("@deltachat/dbus-next") as typeof import("@deltachat/dbus-next");

/** dbus-next 未在 types.d.ts 暴露的原型字段(运行时存在)。 */
interface RuntimeIface {
    $name: string;
    $emitter: { emit(event: string, ...args: unknown[]): void };
    $signals?: Record<string, { name: string; signature: string; signatureTree: unknown[] }>;
}

export const SNI_INTERFACE = "org.kde.StatusNotifierItem";
export const SNI_PATH = "/StatusNotifierItem";
// 试验:与能正常弹菜单的 :1.31 一致的最常见惯例路径(排查右键菜单)
export const MENU_PATH = "/StatusNotifierItem/Menu";

export type SniStatus = "Passive" | "Active" | "NeedsAttention";

/** 一次快照 == 图标/tooltip/状态的全部呈现输入。 */
export interface TraySnapshot {
    status: SniStatus;
    /** 图标像素(ARGB32,网络字节序),多尺寸。 */
    pixmap: [number, number, Buffer][];
    tooltipTitle: string;
    tooltipBody: string;
}

export interface TrayCallbacks {
    snapshot(): TraySnapshot;
    /** 用户左键激活图标。 */
    onActivate(x: number, y: number): void;
    /** 中键/二次激活。 */
    onSecondaryActivate(x: number, y: number): void;
    /** 请求上下文菜单(坐标在全局屏幕空间)。 */
    onContextMenu(x: number, y: number): void;
}

class SniInterface extends dbus.interface.Interface {
    constructor(private svc: TrayService) {
        super(SNI_INTERFACE);
    }

    // ---- 方法(§7.3,含 KDE 官方 XML 全集:Activate/SecondaryActivate/ContextMenu/ProvideXdgActivationToken/Scroll) ----
    Activate(x: number, y: number): void {
        this.svc.cb.onActivate(x, y);
    }
    SecondaryActivate(x: number, y: number): void {
        this.svc.cb.onSecondaryActivate(x, y);
    }
    ContextMenu(x: number, y: number): void {
        this.svc.cb.onContextMenu(x, y);
    }
    ProvideXdgActivationToken(token: string): void {
        this.svc.noteXdgToken(token);
    }
    Scroll(_delta: number, _orientation: string): void {
        /* 无滚动语义,按协议 no-op */
    }

    // ---- 属性(动态 getter) ----
    get Category(): string {
        return "ApplicationStatus";
    }
    get Id(): string {
        return "dsh";
    }
    get Title(): string {
        return "DeepSeek Harness";
    }
    get Status(): SniStatus {
        return this.svc.snapshotNow().status;
    }
    // 官方 XML 为 int32(KDE kf5 定义是 i)
    get WindowId(): number {
        return 0;
    }
    // 故意置空:waybar/GTK 对找不到的主题图标名("dsh" 不在任何主题)会显示
    // "缺图标" 紫黑棋盘;我们始终提供字节正确的 IconPixmap,空名强制走 pixmap。
    get IconName(): string {
        return "";
    }
    get IconPixmap(): [number, number, Buffer][] {
        return this.svc.snapshotNow().pixmap;
    }
    get IconThemePath(): string {
        return "";
    }
    get OverlayIconName(): string {
        return "";
    }
    get OverlayIconPixmap(): [number, number, Buffer][] {
        return [];
    }
    get AttentionIconName(): string {
        return "";
    }
    // NeedsAttention 时 waybar 优先 attention 图;填主图避免缺图标占位
    get AttentionIconPixmap(): [number, number, Buffer][] {
        return this.svc.snapshotNow().pixmap;
    }
    get AttentionMovieName(): string {
        return "";
    }
    get ToolTip(): [string, [number, number, Buffer][], string, string] {
        const snap = this.svc.snapshotNow();
        return ["", snap.pixmap, snap.tooltipTitle, snap.tooltipBody];
    }
    get ItemIsMenu(): boolean {
        return false;
    }
    get Menu(): string {
        return MENU_PATH;
    }
}

SniInterface.configureMembers({
    methods: {
        Activate: { inSignature: "ii", outSignature: "" },
        SecondaryActivate: { inSignature: "ii", outSignature: "" },
        ContextMenu: { inSignature: "ii", outSignature: "" },
        ProvideXdgActivationToken: { inSignature: "s", outSignature: "" },
        Scroll: { inSignature: "is", outSignature: "" },
    },
    properties: {
        Category: { signature: "s", access: dbus.interface.ACCESS_READ },
        Id: { signature: "s", access: dbus.interface.ACCESS_READ },
        Title: { signature: "s", access: dbus.interface.ACCESS_READ },
        Status: { signature: "s", access: dbus.interface.ACCESS_READ },
        WindowId: { signature: "i", access: dbus.interface.ACCESS_READ },
        IconThemePath: { signature: "s", access: dbus.interface.ACCESS_READ },
        Menu: { signature: "o", access: dbus.interface.ACCESS_READ },
        ItemIsMenu: { signature: "b", access: dbus.interface.ACCESS_READ },
        IconName: { signature: "s", access: dbus.interface.ACCESS_READ },
        IconPixmap: { signature: "a(iiay)", access: dbus.interface.ACCESS_READ },
        OverlayIconName: { signature: "s", access: dbus.interface.ACCESS_READ },
        OverlayIconPixmap: { signature: "a(iiay)", access: dbus.interface.ACCESS_READ },
        AttentionIconName: { signature: "s", access: dbus.interface.ACCESS_READ },
        AttentionIconPixmap: { signature: "a(iiay)", access: dbus.interface.ACCESS_READ },
        AttentionMovieName: { signature: "s", access: dbus.interface.ACCESS_READ },
        ToolTip: { signature: "(sa(iiay)ss)", access: dbus.interface.ACCESS_READ },
    },
    signals: {
        NewIcon: { signature: "" },
        NewAttentionIcon: { signature: "" },
        NewOverlayIcon: { signature: "" },
        NewMenu: { signature: "" },
        NewToolTip: { signature: "" },
        NewStatus: { signature: "s" },
        NewTitle: { signature: "s" },
    },
});

/** dbus 消息的最小子集(仅 watcher 迟到的 NameOwnerChanged)。 */
interface WatchMsg {
    interface?: string;
    member?: string;
    body?: readonly unknown[];
}

export class TrayService {
    readonly name: string;
    private iface: SniInterface | undefined;
    private busRef: import("@deltachat/dbus-next").MessageBus | undefined;
    private watcherListener: ((msg: WatchMsg) => void) | undefined;
    private lifecycle = 0;
    private readonly registrationTasks = new Set<Promise<void>>();
    private nameLease: {
        bus: import("@deltachat/dbus-next").MessageBus;
        request: Promise<unknown>;
        release?: Promise<void>;
    } | undefined;
    private stopTask: Promise<void> | undefined;
    private registrationAbort = new AbortController();
    private last: { status: SniStatus } = {
        status: "Passive",
    };

    constructor(
        readonly cb: TrayCallbacks,
        pid: number = process.pid,
    ) {
        this.name = "org.kde.StatusNotifierItem-" + pid;
    }

    snapshotNow(): TraySnapshot {
        return this.cb.snapshot();
    }

    /** ProvideXdgActivationToken 落点:当前无消费方,按协议完成调用即可。 */
    noteXdgToken(_token: string): void {
        /* no-op */
    }

    private emit(name: "NewIcon" | "NewAttentionIcon" | "NewToolTip" | "NewStatus" | "NewTitle", result?: unknown): void {
        const iface = this.iface as unknown as RuntimeIface | undefined;
        if (!iface) return;
        const options = iface.$signals?.[name];
        if (!options) return;
        iface.$emitter.emit("signal", options, result);
    }
    private releaseName(lease: {
        bus: import("@deltachat/dbus-next").MessageBus;
        request: Promise<unknown>;
        release?: Promise<void>;
    }): Promise<void> {
        if (!lease.release) {
            lease.release = (async () => {
                try { await lease.request; } catch { /* request failure still needs cleanup */ }
                try { await lease.bus.releaseName(this.name); } catch { /* release is idempotent */ }
            })();
        }
        return lease.release;
    }


    /**
     * 挂到已有 session bus(测试可传入 dbus-run-session 的 bus)。
     * 注意:这里只 export SNI,不向 watcher 注册 —— 注册必须等 Menu 对象
     * (/MenuBar)也 export 后由 notifyWatcher() 完成,否则 waybar 一收到注册
     * 立即 GetAll + 探测 Menu 的 Version 会失败,has_dbus_menu_ 将永久为 false。
     */
    async start(bus: import("@deltachat/dbus-next").MessageBus): Promise<void> {
        if (this.stopTask) await this.stopTask;
        this.registrationAbort = new AbortController();
        const generation = ++this.lifecycle;
        this.busRef = bus;
        let request: Promise<unknown>;
        try {
            request = bus.requestName(this.name, dbus.NameFlag.ALLOW_REPLACEMENT);
        } catch (error) {
            if (this.busRef === bus) this.busRef = undefined;
            throw error;
        }
        const lease = { bus, request };
        this.nameLease = lease;
        let reply: unknown;
        try {
            reply = await request;
        } catch (error) {
            await this.releaseName(lease);
            if (this.nameLease === lease) this.nameLease = undefined;
            if (this.busRef === bus) this.busRef = undefined;
            throw error;
        }
        if (generation !== this.lifecycle) {
            await this.releaseName(lease);
            if (this.nameLease === lease) this.nameLease = undefined;
            if (this.busRef === bus) this.busRef = undefined;
            return;
        }
        if (reply !== dbus.RequestNameReply.PRIMARY_OWNER && reply !== dbus.RequestNameReply.ALREADY_OWNER) {
            await this.releaseName(lease);
            if (this.nameLease === lease) this.nameLease = undefined;
            if (this.busRef === bus) this.busRef = undefined;
            throw new Error("[dsh-tray] StatusNotifier 服务名未获得所有权: " + this.name);
        }
        this.iface = new SniInterface(this);
        bus.export(SNI_PATH, this.iface);
        this.last = { status: "Passive" };
        this.refresh();
    }

    /** 在 Menu 对象就绪后调用:向 watcher 注册(waybar 据此创建 item)。幂等。 */
    async notifyWatcher(bus: import("@deltachat/dbus-next").MessageBus): Promise<void> {
        const generation = this.lifecycle;
        if (!this.registered) {
            this.registered = true;
            await this.watchWatcherAppearance(bus, generation);
        }
        await this.trackRegistration(bus, generation);
    }
    private registered = false;
    private trackRegistration(bus: import("@deltachat/dbus-next").MessageBus, generation: number): Promise<void> {
        const task = this.registerWithWatcher(bus, generation);
        this.registrationTasks.add(task);
        void task.finally(() => this.registrationTasks.delete(task)).catch(() => undefined);
        return task;
    }

    /** 监听 watcher 迟到(托盘先于 host 启动)的场景:出现后补注册。只装一次。 */
    private async watchWatcherAppearance(bus: import("@deltachat/dbus-next").MessageBus, generation: number): Promise<void> {
        if (this.watcherListener) return;
        this.watcherListener = (msg) => {
            if (generation !== this.lifecycle || !this.busRef) return;
            if (msg.interface !== "org.freedesktop.DBus" || msg.member !== "NameOwnerChanged") return;
            const args = msg.body as readonly [string, string, string] | undefined;
            if (args?.[0] === "org.kde.StatusNotifierWatcher" && args[2]) void this.trackRegistration(bus, generation);
        };
        (bus as unknown as { on(e: string, l: (m: WatchMsg) => void): void }).on("message", this.watcherListener);
    }

    /**
     * SNI 规范:item 不仅要拥有 StatusNotifierItem-<pid> 名称,还应主动向
     * watcher 注册(waybar 的 watcher 只响应主动注册;不主动调用时图标不显示)。
     */
    private async registerWithWatcher(bus: import("@deltachat/dbus-next").MessageBus, generation: number): Promise<void> {
        if (generation !== this.lifecycle || !this.busRef) return;
        const signal = this.registrationAbort.signal;
        try {
            let onAbort: (() => void) | undefined;
            const canceled = new Promise<undefined>(resolve => {
                onAbort = () => resolve(undefined);
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
            });
            try {
                if (signal.aborted || generation !== this.lifecycle || !this.busRef) return;
                const obj = await Promise.race([bus.getProxyObject("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher"), canceled]);
                if (obj === undefined || generation !== this.lifecycle || !this.busRef) return;
                const w = obj.getInterface("org.kde.StatusNotifierWatcher") as unknown as {
                    RegisterStatusNotifierItem(service: string): Promise<unknown>;
                };
                if (generation !== this.lifecycle || !this.busRef) return;
                await Promise.race([w.RegisterStatusNotifierItem(this.name), canceled]);
            } finally {
                if (onAbort) signal.removeEventListener("abort", onAbort);
            }
        } catch {
            // watcher 不存在(托盘先于 host 启动)→ 靠 watchWatcherAppearance 兜底
        }
    }

    /** 宿主在状态变化后调用:主动推送信号(host 是渲染器,状态源在我们;
     *  事件驱动到达即代表"状态已变化",无需也不该做像素 diff —— 那正是此前
     *  图标更新不及时的根源)。host 收到信号后会重读属性渲染。 */
    refresh(): void {
        const snap = this.snapshotNow();
        if (snap.status !== this.last.status) {
            this.last.status = snap.status;
            this.emit("NewStatus", snap.status);
            if (this.iface && this.busRef) {
                type SniIfaceArg = Parameters<typeof dbus.interface.Interface.emitPropertiesChanged>[0];
                dbus.interface.Interface.emitPropertiesChanged(
                    this.iface as unknown as SniIfaceArg,
                    { Status: snap.status },
                    [],
                );
            }
        }
        this.emit("NewIcon");
        this.emit("NewToolTip");
    }

    async stop(): Promise<void> {
        if (this.stopTask) return this.stopTask;
        const task = this.stopInternal();
        this.stopTask = task;
        void task.finally(() => {
            if (this.stopTask === task) this.stopTask = undefined;
        }).catch(() => undefined);
        return task;
    }

    private async stopInternal(): Promise<void> {
        this.lifecycle += 1;
        this.registrationAbort.abort();
        await Promise.all([...this.registrationTasks]);
        const lease = this.nameLease;
        const bus = this.busRef;
        const iface = this.iface;
        const listener = this.watcherListener;
        this.iface = undefined;
        this.registered = false;
        this.watcherListener = undefined;
        this.busRef = undefined;
        if (bus && iface) {
            try { bus.unexport(SNI_PATH, iface); } catch { /* already unexported */ }
        }
        if (bus) {
            if (listener) {
                try {
                    (bus as unknown as {
                        off(e: string, l: (m: WatchMsg) => void): void;
                    }).off("message", listener);
                } catch {
                    /* continue to ownership release */
                }
            }
            if (lease) await this.releaseName(lease);
            else {
                try { await bus.releaseName(this.name); } catch { /* release is idempotent */ }
            }
        } else if (lease) {
            await this.releaseName(lease);
        }
        if (this.nameLease === lease) this.nameLease = undefined;
    }
}

