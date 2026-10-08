# DSH plugins workspace

This repository stores maintained DeepSeek Harness plugins as independent packages under `packages/`.

## Packages

- [`dsh-gitnexus`](./packages/dsh-gitnexus): workspace-routed GitNexus tools, automatic graph context, and a current-workspace-only GitNexus view for DSH Web.
- [`dsh-openpencil-workspace`](./packages/dsh-openpencil-workspace): an OpenPencil conversation tab, local `.op` navigation, and optional Better Sidebar integration. Its official-plugin patch is managed separately by the package scripts.

The local `packages/dsh-tray` and `packages/dsh-magic-context` directories are no longer maintained. They are ignored by Git and excluded from the pnpm workspace, including recursive builds, tests, and dependency resolution.

## Development

Requires Node >=24.11.0 and pnpm 11.15.0. The Nix development shell supplies Node 24.

```bash
nix develop "path:$PWD"
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm-workspace.yaml` keeps one version-scoped `packageExtensions` entry: the published Conversation UI declarations in DSH `0.2.0-rc.2` reference `@deepseek-ai/dsh-attachment` without declaring it as a dependency. This supplies the missing package without patching upstream files.

Validation-only overlays and probes live under [`validation/`](./validation). They do not modify an installed DSH profile.
