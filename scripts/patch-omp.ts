#!/usr/bin/env bun
/**
 * scripts/patch-omp.ts
 *
 * Patches global OMP installations to keep built-in google-antigravity working cleanly:
 * 1. Strips the upstream `disabled` auth rule in `rules.json-*.zst` (added in v18.18.4, PR #18622).
 * 2. Adds the `argon` quota tier (`gemini-4-argon`) to `behavior.quotaTiers` in `rules.json-*.zst`
 *    so Gemini 4 Argon quota exhaustion never blocks shared Gemini (`google`) models.
 * 3. Patches `cli.js` (with `.bak` backup & `--revert` support) to:
 *    - Isolate `gemini-argon-*` buckets in `retrieveUserQuotaSummary` parsing from `google`
 *    - Prevent `resolveOAuth` from dropping `accountAccess` (`enforceAccounts: false`) on
 *      `google-antigravity`, which otherwise routes Pro-only models (e.g. `claude-sonnet-5-5`)
 *      to Plus/Free accounts and triggers 404 NOT_FOUND.
 * 4. Optionally bakes custom Google Cloud OAuth client credentials.
 *
 * Usage:
 *   bun run scripts/patch-omp.ts                                         # Apply patches
 *   bun run scripts/patch-omp.ts --revert                                # Restore original backups
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

interface QuotaTierEntry {
  label: string;
  models: string[];
}

interface QuotaTiersRule {
  provider: string;
  tiers?: QuotaTierEntry[];
  fallbacks?: Array<{ label: string; substring: string }>;
  [key: string]: unknown;
}

interface RulesCatalogData {
  auth?: {
    providers?: AuthProviderEntry[];
    [key: string]: unknown;
  };
  behavior?: {
    quotaTiers?: QuotaTiersRule[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const args = process.argv.slice(2);
const isRevert = args.includes("--revert");

function getArgValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1] ?? null;
  }
  return null;
}

const customClientId = getArgValue("--client-id");
const customClientSecret = getArgValue("--client-secret");

function findAgentDistDir(): string | null {
  const candidates = [
    path.join(process.env.USERPROFILE || "", ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist"),
    path.join(process.env.HOME || "", ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

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

const files = fs.readdirSync(distDir);
const zstFile = files.find((f) => f.startsWith("rules.json-") && f.endsWith(".zst") && !f.endsWith(".bak"));
if (!zstFile) {
  console.error("❌ Could not find rules.json-*.zst inside dist directory.");
  process.exit(1);
}

const zstPath = path.join(distDir, zstFile);
const zstBakPath = zstPath + ".bak";
const cliPath = path.join(distDir, "cli.js");
const cliBakPath = cliPath + ".bak";

if (isRevert) {
  let restoredAny = false;
  if (fs.existsSync(zstBakPath)) {
    fs.copyFileSync(zstBakPath, zstPath);
    console.log(`✅ Restored original rules bundle from ${zstBakPath}`);
    restoredAny = true;
  }
  if (fs.existsSync(cliBakPath)) {
    fs.copyFileSync(cliBakPath, cliPath);
    console.log(`✅ Restored original cli.js from ${cliBakPath}`);
    restoredAny = true;
  }
  if (!restoredAny) {
    console.error("❌ No backups found to revert.");
    process.exit(1);
  }
  process.exit(0);
}

// 1. Patch rules.json-*.zst
if (!fs.existsSync(zstBakPath)) {
  fs.copyFileSync(zstPath, zstBakPath);
  console.log(`📦 Created rules backup: ${zstBakPath}`);
}

try {
  const compressed = fs.readFileSync(zstPath);
  const jsonStr = Bun.zstdDecompressSync(compressed).toString("utf8");
  const data = JSON.parse(jsonStr) as RulesCatalogData;

  const ag = data.auth?.providers?.find((p) => p.id === "google-antigravity");
  if (!ag) {
    console.log("⚠️ google-antigravity not found in auth.providers.");
    process.exit(0);
  }

  let rulesModified = false;

  if (ag.disabled) {
    console.log(`🔧 Removing disabled reason: "${ag.disabled}"`);
    delete ag.disabled;
    rulesModified = true;
  } else {
    console.log("✨ google-antigravity auth rule is already enabled.");
  }

  // Isolate Gemini 4 Argon quota tier from general Gemini ("google") counter
  const agQuotaRule = data.behavior?.quotaTiers?.find((q) => q.provider === "google-antigravity");
  if (agQuotaRule) {
    agQuotaRule.tiers ??= [];
    const existingArgon = agQuotaRule.tiers.find((t) => t.label === "argon");
    if (!existingArgon) {
      agQuotaRule.tiers.push({ label: "argon", models: ["gemini-4-argon"] });
      console.log("🔧 Added 'argon' tier (gemini-4-argon) to google-antigravity quotaTiers.");
      rulesModified = true;
    } else if (!existingArgon.models.includes("gemini-4-argon")) {
      existingArgon.models.push("gemini-4-argon");
      console.log("🔧 Added gemini-4-argon to existing 'argon' quotaTier.");
      rulesModified = true;
    } else {
      console.log("✨ 'argon' quotaTier already configured in rules.json.");
    }
  }

  if (customClientId) {
    if (!ag.login) ag.login = {};
    ag.login.clientId = {
      value: Buffer.from(customClientId).toString("base64"),
      encoding: "base64",
    };
    console.log(`🔑 Injected custom OAuth Client ID: ${customClientId.slice(0, 16)}...`);
    rulesModified = true;
  }

  if (customClientSecret) {
    if (!ag.login) ag.login = {};
    ag.login.clientSecret = {
      value: Buffer.from(customClientSecret).toString("base64"),
      encoding: "base64",
    };
    console.log("🔑 Injected custom OAuth Client Secret.");
    rulesModified = true;
  }

  if (rulesModified) {
    const newBuf = Buffer.from(JSON.stringify(data), "utf8");
    const recompressed = Bun.zstdCompressSync(newBuf);
    fs.writeFileSync(zstPath, recompressed);
    console.log(`💾 Wrote patched ${zstFile} (${recompressed.length} bytes).`);
  }

  const catalogRulesJson = path.resolve(distDir, "..", "..", "pi-catalog", "src", "compat", "rules.json");
  if (fs.existsSync(catalogRulesJson)) {
    const catalogData = JSON.parse(fs.readFileSync(catalogRulesJson, "utf8")) as RulesCatalogData;
    let catModified = false;
    const catAg = catalogData.auth?.providers?.find((p) => p.id === "google-antigravity");
    if (catAg && catAg.disabled) {
      delete catAg.disabled;
      catModified = true;
    }
    const catQuota = catalogData.behavior?.quotaTiers?.find((q) => q.provider === "google-antigravity");
    if (catQuota) {
      catQuota.tiers ??= [];
      if (!catQuota.tiers.some((t) => t.label === "argon")) {
        catQuota.tiers.push({ label: "argon", models: ["gemini-4-argon"] });
        catModified = true;
      }
    }
    if (catModified) {
      fs.writeFileSync(catalogRulesJson, JSON.stringify(catalogData));
      console.log("💾 Synced patch to @oh-my-pi/pi-catalog/src/compat/rules.json");
    }
  }

  // 2. Patch cli.js (Argon quota bucket isolation + strict accountAccess enforcement)
  if (fs.existsSync(cliPath)) {
    if (!fs.existsSync(cliBakPath)) {
      fs.copyFileSync(cliPath, cliBakPath);
      console.log(`📦 Created cli.js backup: ${cliBakPath}`);
    }

    let cliSrc = fs.readFileSync(cliPath, "utf8");
    let cliModified = false;

    // 2a. Separate gemini-argon-* buckets into "argon" counter in built-in summary parser
    const summaryCounterRegex =
      /function ([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)\)\{let ([a-zA-Z0-9_$]+)=\3\.bucketId\?\.toLowerCase\(\)\?\?"",([a-zA-Z0-9_$]+)=\2\?\.displayName\?\.toLowerCase\(\)\?\?"";if\(\4\.startsWith\("gemini-"\)\|\|\5\.includes\("gemini"\)\)return\["google"\];/;
    const summaryMatch = cliSrc.match(summaryCounterRegex);
    if (summaryMatch) {
      const [full, fnName, grpVar, bktVar, bidVar, gnameVar] = summaryMatch;
      const replacement = `function ${fnName}(${grpVar},${bktVar}){let ${bidVar}=${bktVar}.bucketId?.toLowerCase()??"",${gnameVar}=${grpVar}?.displayName?.toLowerCase()??"";if(${bidVar}.startsWith("gemini-argon-")||${gnameVar}.includes("argon"))return["argon"];if(${bidVar}.startsWith("gemini-")||${gnameVar}.includes("gemini"))return["google"];`;
      cliSrc = cliSrc.replace(full, replacement);
      console.log("🔧 Patched cli.js built-in Antigravity summary parser to isolate Argon quota.");
      cliModified = true;
    } else if (cliSrc.includes('.startsWith("gemini-argon-")||') && cliSrc.includes('return["argon"]')) {
      console.log("✨ cli.js built-in Antigravity summary parser already isolates Argon quota.");
    } else {
      console.log("⚠️ Could not locate Antigravity summary parser in cli.js (plugin usage override will still protect runtime).");
    }

    // 2b. Never drop enforceAccounts for google-antigravity in resolveOAuth
    const passesRegex =
      /([a-zA-Z0-9_$]+)=\[\{allowBlocked:!1,enforcePlanRequirement:([a-zA-Z0-9_$]+),enforceAccounts:([a-zA-Z0-9_$]+)\}];if\(\3\)\1\.push\(\{allowBlocked:!1,enforcePlanRequirement:\2,enforceAccounts:!1\}\);if\(\1\.push\(\{allowBlocked:!0,enforcePlanRequirement:\2,enforceAccounts:\3\}\),\2\)\1\.push\(\{allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:\3\}\);if\(\3\)\1\.push\(\{allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:!1\}\);/;
    const passesMatch = cliSrc.match(passesRegex);
    if (passesMatch && passesMatch.index !== undefined) {
      const [full, passesVar, planVar, enforceVar] = passesMatch;
      const before = cliSrc.slice(Math.max(0, passesMatch.index - 15000), passesMatch.index);
      const roMatches = [...before.matchAll(/resolveOAuth\(([a-zA-Z0-9_$]+),/g)];
      const provVar = roMatches.at(-1)?.[1];
      if (provVar) {
        const replacement =
          `${passesVar}=[{allowBlocked:!1,enforcePlanRequirement:${planVar},enforceAccounts:${enforceVar}}];` +
          `if(${enforceVar}&&${provVar}!=="google-antigravity")${passesVar}.push({allowBlocked:!1,enforcePlanRequirement:${planVar},enforceAccounts:!1});` +
          `if(${passesVar}.push({allowBlocked:!0,enforcePlanRequirement:${planVar},enforceAccounts:${enforceVar}}),${planVar})${passesVar}.push({allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:${enforceVar}});` +
          `if(${enforceVar}&&${provVar}!=="google-antigravity")${passesVar}.push({allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:!1});`;
        cliSrc = cliSrc.replace(full, replacement);
        console.log(`🔧 Patched cli.js resolveOAuth (${provVar}) to keep accountAccess strict for google-antigravity (prevents 404s).`);
        cliModified = true;
      }
    } else if (cliSrc.includes('!=="google-antigravity")') && cliSrc.includes("enforcePlanRequirement")) {
      console.log("✨ cli.js resolveOAuth already enforces strict accountAccess for google-antigravity.");
    } else {
      console.log("⚠️ Could not locate resolveOAuth passes block in cli.js.");
    }

    // 2c. Split google-antigravity meters (Gemini / Argon / Claude+GPT) in `omp usage` capacity line
    const meterRegex =
      /function ([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)\)\{if\(\2\.provider!=="anthropic"&&\2\.provider!=="openai-codex"\)return;/;
    const meterMatch = cliSrc.match(meterRegex);
    if (meterMatch) {
      const [full, fnName, repVar, limVar] = meterMatch;
      const replacement =
        `function ${fnName}(${repVar},${limVar}){` +
        `if(${repVar}.provider==="google-antigravity"){` +
        `let _m=${limVar}.id.toLowerCase().split(":")[1];` +
        `return _m==="google"?"gemini":_m==="argon"?"argon":(_m==="anthropic"||_m==="openai")?"claude/GPT":_m;` +
        `}` +
        `if(${repVar}.provider!=="anthropic"&&${repVar}.provider!=="openai-codex")return;`;
      cliSrc = cliSrc.replace(full, replacement);
      console.log("🔧 Patched cli.js usage capacity meter splitting for google-antigravity.");
      cliModified = true;
    } else if (cliSrc.includes('.provider==="google-antigravity"){let _m=')) {
      console.log("✨ cli.js usage capacity meter splitting already patched.");
    } else {
      console.log("⚠️ Could not locate meterForLimit in cli.js.");
    }

    if (cliModified) {
      fs.writeFileSync(cliPath, cliSrc, "utf8");
      console.log("💾 Wrote patched cli.js.");
    }
  }

  console.log("\n🧪 Verifying with 'omp models google-antigravity'...");
  const output = execSync("omp models google-antigravity", { encoding: "utf8" });
  console.log(output);
  console.log("🎉 Antigravity is active and patched!");
} catch (err) {
  console.error("❌ Failed to patch OMP:", err);
  process.exit(1);
}
