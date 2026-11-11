#!/usr/bin/env bun
/**
 * scripts/patch-omp.ts
 *
 * Patches global OMP installations to keep google-antigravity Argon quota isolation,
 * capacity meter splitting, and strict accountAccess working across OMP updates.
 *
 * Usage:
 *   bun run scripts/patch-omp.ts                                         # Apply patches
 *   bun run scripts/patch-omp.ts --revert                                # Restore original backups
 *   bun run scripts/patch-omp.ts --client-id <id> --client-secret <sec>  # Bake custom OAuth credentials
 */

import { execSync } from "node:child_process";
import { applyOmpPatch, revertOmpPatch } from "../src/omp-patch.ts";

const args = process.argv.slice(2);
const isRevert = args.includes("--revert");

function getArgValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1] ?? null;
  }
  return null;
}

if (isRevert) {
  const res = revertOmpPatch();
  for (const line of res.details) console.log(line);
  if (res.status !== "reverted") {
    process.exit(1);
  }
  console.log("✅ Reverted OMP patch from backups.");
  process.exit(0);
}

const customClientId = getArgValue("--client-id");
const customClientSecret = getArgValue("--client-secret");

const res = applyOmpPatch({
  clientId: customClientId,
  clientSecret: customClientSecret,
  force: true,
});

if (res.distDir) {
  console.log(`🔍 Found OMP dist directory: ${res.distDir} (v${res.ompVersion ?? "unknown"})`);
}
for (const line of res.details) {
  console.log(`  • ${line}`);
}

if (res.status === "failed" || res.status === "unavailable" || res.status === "locked") {
  console.error(`❌ OMP patch ${res.status}.`);
  process.exit(1);
}

console.log("\n🧪 Verifying with 'omp models google-antigravity'...");
const output = execSync("omp models google-antigravity", { encoding: "utf8" });
console.log(output);
console.log("🎉 Antigravity is active and patched!");
