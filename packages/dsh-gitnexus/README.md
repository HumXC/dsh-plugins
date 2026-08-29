# dsh-gitnexus

GitNexus integration for DeepSeek Harness Web. The plugin exposes GitNexus MCP tools through DSH's existing tool UI and automatically attaches graph context after selected filesystem/search tool calls.

## Compatibility

- DeepSeek Harness: `0.1.1-rc.2`
- Node.js: 22 or newer
- GitNexus: tested with the `gitnexus mcp` and `gitnexus augment` commands available on `PATH`

GitNexus is a separate runtime dependency and has its own license. Installing this MIT-licensed adapter does not change GitNexus licensing terms.

## Why this plugin routes MCP itself

The official `@deepseek-ai/dsh-mcp-client` owns one static `cwd` per plugin instance. DSH Web can run sessions from several workspaces at once, so a static MCP process can address the wrong repository.

`dsh-gitnexus` instead:

1. discovers the GitNexus MCP tool catalog when the plugin starts;
2. resolves each call from `exec.agent.session.header.cwd`;
3. walks upward to the nearest `.gitnexus` index, falling back to the Git root;
4. keeps one managed MCP process per workspace root;
5. caps and evicts idle connections with an LRU policy;
6. uses DSH's `ctx.subprocess` seam for process trees, cancellation, and credential scrubbing.

The model-facing names remain `mcp__gitnexus__<tool>`, so DSH Web uses its generic tool cards without a dedicated frontend.

## Install into the Web profile

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/dsh-gitnexus
```

Restart `dsh web` after installation. The package's bundle inserts the plugin with the defaults shown in [`bundle.yml`](./bundle.yml).

Before using a repository, build its GitNexus index according to the GitNexus documentation. Automatic augmentation is skipped when no ancestor contains `.gitnexus`.

## Configuration

| Option | Default | Meaning |
| --- | ---: | --- |
| `command` | `gitnexus` | GitNexus executable resolved in the subprocess execution world |
| `args` | `["mcp"]` | Arguments used to start each MCP server |
| `serverName` | `gitnexus` | Namespace in `mcp__<serverName>__<tool>` |
| `autoAugment` | `true` | Attach `gitnexus augment` output after supported tool calls |
| `maxConnections` | `8` | Maximum workspace MCP processes; idle entries are evicted LRU-first |
| `toolCallTimeoutMs` | `60000` | MCP call timeout |
| `augmentTimeoutMs` | `15000` | Per-pattern CLI augmentation timeout |
| `maxAugmentsPerResult` | `3` | Maximum patterns enriched after one tool result |
| `maxSecondaryPatterns` | `2` | Maximum filenames extracted from search output |
| `maxContextChars` | `24000` | Maximum characters injected by one augmentation result |

Automatic augmentation listens to `read`, `grep`, `glob`, and `bash`. It derives primary patterns only from exact DSH `read.file_path` and `grep.pattern` arguments; filenames from DSH search/command output are secondary patterns. This avoids guessing shell semantics from arbitrary Bash source.

Caches are isolated by DSH session and repository root. GitNexus tool calls themselves are excluded from automatic augmentation, so the integration cannot recursively enrich its own output.

## Development

The repository includes a Nix development shell with Node.js and pnpm:

```bash
nix develop "path:$PWD"
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Run the isolated DSH Web validation without changing a profile:

```bash
dsh --profile web \
  --patch ./validation/dsh-gitnexus-plugin.yml \
  --no-open \
  --port 0
```

The validation probe expects the full GitNexus tool catalog and calls `mcp__gitnexus__list_repos` through DSH's `ToolRuntime`.

## Current limits

- MCP tool discovery occurs at plugin activation. Restart DSH after upgrading GitNexus so schemas are rediscovered.
- Workspace routing assumes the DSH process and `ctx.subprocess` provider see the same local filesystem paths.
- A crashed workspace MCP process is discarded and recreated on the next tool call; there is no background reconnect loop.
- The plugin does not add a dedicated Web page or graph visualization.
