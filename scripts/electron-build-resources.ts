/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync } from "fs";
import { join } from "path";
import { copyPiAgentServer, downloadUv, type Arch, type BuildConfig, type Platform } from "./build/common";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

const buildConfig: BuildConfig = {
  platform: process.platform as Platform,
  arch: (process.env.CRAFT_BUILD_ARCH || process.arch) as Arch,
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir: ROOT_DIR,
  electronDir: ELECTRON_DIR,
};

// electron-builder.yml packages resources/pi-agent-server/**, which the packaged
// runtime resolves (runtime-resolver.ts). electron-build-main.ts builds the bundle
// into packages/pi-agent-server/dist; copy it in with koffi for the target arch.
copyPiAgentServer(buildConfig);

// The doc tools in resources/bin run through uv from resources/bin/<platform>-<arch>.
// Only electron-dev.ts downloaded it, so a fresh checkout (CI) packaged an app without
// uv. Skipped when it is already there.
await downloadUv(buildConfig);

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}
