# GitNexus MCP validation

These overlays validate GitNexus integration in DSH Web without changing the installed profile.

- `gitnexus-mcp.yml` exercises the official `@deepseek-ai/dsh-mcp-client` with one fixed repository.
- `dsh-gitnexus-plugin.yml` exercises the built workspace-routed plugin from `packages/dsh-gitnexus`.

## Official bridge

```bash
dsh --profile web \
  --patch ./validation/gitnexus-mcp.yml \
  --no-open \
  --port 0
```

The overlay also loads `tool-schema-probe.mjs`. The probe reports the registered `mcp__gitnexus__*` schemas and invokes `mcp__gitnexus__list_repos` once through DSH's `ToolRuntime`.

A successful run contains:

```text
{"type":"gitnexus-validation-probe","toolCount":13,...}
{"type":"gitnexus-validation-call","isError":false,...}
```

Use this command to validate composition without starting the server:

```bash
dsh --profile web \
  --patch ./validation/gitnexus-mcp.yml \
  --dump-config
```

The fixed `cwd` in this overlay is only for repository-level validation.

## Workspace-routed plugin

Build the package, then load its compiled entry point through the validation overlay:

```bash
pnpm --filter dsh-gitnexus build

dsh --profile web \
  --patch ./validation/dsh-gitnexus-plugin.yml \
  --no-open \
  --port 0
```

This path validates dynamic tool discovery, the managed DSH subprocess transport, workspace connection creation, and one `list_repos` call. It reached all 13 GitNexus tools during the initial implementation validation.

## Web workspace view

A direct `file://.../lib/index.js` overlay validates the host plugin but does not install the package metadata that advertises its browser entry. Use an isolated DSH home for the complete Web check:

```bash
validation_home="$(mktemp -d)"
DSH_HOME="$validation_home" dsh plugin --profile web add \
  /home/HumXC/dsh-plugins/packages/dsh-gitnexus
DSH_HOME="$validation_home" dsh --profile web --no-open --port 14567
```

Then open `http://127.0.0.1:14567`, create or open a conversation rooted in the intended workspace, and verify:

1. **GitNexus** appears beside **Chat** and **Trajectory**.
2. An unindexed workspace offers only **Analyze current workspace**.
3. Analysis progress, cancellation, failure, and retry remain inside that workspace.
4. Analysis uses `gitnexus analyze --index-only`; verify it does not create `AGENTS.md`, `CLAUDE.md`, or harness skill directories.
5. A ready workspace opens its graph without a repository selector.
6. Requests for another repository, clone/delete, embeddings, MCP, upload, and unknown APIs are rejected by the DSH gateway.

The package tests cover opaque view tokens, two-workspace isolation, forced repository inputs, index-only analysis, restricted APIs, analysis cancellation, service ownership, and asset compatibility. The browser check confirms DSH slot composition and the upstream GitNexus UI bundle.
