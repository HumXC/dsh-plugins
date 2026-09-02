/**
 * 浏览器导航通道(§9.3):SSE 事件流。
 * 页面对着 /plugins/dsh-tray/events 长连接;host 有导航需求时:
 *   - 有连接(页面开着)→ 广播 navigate(浏览器复用标签导航,不新开);
 *   - 无连接 → 由 JumpRouter 走 open() 新开(深链兜底)。
 * 只做导航,绝不参与状态(用户定案:状态 host 全自给)。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type RegisterFn = (route: {
  kind: "exact";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}) => () => void;

export interface NavigatePayload {
  type: "navigate";
  sessionId?: string;
  workspaceId?: string;
  newSession?: boolean;
}

export class NavChannel {
  private conns = new Set<ServerResponse>();
  private disposer: (() => void) | undefined;

  constructor(
    readonly path: string,
    register: RegisterFn,
  ) {
    this.disposer = register({
      kind: "exact",
      path,
      handler: (req, res) => this.handle(req, res),
    });
  }

  private handle(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // 首次写 retry 让 EventSource 断线重连节奏显式化
    res.write("retry: 2000\n\n");
    this.conns.add(res);
    res.on("close", () => {
      this.conns.delete(res);
    });
    void _req;
  }

  /** 有页面开着(SSE 连接非空)。 */
  get open(): boolean {
    return this.conns.size > 0;
  }

  get size(): number {
    return this.conns.size;
  }

  /** 广播导航负载给所有连接。 */
  broadcast(payload: NavigatePayload): void {
    const data = "data: " + JSON.stringify(payload) + "\n\n";
    for (const res of this.conns) {
      try {
        res.write(data);
      } catch {
        this.conns.delete(res);
      }
    }
  }

  dispose(): void {
    for (const res of this.conns) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    this.disposer?.();
    this.disposer = undefined;
  }
}
