# Features

Changes this fork adds on top of [Craft Agents](https://github.com/lukilabs/craft-agents-oss).
Each feature lives on its own branch, based on `main` (a clean copy of upstream). The default branch
`mod` merges all of them. To take just one feature, merge its branch into your own checkout of upstream.

| Branch | Feature |
|---|---|
| `feature/custom-skills-sources` | Custom skills and sources folders per workspace |
| `feature/custom-tweaks` | New sessions remember the last working directory |
| `feature/agents-md-discovery` | `AGENTS.md` from working directories outside the workspace |
| `fix/gemini-vertex-tool-schemas` | Tool schemas that Gemini and Vertex AI accept |
| `feature/lan-remote-server` | Reliable connection to a self-hosted server on the LAN, local build fixes |
| `feature/fork-branding` | No automatic update to the official Craft Agents release |
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

It also fixes local builds: sub-builds use the running `bun` binary, `pi-agent-server` and the MCP
servers are bundled into the app and the server build, `build-dmg.sh` packages from a staging folder to
avoid running out of memory, and macOS asks for Documents/Desktop/Downloads access properly.

Main files: `packages/server-core/src/transport/client.ts`, `apps/electron/src/preload/bootstrap.ts`,
`apps/electron/src/main/index.ts`, `apps/electron/scripts/build-dmg.sh`, `scripts/`.

## No automatic update to the official release

Branch: `feature/fork-branding`

The app no longer checks the Craft update server on launch, so a modded build does not download the
official release and lose its changes. Manual "Check for updates" still works.

Main files: `apps/electron/src/main/auto-update.ts`, `apps/electron/src/main/index.ts`.
