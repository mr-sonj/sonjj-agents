# Features

Changes this fork (Sonjj Agents) adds on top of [Craft Agents](https://github.com/lukilabs/craft-agents-oss).
Each feature lives on its own branch, based on `main` (a clean copy of upstream). The default branch
`mod` merges all of them. To take just one feature, merge its branch into your own checkout of upstream.

| Branch | Feature |
|---|---|
| `feature/custom-skills-sources` | Custom skills and sources folders per workspace |
| `feature/custom-tweaks` | New sessions remember the last working directory |
| `feature/agents-md-discovery` | `AGENTS.md` from working directories outside the workspace |
| `fix/gemini-vertex-tool-schemas` | Tool schemas that Gemini and Vertex AI accept |
| `feature/lan-remote-server` | Reliable connection to a self-hosted server on the LAN |
| `fix/self-build` | Building and packaging the app yourself, outside the upstream release pipeline |
| `feature/fork-branding` | Release builds named Sonjj Agents, no updates from Craft |
| `fork/meta` | This file and other fork-only files |

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

## Gemini and Vertex AI tool schemas

Branch: `fix/gemini-vertex-tool-schemas`

Session tools and proxied tools produce JSON schemas that Google's APIs accept: every schema has an
object root, and a patch to `pi-ai` makes Vertex use OpenAPI `parameters` and turns `const` into a
single-value `enum`. Without this, Gemini models reject the tool list.

Main files: `packages/session-tools-core/src/tool-defs.ts`,
`packages/pi-agent-server/src/craft-metadata-schema.ts`, `patches/@earendil-works%2Fpi-ai@*.patch`.

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
- `build-win.ps1` is ASCII-only, so Windows PowerShell 5.1 can parse it.
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
