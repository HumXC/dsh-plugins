import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ResolvedConfig } from "./config.js";

export const INDEX_STATUS_TOOL = "gitnexus_index_status";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** A grant is a deployment-owned descriptor capability, never a prompt or label. */
export class GitNexusAccess {
  private readonly grants = new WeakMap<Agent, ReadonlySet<string>>();

  constructor(private readonly config: ResolvedConfig) {}

  private grant(agent: Agent): ReadonlySet<string> {
    const cached = this.grants.get(agent);
    if (cached !== undefined) return cached;
    const denied = new Set<string>();
    const session = agent.session;
    const header = session.header;
    if (header.origin !== "subagent" || !header.parentSession ||
        header.agentPreset !== this.config.accessPreset) return denied;
    // Only the first child-owned descriptor is authoritative. Ancestor descriptors
    // in fork seeds, old versions and foreground children must never grant access.
    // The Profile can run a newer Session contract than the plugin's SDK.
    // Require the verified descriptor API instead of accepting a legacy log.
    const source = record(session);
    const snapshot = source?.snapshotEvents;
    const offset = source?.inheritedEventCount;
    if (typeof snapshot !== "function" || typeof offset !== "number" ||
        !Number.isSafeInteger(offset) || offset < 0) return denied;
    const events: unknown = snapshot.call(session, offset);
    if (!Array.isArray(events)) return denied;
    const event = events.map(record).find(event => event?.type === "subagent/descriptor");
    const descriptor = record(event?.data);
    const filter = record(descriptor?.toolFilter);
    const allow = filter?.allow;
    const deny = filter?.deny;
    if (descriptor?.version !== 3 || descriptor.mode !== "continuable" ||
        descriptor.provider !== "spawn" || !Array.isArray(allow) ||
        !allow.every(name => typeof name === "string") ||
        (deny !== undefined && (!Array.isArray(deny) || !deny.every(name => typeof name === "string")))) {
      return denied;
    }
    const grant = new Set(allow.filter(name => !Array.isArray(deny) || !deny.includes(name)));
    if (!grant.has(INDEX_STATUS_TOOL)) return denied;
    this.grants.set(agent, grant);
    return grant;
  }

  private inPreset(agent: Agent): boolean {
    const presets = record(agent.ctx.get("agentPresets"));
    const composedPreset = presets?.composedPreset;
    return typeof composedPreset === "function" &&
      composedPreset.call(presets, agent.ctx) === this.config.accessPreset;
  }

  allows(agent: Agent | undefined, name = INDEX_STATUS_TOOL): boolean {
    if (this.config.accessMode === "all") return true;
    return agent !== undefined && this.inPreset(agent) && this.grant(agent).has(name);
  }

  assert(agent: Agent | undefined, name: string): void {
    if (!this.allows(agent, name)) {
      throw new Error("GitNexus access denied: create a fresh background explore_code child with the explicit index-status grant; main, other roles, legacy and foreground children are not eligible");
    }
  }

  install(ctx: Context, names: readonly string[]): () => void {
    if (this.config.accessMode === "all") return () => {};
    const restricted = new WeakSet<Agent>();
    const disposers: Array<() => void> = [];
    const restrict = (agent: Agent) => {
      if (restricted.has(agent) || !this.inPreset(agent)) return;
      // Existing agents from other presets are not ours. All definitions must
      // be inherited here, so their role filters remain enforceable too.
      if (!names.some(name => ctx.tools.get(name, agent) !== undefined)) return;
      const denied = names.filter(name => !this.allows(agent, name));
      restricted.add(agent);
      try {
        if (denied.length > 0) disposers.push(agent.ctx.tools.restrict({ deny: denied }));
      } catch (error) {
        restricted.delete(agent);
        throw error;
      }
    };
    disposers.push(ctx.tools.guard(exec => {
      if (exec.name === this.config.delegationTool && record(exec.arguments)?.run_in_background === false) {
        return "GitNexus explorer requires run_in_background: true (or omit it); foreground children have no durable capability grant";
      }
      if (names.includes(exec.name) && !this.allows(exec.agent, exec.name)) return "GitNexus capability not granted to this agent";
      return undefined;
    }));
    disposers.push(ctx.on("agent/created", ({ agent }) => {
      restrict(agent);
      return undefined;
    }));
    let reconciling = false;
    const reconcile = () => {
      if (reconciling) return;
      reconciling = true;
      try {
        for (const agent of ctx.get("agents")?.list() ?? []) restrict(agent);
      } finally { reconciling = false; }
    };
    disposers.push(ctx.on("tools/change", reconcile));
    reconcile();
    return () => { for (const dispose of disposers.toReversed()) dispose(); };
  }
}
