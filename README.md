# DSH plugins workspace

This repository stores multiple DeepSeek Harness plugins as independent packages under `packages/`.

## Packages

- [`dsh-gitnexus`](./packages/dsh-gitnexus): workspace-routed GitNexus MCP tools and automatic graph-context enrichment for DSH Web.

## Development

```bash
nix develop "path:$PWD"
pnpm install
pnpm test
pnpm build
```

Validation-only overlays and probes live under [`validation/`](./validation). They do not modify an installed DSH profile.
