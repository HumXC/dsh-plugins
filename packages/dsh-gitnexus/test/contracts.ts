import type { Context } from "@deepseek-ai/cordis";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { GitNexusToolRowProps } from "../lib/tool-rows.js";
import { apply } from "../lib/browser.js";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

export type ClientContracts = [
  Assert<Equal<GitNexusToolRowProps, ToolCallViewProps>>,
  Assert<Equal<ToolCallViewProps["phase"], "preparing" | "start" | "result">>,
  Assert<Equal<Extract<ToolCallViewProps, { phase: "preparing" }>["block"]["phase"], "preparing">>,
  Assert<Equal<Extract<ToolCallViewProps, { phase: "start" }>["block"]["argsRaw"], string>>,
  Assert<Equal<ReturnType<ToolCallViewProps["useDisclosure"]>["expanded"], boolean>>,
  Assert<Equal<IsAny<ToolCallViewProps["block"]>, false>>,
  Assert<Equal<IsAny<Extract<ToolCallViewProps["block"], { kind: "tool-result" }>["content"][number]>, false>>,
  Assert<Equal<IsAny<Parameters<ToolCallViewProps["loadImage"]>[0]>, false>>,
  Assert<Equal<IsAny<ConvViewProps["sessionId"]>, false>>,
  Assert<Equal<IsAny<Context["slots"]>, false>>,
];

export function checkContracts(
  ctx: Context, props: ToolCallViewProps, image: Parameters<ToolCallViewProps["loadImage"]>[0],
): void {
  apply(ctx);
  props.loadImage(image);
  const disclosure = props.useDisclosure();
  disclosure.setExpanded(false);
  disclosure.toggle();
  if (props.phase === "preparing") {
    // @ts-expect-error Preparing blocks have no dispatched arguments.
    props.block.argsRaw;
    // @ts-expect-error Preparing blocks have no recorded call.
    props.block.call;
  } else if (props.phase === "start") {
    const argsRaw: string = props.block.argsRaw;
    void argsRaw;
  } else {
    const argsRaw: string | undefined = props.block.call?.argsRaw;
    const failed: boolean = props.block.isError;
    void argsRaw;
    void failed;
  }
  // @ts-expect-error Real slot props use the shared session identity.
  props.session_id;
  // @ts-expect-error Block fields must not degrade to any.
  props.block.unknownField;
  // @ts-expect-error Renderer methods must not degrade to any.
  ctx.slots.unknownMethod();
  // @ts-expect-error The shared image loader takes an attachment reference, not a number.
  props.loadImage(123);
}
