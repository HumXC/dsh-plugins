export const inject = ["tools"];

export function apply(ctx) {
  let previous = "";
  let invoked = false;
  const writeDiagnostic = (payload) => {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  };

  const invokeListRepos = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const result = await ctx.tools.execute({
        callId: "gitnexus-validation-list-repos",
        name: "mcp__gitnexus__list_repos",
        arguments: {},
        signal: controller.signal,
      });

      writeDiagnostic({
        type: "gitnexus-validation-call",
        isError: result.isError,
        errorCode: result.isError ? result.error.code : undefined,
        valueType: result.isError ? undefined : typeof result.value,
        contentBlocks: result.content.length,
      });
    } catch (error) {
      writeDiagnostic({
        type: "gitnexus-validation-call-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const report = () => {
    const names = ctx.tools
      .schemas()
      .map((schema) => schema.name)
      .filter((name) => name.startsWith("mcp__gitnexus__"))
      .sort();

    const signature = names.join("\n");
    if (signature === previous) return;
    previous = signature;

    writeDiagnostic({
      type: "gitnexus-validation-probe",
      toolCount: names.length,
      tools: names,
    });

    if (names.length === 13 && !invoked) {
      invoked = true;
      queueMicrotask(() => void invokeListRepos());
    }
  };

  ctx.on("tools/change", report);
  queueMicrotask(report);
}
