#!/usr/bin/env bun
/**
 * scripts/patch-omp.ts
 *
 * Automatically patches global OMP installations to re-enable google-antigravity.
 * Strips the upstream `disabled` auth rule added in v18.18.4 (PR #18622).
 * Optionally patches custom Google Cloud OAuth client credentials to avoid shared-pool bans.
 *
 * Usage:
 *   bun run scripts/patch-omp.ts                                  # Apply un-pause patch
 *   bun run scripts/patch-omp.ts --revert                         # Restore original backup
 *   bun run scripts/patch-omp.ts --client-id <id> --client-secret <sec>  # Bake custom OAuth credentials
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

interface AuthProviderEntry {
  id: string;
  disabled?: string;
  login?: {
    clientId?: { value: string; encoding?: string };
    clientSecret?: { value: string; encoding?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RulesCatalogData {
  auth?: {
    providers?: AuthProviderEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const args = process.argv.slice(2);
const isRevert = args.includes("--revert");

function getArgValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

const customClientId = getArgValue("--client-id");
const customClientSecret = getArgValue("--client-secret");

function findAgentDistDir(): string | null {
  const candidates = [
    // Windows Bun
    path.join(process.env.USERPROFILE || "", ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist"),
    // Unix Bun
    path.join(process.env.HOME || "", ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Fallback: resolve from which omp
  try {
    const cmd = process.platform === "win32" ? "where omp" : "which omp";
    const which = execSync(cmd, { encoding: "utf8" }).trim().split("\n")[0];
    if (which) {
      const real = fs.realpathSync(which);
      const dist = path.resolve(path.dirname(real), "..", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist");
      if (fs.existsSync(dist)) return dist;
    }
  } catch {}

  return null;
}

const distDir = findAgentDistDir();
if (!distDir) {
  console.error("❌ Could not locate @oh-my-pi/pi-coding-agent dist directory.");
  process.exit(1);
}

console.log(`🔍 Found OMP dist directory: ${distDir}`);

// Find the rules.json-*.zst file
const files = fs.readdirSync(distDir);
const zstFile = files.find(f => f.startsWith("rules.json-") && f.endsWith(".zst") && !f.endsWith(".bak"));

if (!zstFile) {
  console.error("❌ Could not find rules.json-*.zst inside dist directory.");
  process.exit(1);
}

const zstPath = path.join(distDir, zstFile);
const bakPath = zstPath + ".bak";

if (isRevert) {
  if (fs.existsSync(bakPath)) {
    fs.copyFileSync(bakPath, zstPath);
    console.log(`✅ Restored original bundle from ${bakPath}`);
  } else {
    console.error(`❌ No backup found at ${bakPath}`);
  }
  process.exit(0);
}

// Backup if first time
if (!fs.existsSync(bakPath)) {
  fs.copyFileSync(zstPath, bakPath);
  console.log(`📦 Created backup: ${bakPath}`);
}

// Decompress, patch, recompress
try {
  const compressed = fs.readFileSync(zstPath);
  const jsonStr = Bun.zstdDecompressSync(compressed).toString("utf8");
  const data = JSON.parse(jsonStr) as RulesCatalogData;

  const ag = data.auth?.providers?.find(p => p.id === "google-antigravity");
  if (!ag) {
    console.log("⚠️ google-antigravity not found in auth.providers.");
    process.exit(0);
  }

  let modified = false;

  if (ag.disabled) {
    console.log(`🔧 Removing disabled reason: "${ag.disabled}"`);
    delete ag.disabled;
    modified = true;
  } else {
    console.log("✨ google-antigravity is already enabled (no 'disabled' field found).");
  }

  // Handle custom OAuth client ID / secret injection
  if (customClientId) {
    if (!ag.login) ag.login = {};
    ag.login.clientId = {
      value: Buffer.from(customClientId).toString("base64"),
      encoding: "base64",
    };
    console.log(`🔑 Injected custom OAuth Client ID: ${customClientId.slice(0, 16)}...`);
    modified = true;
  }

  if (customClientSecret) {
    if (!ag.login) ag.login = {};
    ag.login.clientSecret = {
      value: Buffer.from(customClientSecret).toString("base64"),
      encoding: "base64",
    };
    console.log("🔑 Injected custom OAuth Client Secret.");
    modified = true;
  }

  if (modified) {
    const newBuf = Buffer.from(JSON.stringify(data), "utf8");
    const recompressed = Bun.zstdCompressSync(newBuf);
    fs.writeFileSync(zstPath, recompressed);
    console.log(`💾 Successfully re-compressed and wrote ${zstFile} (${recompressed.length} bytes).`);
  }

  // Also patch source rules.json in pi-catalog if available
  const catalogRulesJson = path.resolve(distDir, "..", "..", "pi-catalog", "src", "compat", "rules.json");
  if (fs.existsSync(catalogRulesJson)) {
    const catalogData = JSON.parse(fs.readFileSync(catalogRulesJson, "utf8")) as RulesCatalogData;
    const catAg = catalogData.auth?.providers?.find(p => p.id === "google-antigravity");
    if (catAg && catAg.disabled) {
      delete catAg.disabled;
      fs.writeFileSync(catalogRulesJson, JSON.stringify(catalogData));
      console.log("💾 Also patched @oh-my-pi/pi-catalog/src/compat/rules.json");
    }
  }

  // Verify with omp models
  console.log("\n🧪 Verifying with 'omp models google-antigravity'...");
  const output = execSync("omp models google-antigravity", { encoding: "utf8" });
  console.log(output);
  console.log("🎉 Antigravity is active and ready!");
} catch (err) {
  console.error("❌ Failed to patch rules bundle:", err);
  process.exit(1);
}
