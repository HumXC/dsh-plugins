import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ComponentType } from "react";
import { useState } from "react";
import { DisclosureRow } from "@deepseek-ai/dsh-client-ui-primitives";
import { NATIVE_COMMANDS } from "./commands.js";
import { gitNexusSummary } from "./tool-summary.js";
export { GITNEXUS_TOOL_CSS } from "./tool-row-style.js";

// Mirrors the deployed ui-tool slot contract for the older development SDK.
type ToolCallBlock = { argsRaw: string } | {
  kind: "tool-result";
  call: { argsRaw: string } | null;
  content: readonly ContentBlock[];
  isError: boolean;
};
export interface GitNexusToolRowProps {
  callId: string;
  toolName: string;
  block: ToolCallBlock;
  cwd?: string | undefined;
  home?: string | undefined;
  openFile: (path: string) => void;
  inspect?: (() => void) | undefined;
}
interface ToolSlots {
  inject(key: "tool.call.toolview", callback: () => Iterable<() => void>): () => void;
  register(spec: { name: "tool.call.toolview"; key: string }, view: ComponentType<GitNexusToolRowProps>): () => void;
}

export function GitNexusToolRow({ block, toolName, inspect }: GitNexusToolRowProps) {
  const [open, setOpen] = useState(false);
  const settled = "kind" in block && block.kind === "tool-result";
  const raw = "argsRaw" in block ? block.argsRaw : block.call?.argsRaw ?? "";
  let args: unknown;
  try { args = JSON.parse(raw); } catch { args = undefined; }
  const output = settled ? block.content.map(part => part.type === "text" ? part.text : JSON.stringify(part)).join("\n") : "";
  const failed = settled && block.isError;
  const model = gitNexusSummary(toolName, args, output, failed, settled);
  return <div className="gitnexus-tool-row" data-state={failed ? "error" : settled ? "settled" : "running"}>
    <DisclosureRow
      rowClassName="gitnexus-tool-head"
      titleClassName="gitnexus-tool-title"
      chevronClassName="gitnexus-tool-chevron"
      icon={<svg className="gitnexus-tool-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M6 5h8M5 7v6m2 2h6M15 7v6M7 6l6 8" />
        <circle cx="5" cy="5" r="2" /><circle cx="15" cy="5" r="2" />
        <circle cx="5" cy="15" r="2" /><circle cx="15" cy="15" r="2" />
      </svg>}
      title={model.title}
      open={open}
      expandable
      expandOnRowClick
      keepContentWhenOpen
      onToggle={() => setOpen(!open)}
      collapsedContent={<>
        {model.summary && <><span className="gitnexus-tool-sep" aria-hidden="true" /><span className="gitnexus-tool-summary" title={model.summary}>{model.summary}</span></>}
        {(failed || model.warning) && <span className="gitnexus-tool-warning">{failed ? "失败" : "⚠"}</span>}
      </>}
    >
      <div className="gitnexus-tool-body">
        <div className="gitnexus-tool-io">
          <div className="gitnexus-tool-section"><span className="gitnexus-tool-label">输入</span><span className="gitnexus-tool-text">{raw || "（调用参数不在当前记录中）"}</span></div>
          {settled && <><span className="gitnexus-tool-divider" aria-hidden="true" /><div className="gitnexus-tool-section"><span className="gitnexus-tool-label">输出</span><span className="gitnexus-tool-text" data-error={failed || undefined}>{output || "（空结果）"}</span></div></>}
        </div>
        {inspect && <button type="button" className="gitnexus-tool-inspect" onClick={inspect}>查看轨迹</button>}
      </div>
    </DisclosureRow>
  </div>;
}

export function registerGitNexusToolRows(ctx: Pick<ClientContext, "slots">): void {
  // Isolated SDK-version bridge verified against deployed SlotRegistry.
  const slots = ctx.slots as unknown as ToolSlots;
  slots.inject("tool.call.toolview", function* () {
    for (const command of NATIVE_COMMANDS) {
      yield slots.register({ name: "tool.call.toolview", key: "gitnexus_" + command.name }, GitNexusToolRow);
    }
  });
}
