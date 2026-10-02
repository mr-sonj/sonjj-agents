# Sonjj Agents

A fork of [Craft Agents](https://github.com/lukilabs/craft-agents-oss) with a few extra features,
kept in sync with upstream. Everything Craft Agents does works the same here; the
[upstream README](../README.md) is the guide to the app itself.

Sonjj Agents is an independent project. It is not affiliated with or endorsed by Craft Docs Ltd.;
"Craft" and "Craft Agents" are their trademarks.

## What this fork adds

- **Custom skills and sources folders**: a workspace can load them from any folder, for example one
  shared between workspaces or kept in a git repo.
- **Sessions remember the last working directory** you picked.
- **`AGENTS.md` from external working directories** is read when a session works outside the
  workspace folder.
- **Gemini and Vertex AI** accept the tool list.
- **Self-hosted server on the LAN**: plain `ws://` connections, automatic reconnect after sleep,
  unlock or a network change.
- **Its own name, icon and bundle id**, and no updates from Craft's servers.

Each feature lives on its own branch; [FEATURES.md](../FEATURES.md) describes them and
[CHANGELOG.md](../CHANGELOG.md) lists the releases.

## Download

Get the latest build from [Releases](https://github.com/mr-sonj/sonjj-agents/releases/latest):

| System | File |
|---|---|
| macOS, Apple Silicon | `Sonjj-Agents-arm64.dmg` |
| Windows x64 | `Sonjj-Agents-x64.exe` |
| Linux x64 | `Sonjj-Agents-x64.AppImage` |
| Headless server | `Sonjj-Agents-server-linux-x64.tar.gz`, `Sonjj-Agents-server-darwin-arm64.tar.gz` |

There is no Intel Mac build; [build it yourself](#build-from-source) with `build-dmg.sh x64`.
`SHA256SUMS.txt` lists the checksums: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`.

The builds are **not signed**, so the system warns the first time you open them:

- **macOS**: open the app once, then go to System Settings → Privacy & Security and click
  **Open Anyway**. Or, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Sonjj Agents.app"`.
- **Windows**: when SmartScreen stops the installer, click **More info** → **Run anyway**.
- **Linux**: `chmod +x Sonjj-Agents-x64.AppImage`, then run it. Some distributions need `libfuse2`
  for AppImages.

The app does not update itself. **Check for updates** opens the releases page; watch the repository
(Watch → Custom → Releases) to hear about new versions.

### Next to the official app

Sonjj Agents keeps Craft Agents' data folder (`~/.craft-agent`) and `craftagents://` links, so you can
switch between the two without losing workspaces or sessions. Install only one of them on a machine:
with both installed, sign-in links may open the other app.

### Headless server

```bash
mkdir sonjj-agents-server
tar -xzf Sonjj-Agents-server-linux-x64.tar.gz -C sonjj-agents-server
cd sonjj-agents-server
CRAFT_SERVER_TOKEN=$(openssl rand -hex 32) ./start.sh    # this machine only (127.0.0.1)
```

To reach it from other machines, either set up TLS (`CRAFT_RPC_TLS_CERT`, `CRAFT_RPC_TLS_KEY`) or, on
a LAN you trust, accept plain `ws://` explicitly. Without one of the two the server refuses to listen
on a network address, because the token would cross the network in cleartext:

```bash
CRAFT_SERVER_TOKEN=$(openssl rand -hex 32) CRAFT_RPC_HOST=0.0.0.0 ./start.sh --allow-insecure-bind
```

On Linux, `sudo ./install.sh --systemd` sets it up as a service. The service listens on 127.0.0.1
only; to serve the LAN, edit `/etc/systemd/system/craft-server.service` the same way (host, TLS or
`--allow-insecure-bind` on `ExecStart`). The other settings (`CRAFT_*` variables) are the same as
upstream's; see [Remote Server](../README.md#remote-server-headless) in the upstream README. Unlike
the official app, this fork's app can connect to a plain `ws://` server.

## Build from source

You need [Bun](https://bun.sh) 1.3 or later (releases use 1.3.10) and git.

```bash
git clone https://github.com/mr-sonj/sonjj-agents.git   # default branch: mod, every feature
cd sonjj-agents
bun install
bun run electron:start                                  # run the app from source
```

A source checkout still says "Craft Agents": the rename is applied right before packaging, so the
code stays easy to sync with upstream. To build installers like the released ones:

```bash
bun run scripts/apply-branding.ts                       # rewrites the checkout; don't commit it
apps/electron/scripts/build-dmg.sh arm64                # macOS (x64 for Intel)
apps/electron/scripts/build-linux.sh x64                # Linux
powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1   # Windows
bun run scripts/build-server.ts --compress              # headless server for this machine
git checkout -- .                                       # undo the branding afterwards
```

Output lands in `apps/electron/release/` (apps) and `dist/` (server). If electron-builder runs out
of memory on macOS, set `CRAFT_DMG_STAGING=1`. [branding/README.md](../branding/README.md) explains
what the branding step changes.

## Branches

| Branch | What it is |
|---|---|
| `mod` | Default branch: upstream plus every feature. Releases are built from it. |
| `main` | Plain copy of upstream `main`. |
| `feature/*`, `fix/*`, `fork/meta` | One feature each, based on `main`; see [FEATURES.md](../FEATURES.md). |

To take a single feature into your own checkout of Craft Agents, merge its branch. `mod` and the
feature branches are rebuilt (force-pushed) whenever upstream moves, so pull them with
`git pull --rebase` or reset to the remote rather than merging.

To keep your own fork in step with upstream, add upstream as a remote and run the sync script on
`mod`:

```bash
git remote add upstream https://github.com/lukilabs/craft-agents-oss.git
scripts/fork/sync.sh           # update main, rebase each feature branch, rebuild mod
```

## License

Apache License 2.0, like upstream: see [LICENSE](../LICENSE) and [NOTICE](../NOTICE). Report security
issues as described in [SECURITY.md](../SECURITY.md).
