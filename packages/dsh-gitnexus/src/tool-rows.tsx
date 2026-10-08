import type { Context } from "@deepseek-ai/cordis";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
export type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
export type {} from "@deepseek-ai/dsh-client-ui-session/client";
import { DisclosureRow } from "@deepseek-ai/dsh-client-ui-primitives";
import { NATIVE_COMMANDS } from "./commands.js";
import { gitNexusSummary } from "./tool-summary.js";
export { GITNEXUS_TOOL_CSS } from "./tool-row-style.js";

export type GitNexusToolRowProps = ToolCallViewProps;

export function GitNexusToolRow(props: GitNexusToolRowProps) {
  const { toolName, inspect, useDisclosure } = props;
  const { expanded: open, toggle } = useDisclosure();
  const settled = props.phase === "result";
  const raw = props.phase === "start" ? props.block.argsRaw
    : props.phase === "result" ? props.block.call?.argsRaw ?? "" : "";
  let args: unknown;
  try { args = JSON.parse(raw); } catch { args = undefined; }
  const output = props.phase === "result" ? props.block.content.map(part => part.type === "text" ? part.text : JSON.stringify(part)).join("\n") : "";
  const failed = props.phase === "result" && props.block.isError;
  const model = gitNexusSummary(toolName, args, output, failed, settled);
  return <div className="gitnexus-tool-row" data-state={failed ? "error" : settled ? "settled" : props.phase === "preparing" ? "preparing" : "running"}>
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
      onToggle={toggle}
      collapsedContent={<>
        {model.summary && <><span className="gitnexus-tool-sep" aria-hidden="true" /><span className="gitnexus-tool-summary" title={props.phase === "preparing" ? "准备中" : model.summary}>{props.phase === "preparing" ? "准备中" : model.summary}</span></>}
        {failed && <span className="gitnexus-tool-warning">失败</span>}
      </>}
    >
      <div className="gitnexus-tool-body">
        <div className="gitnexus-tool-io">
          <div className="gitnexus-tool-section"><span className="gitnexus-tool-label">输入</span><span className="gitnexus-tool-text">{props.phase === "preparing" ? "（准备调用参数）" : raw || "（调用参数不在当前记录中）"}</span></div>
          {settled && <><span className="gitnexus-tool-divider" aria-hidden="true" /><div className="gitnexus-tool-section"><span className="gitnexus-tool-label">输出</span><span className="gitnexus-tool-text" data-error={failed || undefined}>{output || "（空结果）"}</span></div></>}
        </div>
        {inspect && <button type="button" className="gitnexus-tool-inspect" onClick={inspect}>查看轨迹</button>}
      </div>
    </DisclosureRow>
  </div>;
}

export function registerGitNexusToolRows(ctx: Pick<Context, "slots">): void {
  const slots = ctx.slots;
  slots.inject("tool.call.toolview", function* () {
    for (const command of NATIVE_COMMANDS) {
      yield slots.register({ name: "tool.call.toolview", key: "gitnexus_" + command.name }, GitNexusToolRow);
    }
  });
}
