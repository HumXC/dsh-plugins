/**
 * "已查看"记账(§6):由托盘自身触发,持久化到 DSH storage(json backend)。
 * 兼容 dsh-storage 的 KvUnit 结构;用最小接口解耦以便单元测试。
 */
import type { ViewedStoreLike } from "./state.js";

export interface KvUnitLike {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>;
  putRecord(table: string, key: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export const VIEWED_TABLE = "viewed";
export // storage-json 的 UNIT_NAME_RE 只允许 [a-z0-9_],连字符非法
const VIEWED_UNIT = "dsh_tray";

export class ViewedStore implements ViewedStoreLike {
  private map = new Map<string, number>();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(private unit: KvUnitLike) {}

  /** 打开并装载既有记录;任何读取失败都容忍(视为空账本,不阻塞托盘)。 */
  static async open(unit: KvUnitLike): Promise<ViewedStore> {
    const store = new ViewedStore(unit);
    try {
      const { tables } = await unit.loadAll();
      const rows = tables[VIEWED_TABLE] ?? {};
      for (const [id, value] of Object.entries(rows)) {
        const at = (value as { at?: unknown } | null | undefined)?.at;
        if (typeof at === "number") store.map.set(id, at);
      }
    } catch (err) {
      // 容忍:文件缺失/损坏时从空账本开始
      console.warn("[dsh-tray] viewed 读取失败,从空账本开始:", (err as Error).message);
    }
    return store;
  }

  lastViewedAt(id: string): number | undefined {
    return this.map.get(id);
  }

  markViewed(id: string, at = Date.now()): void {
    this.map.set(id, at);
    if (this.closed) return;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.unit.putRecord(VIEWED_TABLE, id, { at });
      } catch (err: unknown) {
        console.warn("[dsh-tray] viewed 落盘失败:", (err as Error).message);
      }
    });
  }

  /** 测试/调试:当前账本快照。 */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.map);
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.writeQueue.then(() => this.unit.close());
    }
    return this.closePromise;
  }
}
