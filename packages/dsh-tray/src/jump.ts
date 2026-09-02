/**
 * 导航决策(§9.4):页面开着(SSE 连接非空)→ 广播导航复用标签;
 * 否则 open() 新开浏览器 + 深链兜底。
 */
import { sessionUrl, workspaceNewSessionUrl } from "./browser.js";
import type { NavChannel } from "./channel.js";

export type JumpTarget =
  | { type: "session"; sessionId: string }
  | { type: "new-session"; workspaceId: string };

export interface JumpOptions {
  baseUrl: string;
  open(url: string): Promise<void>;
}

export class JumpRouter {
  constructor(
    private channel: NavChannel,
    private opts: JumpOptions,
  ) {}

  route(target: JumpTarget): void {
    if (this.channel.open) {
      // 页面开着:广播导航(复用已有标签,不新开)
      this.channel.broadcast(
        target.type === "session"
          ? { type: "navigate", sessionId: target.sessionId }
          : { type: "navigate", workspaceId: target.workspaceId, newSession: true },
      );
      return;
    }
    // 无页面:新开浏览器 + 深链兜底(client 端解析 tray- 参数)
    const url =
      target.type === "session"
        ? sessionUrl(this.opts.baseUrl, target.sessionId)
        : workspaceNewSessionUrl(this.opts.baseUrl, target.workspaceId);
    void this.opts.open(url).catch((err: Error) => {
      console.error("[dsh-tray] 打开浏览器失败:", err.message);
    });
  }
}
