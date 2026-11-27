# Features

Changes this fork (Sonjj Agents) adds on top of [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss).
Each feature lives on its own branch, based on `main` (a clean copy of upstream). The default branch
`mod` merges all of them. To take just one feature, merge its branch into your own checkout of upstream.

| Branch | Feature |
|---|---|
| `feature/custom-skills-sources` | Custom skills and sources folders per workspace |
| `feature/custom-tweaks` | New sessions remember the last working directory |
| `feature/agents-md-discovery` | `AGENTS.md` from working directories outside the workspace |
| `feature/auto-working-directory` | A session's first message picks its project folder from a list you keep |
| `fix/gemini-vertex-tool-schemas` | Tool schemas that Gemini and Vertex AI accept |
| `fix/custom-endpoint-web-search` | Web search that works on custom OpenAI/Anthropic-compatible endpoints |
| `fix/openai-sse-finish-reason` | Tool calls through proxies that end the stream on the last tool chunk |
| `feature/lan-remote-server` | Reliable connection to a self-hosted server on the LAN |
| `fix/self-build` | Building and packaging the app yourself, outside the upstream release pipeline |
| `feature/fork-branding` | Release builds named Sonjj Agents, no updates from Craft |
| `fork/meta` | Fork-only files: README, this file, changelog, release, validation and secret-scan workflows, sync script |

## Custom skills and sources folders

Branch: `feature/custom-skills-sources`

A workspace can load its skills and sources from any folder instead of `<workspace>/skills` and
`<workspace>/sources`, for example a folder shared between workspaces or kept in a git repo. Symlinked
folders work. Set it in **Workspace Settings**; leave it empty to use the default folder.

Main files: `packages/shared/src/workspaces/`, `packages/shared/src/config/watcher.ts`,
`packages/session-tools-core/src/source-helpers.ts`,
`apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx`.

## New sessions remember the last working directory

Branch: `feature/custom-tweaks`

When you pick a folder in a session, the next new session in that workspace starts in the same folder.
The reset button sends new sessions back to the workspace's default working directory, and changing that
default in Workspace Settings clears the remembered folder.

Main files: `packages/server-core/src/sessions/working-directory.ts`,
`packages/server-core/src/sessions/SessionManager.ts`.

## AGENTS.md from external working directories

Branch: `feature/agents-md-discovery`

When a session works in a folder outside the workspace's default working directory, the system prompt
also lists that folder's `AGENTS.md` / `CLAUDE.md`, so the agent follows the project's own instructions.
Discovery depth is limited so large trees stay fast.

Main files: `packages/shared/src/prompts/system.ts`.

## Auto working directory

Branch: `feature/auto-working-directory`

With the decision model on, a new session's first message can move the session to the project folder it
is about before the agent starts, so the project's `AGENTS.md` and the shell's folder are right from the
first turn. Turn it on in **Settings → AI** (toggle **Auto working directory**, off by default) and list
the folders it may pick in **Workspace Settings → Auto working directory**, one `path: when to pick it`
line each; an edit button lets an agent add new project folders and describe them. With no list nothing
moves. A path or a listed folder's name in the message counts first; otherwise the decision model picks,
and the session stays where it is when unsure. It only acts while the session is still in the
workspace's working directory (or one remembered from an earlier session), never after you pick a
folder, and never for task, automation, branch or hidden sessions. A move is never remembered as the
folder for later sessions.

Main files: `packages/server-core/src/decisions/cwd-router.ts`,
`packages/server-core/src/sessions/SessionManager.ts`,
`apps/electron/src/renderer/pages/settings/AutoWorkingDirectoryFolders.tsx`.

## Gemini and Vertex AI tool schemas

Branch: `fix/gemini-vertex-tool-schemas`

Session tools and proxied tools produce JSON schemas that Google's APIs accept: every schema has an
object root, and a patch to `pi-ai` makes Vertex use OpenAPI `parameters` and turns `const` into a
single-value `enum`. Without this, Gemini models reject the tool list.

Main files: `packages/session-tools-core/src/tool-defs.ts`,
`packages/pi-agent-server/src/craft-metadata-schema.ts`, `patches/@earendil-works%2Fpi-ai@*.patch`.

## Web search on custom endpoints

Branch: `fix/custom-endpoint-web-search`

A connection to a custom OpenAI- or Anthropic-compatible endpoint (a local proxy, vLLM, a gateway) is
stored with the provider `openai` or `anthropic` only to pick the auth header format. Upstream's
`web_search` took that as a real OpenAI key: every search sent the endpoint's key to
`api.openai.com`, failed with 401, and only then fell back to DuckDuckGo, with the error in every
result. Custom endpoints now search with DuckDuckGo directly. The OpenAI, OpenRouter and Google presets
keep their provider's own search.

Main files: `packages/pi-agent-server/src/tools/search/resolve-provider.ts`,
`packages/pi-agent-server/src/index.ts`.

