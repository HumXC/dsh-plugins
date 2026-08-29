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
