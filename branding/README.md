# Branding

Sonjj Agents is a fork of [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss). Craft's
[trademark policy](../TRADEMARK.md) asks forks to ship under their own name, icon and bundle id, so
release builds are branded here. The source keeps upstream's names so syncing with upstream stays
conflict-free; the rename is applied to a checkout right before building.

```bash
bun run scripts/apply-branding.ts --dry-run   # list what would change
bun run scripts/apply-branding.ts             # rewrite the checkout in place (do not commit the result)
```

Then build as usual (for example `apps/electron/scripts/build-dmg.sh arm64`). The script fails if an
upstream file no longer matches what it expects, so a release cannot silently ship Craft branding;
`bun test scripts/__tests__/apply-branding.test.ts` checks the same rules without writing anything.

## What changes

- Name, bundle id, copyright, author and download file names (`brand.json`), including the build
  scripts that look for those files.
- App icons, the web UI icons and the in-app logo (`assets/`). The macOS 26 asset catalog is removed;
  macOS uses `icon.icns` instead.
- No update feed: `publish` is removed from `electron-builder.yml`. In the source,
  "Check for updates" opens this fork's GitHub releases page instead of contacting Craft.

## What stays

- The `craftagents://` URL scheme, the `~/.craft-agent` data folder and `CRAFT_*` environment
  variables, so switching between this fork and the official app keeps your data.
- Links to the official Craft Agents documentation at thecraftagents.com, and mentions of Craft
  (the documents app) as a source you can connect.

## Changing the artwork

`generate-assets.ts` draws the icons and logos from the pixel grids at its top. Edit them, then run
`bun run branding/generate-assets.ts` and commit `assets/`. It needs no image tools and runs on any OS.