## Tool calls through OpenAI-compatible proxies

Branch: `fix/openai-sse-finish-reason`

Some OpenAI-compatible proxies (Gemini behind a CLI proxy, for example) send the last piece of a tool
call's arguments and `finish_reason` in the same stream chunk. Upstream's stream filter held back every
chunk with tool calls, so that chunk was dropped, the SDK never saw `finish_reason`, and the turn
failed with "Connection Error" (`Stream ended without finish_reason`). The filter now sends the tool
calls, then the chunk with its `finish_reason`.

Main files: `packages/shared/src/unified-network-interceptor.ts`, test in
`packages/shared/src/__tests__/unified-network-interceptor.finish-reason.test.ts`.

## Self-hosted server on the LAN

Branch: `feature/lan-remote-server`

For running the headless server on one machine and the desktop app on another:

- The app may connect over plain `ws://` (the CSP only allowed `wss://` and localhost before).
- The app reconnects on its own after the computer wakes from sleep, the screen is unlocked or the
  network comes back. Clicking a disconnected remote workspace reconnects it immediately; the
  cloud-off icon opens the reconnect screen.
- `bun run server:start` reads `.env.server.local` (copy `.env.server.example`).

Main files: `packages/server-core/src/transport/client.ts`, `apps/electron/src/preload/bootstrap.ts`,
`apps/electron/src/main/index.ts`, `apps/electron/src/renderer/components/app-shell/WorkspaceSwitcher.tsx`.

## Building it yourself

Branch: `fix/self-build`

Fixes for building and packaging the app and the server on your own machine instead of the upstream
release pipeline:

- Sub-builds run the same `bun` binary as the parent build, so they work when `bun` is not on `PATH`.
- `pi-agent-server` (with `koffi` for the target architecture) is bundled into the app and the server
  build.
- `build-dmg.sh` makes read-only files from the Bun cache writable before cleaning up. Set
  `CRAFT_DMG_STAGING=1` to package from a staging copy outside the workspace if electron-builder runs out
  of memory scanning the workspace `node_modules`; it is off by default.
- `build-win.ps1` is ASCII-only, so Windows PowerShell 5.1 can parse it, and builds the app with
  `electron:build` like the macOS and Linux scripts, so the installer includes the Pi agent server and
  the WhatsApp worker.
- Packaged apps include `uv`, which the document tools (PDF, Office, markitdown) run on; it used to be
  downloaded only by the dev build.
- The Pi agent server and `uv` are packaged once, not a second time under `dist/resources`.
- The renderer build dedupes the Radix menu packages, so dropdown menus from the shared UI package work
  in a Bun workspace build.
- macOS shows a proper prompt for Documents, Desktop and Downloads access.

Main files: `scripts/`, `apps/electron/scripts/build-dmg.sh`, `apps/electron/scripts/build-win.ps1`,
`apps/electron/vite.config.ts`, `apps/electron/electron-builder.yml`.

## Sonjj Agents branding, no updates from Craft

Branch: `feature/fork-branding`

Craft's trademark policy asks forks to ship under their own name, so release builds are named
**Sonjj Agents**, with their own icon and bundle id (`com.sonjj.agents`). The source keeps upstream's
names so it stays easy to sync; `scripts/apply-branding.ts` applies `branding/` to a checkout right
before building. See `branding/README.md`.

The app never contacts the Craft update server, so a modded build cannot be replaced by the official
release: it does not check on launch, and "Check for updates" opens this fork's GitHub releases page.
Data stays in `~/.craft-agent`, shared with the official app.

Main files: `branding/`, `scripts/apply-branding.ts`, `apps/electron/src/main/auto-update.ts`,
`apps/electron/src/main/index.ts`.

## Fork files and releases

Branch: `fork/meta`

Files that exist only in this fork and touch nothing from upstream:

- `.github/README.md`, the repository's front page (GitHub shows it instead of upstream's `README.md`).
- `CHANGELOG.md`, one section per release.
- `.github/workflows/release.yml`: a tag `v<upstream version>-mod.<n>` on `mod` builds the macOS,
  Windows, Linux and server packages with the branding applied and publishes them with
  `SHA256SUMS.txt`, only if that commit passes `fork-validate.yml`. Run it by hand for a dry run that
  keeps the files as workflow artifacts.
- `.github/workflows/fork-validate.yml` runs upstream's validation suite and every test file the fork's
  commits add or change, on pushes to `mod`, pull requests, and before a release is published.
- `.github/workflows/gitleaks.yml` scans this fork's commits for secrets on every push and pull request.
- `scripts/fork/sync.sh` updates `main` from upstream, rebases each feature branch and rebuilds `mod`;
  when nothing changed it keeps the existing `mod` commit, so `--push` has nothing to force-push.
  Tested by `scripts/fork/__tests__/sync.test.ts`.
