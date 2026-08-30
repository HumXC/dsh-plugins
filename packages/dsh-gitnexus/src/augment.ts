import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import { AnalysisCoordinator } from "./analysis-coordinator.js";
import type { ResolvedConfig } from "./config.js";
import { augmentationCandidates, isAugmentableTool } from "./patterns.js";
import { resolveWorkspaceRoute, sessionCwd } from "./repository.js";

interface PatternCache {
  augmented: Set<string>;
  empty: Set<string>;
}

type AugmentOutcome =
  | { kind: "hit"; text: string }
  | { kind: "empty" }
  | { kind: "failed" };

type AgentSession = NonNullable<ToolExecution["agent"]>["session"];

export class AutoAugmentController {
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly caches = new WeakMap<
    AgentSession,
    Map<string, PatternCache>
  >();
  private disposeListener: (() => void) | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly analysis = new AnalysisCoordinator(),
  ) {}

  start(): void {
    this.disposeListener = this.ctx.on(
      "tools/post-execute",
      (exec, result, next) => {
        return this.track(this.handle(exec, result, next));
      },
    );
  }

  async dispose(): Promise<void> {
    this.disposeListener?.();
    this.disposeListener = undefined;
    this.lifetime.abort(new Error("dsh-gitnexus: auto augmentation disposed"));
    await Promise.allSettled([...this.active]);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.active.delete(tracked));
    this.active.add(tracked);
    return tracked;
  }

  private async handle(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> {
    const downstream = await next();
    if (downstream.kind !== "accept") return downstream;
    if (this.lifetime.signal.aborted || exec.signal.aborted) return downstream;
    if (result.isError || !isAugmentableTool(exec.name)) return downstream;

    const cwd = sessionCwd(exec.agent);
    const session = exec.agent?.session;
    if (cwd === undefined || typeof session !== "object" || session === null)
      return downstream;

    const route = resolveWorkspaceRoute(cwd);
    if (!route.hasIndex || this.analysis.isRebuilding(route.root)) {
      return downstream;
    }

    const candidates = augmentationCandidates(
      exec.name,
      exec.arguments,
      result.content,
      this.config.maxSecondaryPatterns,
    );
    const cache = this.patternCache(session, route.root);
    const fresh = candidates
      .filter((pattern) => {
        const key = pattern.toLowerCase();
        return !cache.augmented.has(key) && !cache.empty.has(key);
      })
      .slice(0, this.config.maxAugmentsPerResult);
    if (fresh.length === 0) return downstream;

    const outcomes = await Promise.all(
      fresh.map(async (pattern) => ({
        pattern,
        outcome: await this.runAugment(pattern, route.root, exec.signal),
      })),
    );
    for (const { pattern, outcome } of outcomes) {
      const key = pattern.toLowerCase();
      if (outcome.kind === "hit") cache.augmented.add(key);
      if (outcome.kind === "empty") cache.empty.add(key);
    }

    const hits = outcomes.filter(
      (
        entry,
      ): entry is { pattern: string; outcome: { kind: "hit"; text: string } } =>
        entry.outcome.kind === "hit",
    );
    if (hits.length === 0) return downstream;

    const firstHit = hits[0];
    if (firstHit === undefined) return downstream;
    const body =
      hits.length === 1
        ? firstHit.outcome.text
        : hits
            .map(({ pattern, outcome }) => `### ${pattern}\n${outcome.text}`)
            .join("\n\n");
    const message = createUserMessage({
      content: [{ type: "text", text: `[GitNexus graph context]\n${body}` }],
      source: {
        kind: "plugin",
        plugin: "dsh-gitnexus",
        form: "notice",
        summary: `GitNexus context for ${hits.map(({ pattern }) => pattern).join(", ")}`,
      },
    });

    const additionalContexts = [
      ...(downstream.additionalContexts ?? []),
      message,
    ];
    if ("value" in downstream) {
      return { kind: "accept", value: downstream.value, additionalContexts };
    }
    if (downstream.content !== undefined) {
      return {
        kind: "accept",
        content: downstream.content,
        additionalContexts,
      };
    }
    return { kind: "accept", additionalContexts };
  }

  private patternCache(session: AgentSession, root: string): PatternCache {
    let repositories = this.caches.get(session);
    if (repositories === undefined) {
      repositories = new Map();
      this.caches.set(session, repositories);
    }

    let cache = repositories.get(root);
    if (cache === undefined) {
      cache = { augmented: new Set(), empty: new Set() };
      repositories.set(root, cache);
    }
    return cache;
  }

  private async runAugment(
    pattern: string,
    cwd: string,
    callSignal: AbortSignal,
  ): Promise<AugmentOutcome> {
    const timeoutSignal = AbortSignal.timeout(this.config.augmentTimeoutMs);
    const signal = AbortSignal.any([
      callSignal,
      this.lifetime.signal,
      timeoutSignal,
    ]);
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [this.config.command, "augment", pattern],
        cwd,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: this.config.maxContextChars * 4 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 1_000,
        signal,
      });
      const outcome = await handle.done;
      const stdout = handle.collected.stdout?.readFrom(0);
      const stderr = handle.collected.stderr?.readFrom(0).text.trim();
      if (signal.aborted) return { kind: "failed" };
      if (outcome.exitCode !== 0) {
        this.ctx.logger.debug(
          `dsh-gitnexus: augment failed for "${pattern}": ${stderr || `exit ${String(outcome.exitCode)}`}`,
        );
        return { kind: "failed" };
      }
      if (stdout?.lossy === true) {
        this.ctx.logger.warn(
          `dsh-gitnexus: augment output for "${pattern}" exceeded the collection limit`,
        );
        return { kind: "failed" };
      }

      const text = stdout?.text.trim() ?? "";
      if (text.length === 0) return { kind: "empty" };
      if (text.length <= this.config.maxContextChars)
        return { kind: "hit", text };
      return {
        kind: "hit",
        text: `${text.slice(0, this.config.maxContextChars)}\n[GitNexus context truncated]`,
      };
    } catch (error) {
      if (!signal.aborted) {
        this.ctx.logger.debug(
          `dsh-gitnexus: augment process failed for "${pattern}": ${String(error)}`,
        );
      }
      return { kind: "failed" };
    }
  }
}
