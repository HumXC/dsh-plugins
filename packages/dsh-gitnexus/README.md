# dsh-gitnexus

DeepSeek Harness integration for [GitNexus](https://github.com/abhigyanpatwari/GitNexus).

The plugin provides:

- all GitNexus MCP tools through DSH's managed subprocess transport;
- per-session routing to the current workspace;
- automatic graph context after compatible DSH tool results;
- a GitNexus view beside Chat and Trajectory in DSH Web;
- first-time analysis and reanalysis restricted to the current workspace.

## Runtime behavior

| Runtime | MCP tools | Automatic context | GitNexus view | `gitnexus serve` |
|---|---:|---:|---:|---:|
| DSH Web | yes | yes | yes | starts lazily when the view opens |
| DSH TUI | yes | yes | no | not started |
| Headless | yes | yes | no | not started |

The browser entry is declared with `platform: web`. The host-side Web companion is activated only when DSH provides both `webServer` and `sessions`; it does not alter TUI or headless interfaces.

## Requirements

- Node.js 22 or newer
- DSH `0.1.1-rc.2` compatible packages
- `gitnexus` available on `PATH`
- GitNexus Web `>=1.6.5 <1.7.0`

The Web version range is intentionally conservative because the plugin rewrites and proxies GitNexus's bundled Web application. Unsupported assets fail closed with an actionable error instead of rendering a partially compatible page.

## Build and install

From the workspace root:

```bash
pnpm install
pnpm --filter dsh-gitnexus test
pnpm --filter dsh-gitnexus build

dsh plugin --profile web add \
  /home/HumXC/dsh-plugins/packages/dsh-gitnexus
```

Then restart DSH Web:

```bash
dsh web
```

The package's `bundle.yml` installs the host plugin. Its package metadata exposes the Web-only browser entry automatically.

## GitNexus Web view

Open **GitNexus** beside **Chat** and **Trajectory** in a conversation.

- If the current workspace is unindexed, the view offers **Analyze current workspace**.
- Analysis runs `gitnexus analyze --index-only` against the host-resolved workspace, so it updates the graph index without generating `AGENTS.md`, `CLAUDE.md`, or harness skill files.
- While analysis runs, it shows progress and permits cancellation.
- If an index is stale, the existing graph remains available and reanalysis is offered.
- Reanalysis requires confirmation and temporarily pauses GitNexus MCP calls and automatic augmentation for that workspace only.
- On success, the view automatically opens the current workspace graph.

The view never accepts a path, remote URL, or repository name from the browser. The host resolves `session.header.cwd`, canonicalizes it, and forces that workspace into every allowed GitNexus request.

### Isolation and safety

- Browser routes use short-lived opaque view tokens bound to live DSH sessions.
- `/api/repos` exposes only the current workspace.
- Repository query/body fields are overwritten server-side.
- Clone, delete, embedding, MCP, upload, and unknown GitNexus APIs are denied.
- Only analysis jobs created for the current workspace can be read or cancelled.
- The upstream service binds to `127.0.0.1` and is reached through a same-origin DSH gateway.
- A restrictive CSP prevents the embedded page from connecting around the gateway.
- GitNexus local-storage keys are namespaced per view token.

## Configuration

The bundle defaults are:

```yaml
command: gitnexus
args:
  - mcp
serverName: gitnexus
autoAugment: true
maxConnections: 8
toolCallTimeoutMs: 60000
augmentTimeoutMs: 15000
maxAugmentsPerResult: 3
maxSecondaryPatterns: 2
maxContextChars: 24000
webUi: auto
servePort: 4747
serveStartupTimeoutMs: 15000
```

Web-specific settings:

| Setting | Meaning |
| --- | --- |
| `webUi: auto` | Enable only when DSH Web services are available. |
| `webUi: false` | Disable the Web view and GitNexus Web service entirely. |
| `webUi: true` | Enable the Web companion whenever DSH Web services are available. |
| `servePort` | Loopback port for `gitnexus serve`; an already-running compatible server is reused but never owned. |
| `serveStartupTimeoutMs` | Maximum wait for a plugin-owned Web service to become compatible. |

When the plugin owns the GitNexus Web process, it terminates that process during disposal. A reused process is left running.

## Tool names

MCP tools follow DSH's official namespace format:

```text
mcp__gitnexus__query
mcp__gitnexus__context
mcp__gitnexus__impact
```

The double underscores delimit the MCP and server namespaces. GitNexus's raw tool name retains its own single underscores.

## Validation

Repository-level validation material lives in [`../../validation`](../../validation). It is not part of the published package and does not modify an installed DSH profile unless explicitly used.

Run the package checks with:

```bash
pnpm --filter dsh-gitnexus typecheck
pnpm --filter dsh-gitnexus test
pnpm --filter dsh-gitnexus build
```
