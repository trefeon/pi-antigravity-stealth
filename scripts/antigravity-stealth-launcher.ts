#!/usr/bin/env bun
/**
 * scripts/antigravity-stealth-launcher.ts
 *
 * Transparent launcher for Oh My Pi (OMP) that emulates official Google Antigravity Hub/CLI signatures.
 *
 * Capabilities:
 * 1. Dynamically syncs the latest Antigravity version and changelist (CL) from Google's manifest.
 * 2. Injects stealth environment variables:
 *    - PI_AI_ANTIGRAVITY_VERSION (e.g. "2.30.0")
 *    - PI_AI_ANTIGRAVITY_CL (e.g. "6386428939206656")
 *    - PI_AI_ANTIGRAVITY_OS ("windows", "darwin", "linux")
 *    - PI_AI_ANTIGRAVITY_ARCH ("amd64", "arm64")
 * 3. Supports private custom Google Cloud OAuth client credentials (ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET)
 *    to prevent account restrictions caused by public shared client ID pools.
 * 4. Transparently passes all arguments, stdio, and exit codes to omp.
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

const MANIFEST_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const FALLBACK_VERSION = "2.30.0";
const FALLBACK_CL = "6386428939206656";

interface ManifestInfo {
  version: string;
  changelist: string;
}

async function fetchLatestManifest(timeoutMs = 3000): Promise<ManifestInfo> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(MANIFEST_URL, {
      headers: {
        "User-Agent": "electron-builder",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { version: FALLBACK_VERSION, changelist: FALLBACK_CL };
    }

    const text = await res.text();
    let version = FALLBACK_VERSION;
    let changelist = FALLBACK_CL;

    // Parse version from YAML
    const vMatch = text.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m);
    if (vMatch && vMatch[1]) {
      version = vMatch[1];
    }

    // Extract changelist from URL if present (e.g. /2.30.0-6386428939206656/)
    const clMatch = text.match(/[0-9]+\.[0-9]+\.[0-9]+-([0-9]+)/);
    if (clMatch && clMatch[1]) {
      changelist = clMatch[1];
    }

    return { version, changelist };
  } catch {
    return { version: FALLBACK_VERSION, changelist: FALLBACK_CL };
  }
}

function resolvePlatform(): { os: string; arch: string } {
  let os = "linux";
  if (process.platform === "win32") os = "windows";
  else if (process.platform === "darwin") os = "darwin";

  let arch = "amd64";
  if (process.arch === "arm64") arch = "arm64";

  return { os, arch };
}

async function main() {
  const { version, changelist } = await fetchLatestManifest();
  const { os, arch } = resolvePlatform();

  // Prepare environment
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_AI_ANTIGRAVITY_VERSION: process.env.PI_AI_ANTIGRAVITY_VERSION || version,
    PI_AI_ANTIGRAVITY_CL: process.env.PI_AI_ANTIGRAVITY_CL || changelist,
    PI_AI_ANTIGRAVITY_OS: process.env.PI_AI_ANTIGRAVITY_OS || os,
    PI_AI_ANTIGRAVITY_ARCH: process.env.PI_AI_ANTIGRAVITY_ARCH || arch,
  };

  // Check for local .env or ~/.omp/antigravity.env for custom client credentials
  const envFiles = [
    path.resolve(process.cwd(), ".env"),
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".omp", "antigravity.env"),
  ];

  for (const envFile of envFiles) {
    if (fs.existsSync(envFile)) {
      try {
        const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/^\s*(ANTIGRAVITY_CLIENT_[A-Z_]+)\s*=\s*(.*?)\s*$/);
          if (match && match[1] && match[2]) {
            const val = match[2].replace(/^["']|["']$/g, "");
            if (!env[match[1]]) {
              env[match[1]] = val;
            }
          }
        }
      } catch {}
    }
  }

  // Find omp executable
  const ompBin = process.platform === "win32" ? "omp.exe" : "omp";

  const child = spawn(ompBin, process.argv.slice(2), {
    env,
    stdio: "inherit",
    shell: true,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

main().catch((err) => {
  console.error("Launcher error:", err);
  process.exit(1);
});
