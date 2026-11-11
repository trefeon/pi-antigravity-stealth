#!/usr/bin/env bun
/**
 * scripts/antigravity-stealth-launcher.ts
 *
 * Transparent launcher for Oh My Pi (OMP) that emulates official Google Antigravity Hub/CLI signatures.
 *
 * Capabilities:
 * 1. Dynamically syncs the latest Antigravity version and changelist (CL) from Google's manifest.
 * 2. Injects stealth environment variables:
 *    - PI_AI_ANTIGRAVITY_VERSION (e.g. "2.31.0")
 *    - PI_AI_ANTIGRAVITY_CL (e.g. "6379060755038208")
 *    - PI_AI_ANTIGRAVITY_OS ("windows", "darwin", "linux")
 *    - PI_AI_ANTIGRAVITY_ARCH ("amd64", "arm64")
 * 3. Supports private custom Google Cloud OAuth client credentials (ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET)
 *    via `.env` or `~/.omp/antigravity.env`.
 * 4. Transparently passes all arguments, stdio, and exit codes to omp.
 */

import { spawn } from "node:child_process";
import { loadAntigravityEnvFiles } from "../src/auth.ts";
import { getLiveHubVersion, resolvePlatform } from "../src/manifest.ts";

async function main() {
  loadAntigravityEnvFiles();

  const { version, changelist } = await getLiveHubVersion(3000);
  const { os, arch } = resolvePlatform();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_AI_ANTIGRAVITY_VERSION: process.env.PI_AI_ANTIGRAVITY_VERSION || version,
    PI_AI_ANTIGRAVITY_CL: process.env.PI_AI_ANTIGRAVITY_CL || changelist,
    PI_AI_ANTIGRAVITY_OS: process.env.PI_AI_ANTIGRAVITY_OS || os,
    PI_AI_ANTIGRAVITY_ARCH: process.env.PI_AI_ANTIGRAVITY_ARCH || arch,
  };

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
