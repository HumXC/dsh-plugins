/**
 * 浏览器打开与深链(§9.2/§10):open() 新开 web + tray- 前缀深链。
 * base URL 优先级:config.webBaseUrl > env DSH_WEB_URL > 127.0.0.1:webServer.port。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// open ^11(DSH 官方 dsh-web-app 同款):Linux 内部走 xdg-open
// open v11 为 ESM default 导出,require() 拿到 namespace 后取 .default
const open = (require("open") as { default: typeof import("open")["default"] }).default;

export interface BaseSource {
  webBaseUrl?: string;
  port: number;
}

export function resolveBaseUrl(src: BaseSource): string {
  const prefer = src.webBaseUrl?.trim() || process.env.DSH_WEB_URL?.trim();
  if (prefer) return prefer.replace(/\/+$/, "");
  return "http://127.0.0.1:" + src.port;
}

/** 会话深链(激活图标/菜单点击)。 */
export function sessionUrl(base: string, sessionId: string): string {
  return base + "/?tray-session=" + encodeURIComponent(sessionId);
}

/** 在某工作区新建会话的深链。 */
export function workspaceNewSessionUrl(base: string, workspaceId: string): string {
  return base + "/?tray-workspace=" + encodeURIComponent(workspaceId) + "&tray-new=1";
}

/** 打开浏览器(默认应用)。 */
export async function openInBrowser(url: string): Promise<void> {
  await open(url);
}
