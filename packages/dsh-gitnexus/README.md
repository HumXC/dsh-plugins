# dsh-gitnexus

DeepSeek Harness integration for [GitNexus](https://github.com/abhigyanpatwari/GitNexus).

The plugin provides:

- eight fixed native DSH tools backed by GitNexus's managed MCP subprocess transport;
- per-session routing to the current workspace;
- automatic graph context after compatible DSH tool results;
- a GitNexus view beside Chat and Trajectory in DSH Web;
- first-time analysis and reanalysis restricted to the current workspace.

## Runtime behavior

| Runtime | Native tools | Automatic context | GitNexus view | `gitnexus serve` |
|---|---:|---:|---:|---:|
| DSH Web | yes | yes | yes | starts lazily when the view opens |
| DSH TUI | yes | yes | no | not started |
| Headless | yes | yes | no | not started |

The browser entry is declared with `platform: web`. The host-side Web companion is activated only when DSH provides both `webServer` and `sessions`; it does not alter TUI or headless interfaces.

## Coding explorer-only mode

Mount the plugin in the user Coding preset (not a global Host row), with:

```yaml
accessMode: explicit-subagent-grant
accessPreset: coding
delegationTool: explore_code
webUi: false
```

Only `explore_code` should receive `gitnexus_index_status` plus its allowed read-only GitNexus names in its configured `toolFilter.allow`. This useful index-directory status tool doubles as a new explicit capability grant: old Worker/reviewer descriptors cannot accidentally qualify. The plugin reads the first child-owned v3 `subagent/descriptor`, requires spawn/continuable lineage, the recorded and currently composed Coding preset, and the explicit grant. Labels, prompts and model-supplied role names never authorize access. Each GitNexus call must also be individually allowed by the descriptor.

Synchronous agent-creation and tool-change reconciliation install real registry restrictions; the same guard controls execution (including nested PTC dispatch), tool bodies and autoaugmentation. Main and other roles receive no GitNexus SDK bindings. Web routes are disabled in this mode. Default `accessMode: all` preserves existing deployments.

Create a **fresh background** explorer (`run_in_background: true`, or omit the field with the Coding continuable default). Foreground calls are rejected: their runtime descriptor lacks the durable capability filter. Legacy children must be replaced, not relabelled. `gitnexus_index_status` reports local metadata presence, **not freshness**. The shell-less explorer requests maintenance through main; main coordinates a Worker running `gitnexus analyze --index-only` and serializes maintenance with graph queries for the same repository. This is model-tool isolation, not an OS sandbox against roles already authorized to use arbitrary shell commands.

The restricted mode targets the verified DSH `0.1.2-alpha.5` descriptor/scope contract; missing descriptor APIs fail closed. `test/access.test.mjs` uses the deployed runtime selected by `DSH_RUNTIME_ROOT` (default the local npm DSH install) for real registry/SDK/PTC tests with synthetic agents and mocked MCP I/O. These are not paid model calls or a real persistence-resume lifecycle test. A source build does not update a running process's cached plugin modules: activate a new loaded generation or restart DSH when authorized, then create fresh children. No restart is performed by this plugin.

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
| `servePort` | First loopback port for plugin-owned `gitnexus serve`; additional workspace services use subsequent ports. An occupied external server is never reused. |
| `serveStartupTimeoutMs` | Maximum wait for a plugin-owned Web service to become compatible. |

The loaded plugin shows the GitNexus conversation option whenever `webUi !== false`, including without a current session or an existing index. DSH's supported `webserver/index-inject` bootstrap channel delivers only `{ webUi: boolean }` through `globalThis.__DSH_GITNEXUS_CONFIG__`; missing or malformed bootstrap data hides the view. No visibility endpoint is queried, and `/gitnexus/capability` is no longer used. Reload the page after host configuration changes; this bootstrap does not promise live configuration HMR.

Opening the view initializes an opaque workspace-bound gateway with `POST /gitnexus/session/open`. A real DSH session and its workspace are required, but a `.gitnexus` directory is not. Unindexed workspaces can start analysis from the view. Native tool rows and their styles remain available even with `webUi: false`.

Each workspace gets a separate owned Web process and local registry. Disposal terminates only owned processes; occupied ports fail closed without terminating external services.

## Workspace-only data access

The session's actual workspace directory is the boundary; routing never ascends to a parent Git repository or index. Existing indexes remain in each repository's .gitnexus directory. The plugin discovers real descendant directories (excluding Git internals, dependency stores and directory symlinks) and regenerates a local registry at <workspace>/.gitnexus/runtime/registry.json; it never reads, copies or rewrites the user's global registry. Native list_repos therefore lists only locally discovered indexes, including indexed descendants. Invalid JSON metadata is omitted so the recovery view can request a local reindex.

Every managed GitNexus MCP, analysis, augmentation and owned Web process receives a per-child GITNEXUS_HOME. The MCP repository allowlist/default environment is explicitly cleared: the local registry is the discovery boundary, and the router validates every exposed native call. This avoids an upstream startup allowlist freezing out a newly analyzed descendant. No raw MCP resources or group tools are exposed. Web API repository selectors are forced to the session workspace and filesystem selectors are independently checked before proxying.

Repository, worktree and explicit source-file selectors are checked against canonical real paths. Outward/dangling selectors and symbolic links in index storage are refused; externally linked Git worktree metadata/common directories/alternates are refused. Before either rename preview or apply, a bounded read-only Cypher preflight validates every distinct graph-derived source path, including normally ignored dependency paths. JSON-encoded path arrays preserve unusual filenames. Unsupported, truncated or incomplete responses and more than 65,536 distinct paths block rename before it reads live source files. Unrelated dependency symlinks do not require a blanket directory scan.

Git subprocesses receive a discovery ceiling, cleared directory/index/shallow/config overrides, disabled global/system configuration and zero injected config entries. Local Git config includes and worktree override declarations are conservatively refused, even if their targets might be inside the workspace; repositories using these features must simplify their configuration to use this isolated integration. Inherited ripgrep configuration is cleared so rename's text-match discovery cannot enable symlink following. Git metadata trees (including index, HEAD, refs, object stores and recursive alternates) are checked through canonical targets with cycle detection; more than 100,000 metadata traversal entries and unsupported quoted pointers fail closed. This metadata validation does not walk dependency/source trees.

This is application-level GitNexus data isolation, not an OS sandbox: dependency loading, trusted indexed contents and concurrent filesystem mutation are not claimed to be contained by a process sandbox. Direct user-run CLI commands require the same GITNEXUS_HOME if they should update this registry; no global shell profile is changed.

The native nested rows reuse DSH's public DisclosureRow; the internal ToolRow is not exported, so input/output rendering uses a small theme-token adapter. Recovery states show workspace basenames, not absolute paths.

## Native tools and migration

The plugin eagerly registers exactly eight native commands with short, handwritten descriptions and supported DSH schemas. There is no lazy tool loading or upstream schema/description pass-through. MCP discovery checks availability; a missing required command fails initialization instead of silently registering a partial set.

| Default name | Purpose |
| --- | --- |
| `gitnexus_list_repos` | List indexed repositories with pagination. |
| `gitnexus_query` | Find execution flows and symbols. |
| `gitnexus_context` | Inspect callers, callees and symbol context. |
| `gitnexus_impact` | Analyze upstream or downstream impact. |
| `gitnexus_detect_changes` | Map Git changes to affected flows. |
| `gitnexus_rename` | Preview or apply a coordinated rename. |
| `gitnexus_cypher` | Run structural graph queries. |
| `gitnexus_api_impact` | Inspect API consumers and handler impact. |

Names use `<serverName>_<rawName>`; custom server names retain normalization and length protection. Except for repository listing, omitted `repo` uses the current workspace root. The v1 schemas intentionally exclude branch selection, repository groups and PDG-specific options. Query accepts `query` and optional `content`, mapped internally to GitNexus's `search_query` and `include_content`.

Results have the canonical shape `{ text: string, data?: JsonValue }`. When present, `data` contains extracted JSON; `text` always retains warnings and evidence. The native UI presents that same result rather than hiding warnings behind parsed data. Treat UNKNOWN risk, lower-bound, partial and truncated results as incomplete evidence, not an all-clear.

The Web client registers keyed tool rows for the default `gitnexus_*` names, including calls nested inside `run_code`; tools using a customized `serverName` prefix currently retain the generic row. Rows show Chinese titles, evidence-backed counts, running/failure states and badges for incomplete evidence or high risk. Expand a row to inspect the raw arguments and full output; this presentation changes neither tool execution nor access control. After client changes, run `npm run build` in this package and refresh the existing GUI; automatic updates require `pnpm run dev:web` in the same DSH checkout (an unrelated watcher does not update this GUI).

Rename defaults to `dry_run: true`. Review the preview and obtain authorization before setting `dry_run: false`, which writes files; analyze the resulting changes afterward. Schema defaults are annotations, not automatic runtime validation.

**Migration:** replace old `mcp__gitnexus__*` names in tool filters, grants and scripts with the corresponding `gitnexus_*` native names. Old MCP names are not aliases. Keep `gitnexus_index_status` as the separate explicit-grant capability marker in restricted mode, grant only the required native commands, and create fresh background children so their durable descriptors contain the new names.

## Validation

Repository-level validation material lives in [`../../validation`](../../validation). It is not part of the published package and does not modify an installed DSH profile unless explicitly used.

Run the package checks with:

```bash
pnpm --filter dsh-gitnexus typecheck
pnpm --filter dsh-gitnexus test
pnpm --filter dsh-gitnexus build
```
