# Changelog

Releases of Sonjj Agents. A version is `<Craft Agents version>-mod.<n>`: the upstream release it is
built on, then a counter for this fork's releases on top of it. Changes that come from upstream are in
the [Craft Agents releases](https://github.com/craft-ai-agents/craft-agents-oss/releases); each feature is
described in [FEATURES.md](FEATURES.md). A release with no section here has a short generated
note on its [release page](https://github.com/mr-sonj/sonjj-agents/releases).

## 0.14.0-mod.1

First release, built on Craft Agents 0.14.0.

- Workspaces can load skills and sources from any folder, including a symlinked one.
- New sessions start in the folder you last picked; reset goes back to the workspace default.
- Sessions working outside the workspace folder read that folder's `AGENTS.md` / `CLAUDE.md`.
- Gemini and Vertex AI accept the tool list.
- The app connects to a self-hosted server over plain `ws://` on the LAN and reconnects after sleep,
  unlock or a network change.
- Builds are named Sonjj Agents, with their own icon and bundle id, and never update from Craft's
  servers. "Check for updates" opens this repository's releases page.
- Downloads: macOS Apple Silicon (`.dmg`, `.zip`), Windows x64 (`.exe`), Linux x64 (`.AppImage`),
  and the headless server for Linux x64 and macOS Apple Silicon. Builds are not signed; see the README
  for opening them.
