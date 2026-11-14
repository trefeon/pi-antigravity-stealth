/**
 * src/omp-patch.ts
 *
 * Idempotent, race-safe patcher for global @oh-my-pi/pi-coding-agent installs.
 * Survives `omp update` cycles by checking an inexpensive file-stat receipt at startup
 * and atomically re-applying patches whenever OMP replaces `cli.js` or `rules.json-*.zst`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { defaultUpdateStatePath } from "./updater.ts";

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

interface QuotaFallbackEntry {
  label: string;
  substring: string;
}

interface QuotaTiersRule {
  provider: string;
  tiers?: QuotaTierEntry[];
  fallbacks?: QuotaFallbackEntry[];
  [key: string]: unknown;
}
interface CompiledVariantFamily {
  provider: string;
  id: string;
  name: string;
  members: string[];
  defaultMember?: string;
  retiredMembers?: string[];
  routing: Record<string, string>;
  mode?: string;
  efforts?: string[];
  effortBudgets?: Record<string, number>;
  defaultLevel?: string;
  requiresEffort?: boolean;
  suppressWhenOff?: boolean;
  preserveAbsentEffortRoutes?: boolean;
  extraAliases?: string[];
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
  taxonomy?: {
    collapse?: {
      variantFamilies?: CompiledVariantFamily[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface OmpPatchState {
  version: 1;
  ompVersion: string | null;
  distDir: string;
  zstFile: string;
  cliSize: number;
  cliMtimeMs: number;
  patchedAt: number;
  reverted: boolean;
  lastError: string | null;
}

export type OmpPatchStatusKind =
  | "patched"
  | "already-patched"
  | "reverted"
  | "unpatched"
  | "unavailable"
  | "skipped"
  | "locked"
  | "failed";

export interface OmpPatchResult {
  status: OmpPatchStatusKind;
  distDir?: string;
  ompVersion?: string | null;
  details: string[];
  changed: boolean;
}

export interface OmpPatchOptions {
  distDir?: string;
  rootsOverride?: string[];
  statePath?: string;
  clientId?: string | null;
  clientSecret?: string | null;
  force?: boolean;
  now?: () => number;
}

export interface CliCompatibilityReport {
  summary: "unpatched" | "patched" | "missing";
  resolveOAuth: "unpatched" | "patched" | "missing";
  meter: "unpatched" | "patched" | "missing";
  compatible: boolean;
}

const LOCK_STALE_MS = 60_000;

const SUMMARY_COUNTER_REGEX =
  /function ([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)\)\{let ([a-zA-Z0-9_$]+)=\3\.bucketId\?\.toLowerCase\(\)\?\?"",([a-zA-Z0-9_$]+)=\2\?\.displayName\?\.toLowerCase\(\)\?\?"";if\(\4\.startsWith\("gemini-"\)\|\|\5\.includes\("gemini"\)\)return\["google"\];/;

const PASSES_REGEX =
  /([a-zA-Z0-9_$]+)=\[\{allowBlocked:!1,enforcePlanRequirement:([a-zA-Z0-9_$]+),enforceAccounts:([a-zA-Z0-9_$]+)\}];if\(\3\)\1\.push\(\{allowBlocked:!1,enforcePlanRequirement:\2,enforceAccounts:!1\}\);if\(\1\.push\(\{allowBlocked:!0,enforcePlanRequirement:\2,enforceAccounts:\3\}\),\2\)\1\.push\(\{allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:\3\}\);if\(\3\)\1\.push\(\{allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:!1\}\);/;

const METER_REGEX =
  /function ([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)\)\{if\(\2\.provider!=="anthropic"&&\2\.provider!=="openai-codex"\)return;/;

const requireFromHere = createRequire(import.meta.url);

export function defaultPatchStatePath(): string {
  return path.join(path.dirname(defaultUpdateStatePath()), "pi-antigravity-patch.json");
}

function readObjectProp(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return Reflect.get(obj, key);
}

export function getZstdFns(): {
  decompress: (buf: Uint8Array) => Buffer;
  compress: (buf: Uint8Array) => Buffer;
} | null {
  const bunVal = readObjectProp(globalThis, "Bun");
  const bunDecompress = readObjectProp(bunVal, "zstdDecompressSync");
  const bunCompress = readObjectProp(bunVal, "zstdCompressSync");
  if (typeof bunDecompress === "function" && typeof bunCompress === "function") {
    return {
      decompress: (buf) => Buffer.from(bunDecompress.call(bunVal, buf) as Uint8Array),
      compress: (buf) => Buffer.from(bunCompress.call(bunVal, buf) as Uint8Array),
    };
  }
  const zDecompress = readObjectProp(zlib, "zstdDecompressSync");
  const zCompress = readObjectProp(zlib, "zstdCompressSync");
  if (typeof zDecompress === "function" && typeof zCompress === "function") {
    return {
      decompress: (buf) => Buffer.from(zDecompress.call(zlib, buf) as Uint8Array),
      compress: (buf) => Buffer.from(zCompress.call(zlib, buf) as Uint8Array),
    };
  }
  return null;
}

function isExpectedAgentPkg(pkgDir: string): boolean {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    return readObjectProp(pkg, "name") === "@oh-my-pi/pi-coding-agent";
  } catch {
    return false;
  }
}

function readAgentVersion(distDir: string): string | null {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.resolve(distDir, "..", "package.json"), "utf8"));
    const version = readObjectProp(pkg, "version");
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

export function resolvePatchTargetDistDir(rootsOverride?: string[]): string | null {
  if (rootsOverride) {
    for (const root of rootsOverride) {
      const pkgDir = path.join(root, "pi-coding-agent");
      const candidate = path.join(pkgDir, "dist");
      if (fs.existsSync(candidate) && isExpectedAgentPkg(pkgDir)) {
        return candidate;
      }
    }
    return null;
  }

  // 1. Running OMP entrypoint (skip if entrypoint is inside a local dev repo's node_modules unless no global exists)
  if (process.argv[1]) {
    try {
      const realArgv = fs.realpathSync(process.argv[1]);
      const dir = path.dirname(realArgv);
      const pkgDir = path.resolve(dir, "..");
      if (isExpectedAgentPkg(pkgDir) && fs.existsSync(path.join(pkgDir, "dist"))) {
        return path.join(pkgDir, "dist");
      }
    } catch {}
  }

  // 2. Standard global Bun install path
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    const pkgDir = path.join(home, ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
    const dist = path.join(pkgDir, "dist");
    if (fs.existsSync(dist) && isExpectedAgentPkg(pkgDir)) {
      return dist;
    }
  }

  // 3. Binary on PATH (e.g. npm/pnpm global symlink)
  try {
    const cmd = process.platform === "win32" ? "where omp" : "which omp";
    const found = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)[0];
    if (found) {
      const real = fs.realpathSync(found);
      const pkgDir = path.resolve(path.dirname(real), "..", "node_modules", "@oh-my-pi", "pi-coding-agent");
      const dist = path.join(pkgDir, "dist");
      if (fs.existsSync(dist) && isExpectedAgentPkg(pkgDir)) {
        return dist;
      }
    }
  } catch {}

  // 4. Local require fallback (only if it has dist/cli.js)
  try {
    const pkgJson = requireFromHere.resolve("@oh-my-pi/pi-coding-agent/package.json");
    const pkgDir = path.dirname(pkgJson);
    const dist = path.join(pkgDir, "dist");
    if (fs.existsSync(path.join(dist, "cli.js")) && isExpectedAgentPkg(pkgDir)) {
      return dist;
    }
  } catch {}

  return null;
}

export function findRulesBundleFile(distDir: string): string | null {
  try {
    return (
      fs
        .readdirSync(distDir)
        .find((f) => f.startsWith("rules.json-") && f.endsWith(".zst") && !f.endsWith(".bak")) ?? null
    );
  } catch {
    return null;
  }
}

export function checkCliCompatibility(cliSrc: string): CliCompatibilityReport {
  const summaryPatched =
    (cliSrc.includes('.startsWith("gemini-argon-")||') && cliSrc.includes('return["argon"]')) ||
    cliSrc.includes('.startsWith("gemini-argon-")');
  const summary: CliCompatibilityReport["summary"] = summaryPatched
    ? "patched"
    : SUMMARY_COUNTER_REGEX.test(cliSrc)
    ? "unpatched"
    : "missing";

  const resolvePatched =
    cliSrc.includes('!=="google-antigravity")') && cliSrc.includes("enforcePlanRequirement");
  const resolveOAuth: CliCompatibilityReport["resolveOAuth"] = resolvePatched
    ? "patched"
    : PASSES_REGEX.test(cliSrc)
    ? "unpatched"
    : "missing";

  const meterPatched = cliSrc.includes('.provider==="google-antigravity"){let _m=');
  const meter: CliCompatibilityReport["meter"] = meterPatched
    ? "patched"
    : METER_REGEX.test(cliSrc)
    ? "unpatched"
    : "missing";

  return {
    summary,
    resolveOAuth,
    meter,
    compatible: summary !== "missing" && resolveOAuth !== "missing" && meter !== "missing",
  };
}

export function patchCliSource(cliSrc: string): { source: string; changed: boolean; details: string[] } {
  let out = cliSrc;
  let changed = false;
  const details: string[] = [];

  // 1. Separate gemini-argon-* buckets into "argon" counter in built-in summary parser
  const summaryMatch = out.match(SUMMARY_COUNTER_REGEX);
  if (summaryMatch) {
    const [full, fnName, grpVar, bktVar, bidVar, gnameVar] = summaryMatch;
    const replacement = `function ${fnName}(${grpVar},${bktVar}){let ${bidVar}=${bktVar}.bucketId?.toLowerCase()??"",${gnameVar}=${grpVar}?.displayName?.toLowerCase()??"";if(${bidVar}.startsWith("gemini-argon-")||${gnameVar}.includes("argon"))return["argon"];if(${bidVar}.startsWith("gemini-")||${gnameVar}.includes("gemini"))return["google"];`;
    out = out.replace(full, replacement);
    details.push("Patched cli.js built-in Antigravity summary parser to isolate Argon quota.");
    changed = true;
  } else if (
    (out.includes('.startsWith("gemini-argon-")||') && out.includes('return["argon"]')) ||
    out.includes('.startsWith("gemini-argon-")')
  ) {
    details.push("cli.js built-in Antigravity summary parser already isolates Argon quota.");
  } else {
    details.push("Could not locate Antigravity summary parser in cli.js (plugin usage override still protects runtime).");
  }

  // 2. Never drop enforceAccounts for google-antigravity in resolveOAuth
  const passesMatch = out.match(PASSES_REGEX);
  if (passesMatch && passesMatch.index !== undefined) {
    const [full, passesVar, planVar, enforceVar] = passesMatch;
    const before = out.slice(Math.max(0, passesMatch.index - 15000), passesMatch.index);
    const roMatches = [...before.matchAll(/resolveOAuth\(([a-zA-Z0-9_$]+),/g)];
    const provVar = roMatches.at(-1)?.[1];
    if (provVar) {
      const replacement =
        `${passesVar}=[{allowBlocked:!1,enforcePlanRequirement:${planVar},enforceAccounts:${enforceVar}}];` +
        `if(${enforceVar}&&${provVar}!=="google-antigravity")${passesVar}.push({allowBlocked:!1,enforcePlanRequirement:${planVar},enforceAccounts:!1});` +
        `if(${passesVar}.push({allowBlocked:!0,enforcePlanRequirement:${planVar},enforceAccounts:${enforceVar}}),${planVar})${passesVar}.push({allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:${enforceVar}});` +
        `if(${enforceVar}&&${provVar}!=="google-antigravity")${passesVar}.push({allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:!1});`;
      out = out.replace(full, replacement);
      details.push(`Patched cli.js resolveOAuth (${provVar}) to keep accountAccess strict for google-antigravity.`);
      changed = true;
    } else {
      details.push("Located resolveOAuth passes block but could not resolve provider parameter name.");
    }
  } else if (out.includes('!=="google-antigravity")') && out.includes("enforcePlanRequirement")) {
    details.push("cli.js resolveOAuth already enforces strict accountAccess for google-antigravity.");
  } else {
    details.push("Could not locate resolveOAuth passes block in cli.js.");
  }

  // 3. Split google-antigravity meters (Gemini / Argon / Claude+GPT) in `omp usage` capacity line
  const meterMatch = out.match(METER_REGEX);
  if (meterMatch) {
    const [full, fnName, repVar, limVar] = meterMatch;
    const replacement =
      `function ${fnName}(${repVar},${limVar}){` +
      `if(${repVar}.provider==="google-antigravity"){` +
      `let _m=${limVar}.id.toLowerCase().split(":")[1];` +
      `return _m==="google"?"gemini":_m==="argon"||_m==="google-argon"?"argon":(_m==="anthropic"||_m==="openai")?"claude/GPT":_m;` +
      `}` +
      `if(${repVar}.provider!=="anthropic"&&${repVar}.provider!=="openai-codex")return;`;
    out = out.replace(full, replacement);
    details.push("Patched cli.js usage capacity meter splitting for google-antigravity.");
    changed = true;
  } else if (out.includes('.provider==="google-antigravity"){let _m=')) {
    details.push("cli.js usage capacity meter splitting already patched.");
  } else {
    details.push("Could not locate meterForLimit in cli.js.");
  }

  return { source: out, changed, details };
}

function patchRulesData(
  data: RulesCatalogData,
  customClientId?: string | null,
  customClientSecret?: string | null
): { changed: boolean; foundProvider: boolean; details: string[] } {
  const details: string[] = [];
  const ag = data.auth?.providers?.find((p) => p.id === "google-antigravity");
  if (!ag) {
    return { changed: false, foundProvider: false, details: ["google-antigravity not found in auth.providers."] };
  }

  let changed = false;

  if (ag.disabled) {
    delete ag.disabled;
    details.push("Removed legacy disabled auth rule on google-antigravity.");
    changed = true;
  }
  // 1. Ensure gemini-4-hydrogen variant family exists in taxonomy.collapse.variantFamilies
  data.taxonomy ??= {};
  data.taxonomy.collapse ??= {};
  const collapse = data.taxonomy.collapse as { variantFamilies?: CompiledVariantFamily[]; [key: string]: unknown };
  collapse.variantFamilies ??= [];
  const existingHydro = collapse.variantFamilies.find(
    (f) => f.provider === "google-antigravity" && f.id === "gemini-4-hydrogen"
  );
  if (!existingHydro) {
    const idx = collapse.variantFamilies.findIndex(
      (f) => f.provider === "google-antigravity" && (f.id === "gemini-4-carbon" || f.id === "gemini-4-argon")
    );
    const hydroFamily: CompiledVariantFamily = {
      provider: "google-antigravity",
      id: "gemini-4-hydrogen",
      name: "Gemini 4 Hydrogen",
      members: [
        "gemini-4-hydrogen-low",
        "gemini-4-hydrogen-medium",
        "gemini-4-hydrogen-high",
        "gemini-4-hydrogen-xhigh",
      ],
      defaultMember: "gemini-4-hydrogen-medium",
      routing: {
        minimal: "gemini-4-hydrogen-low",
        low: "gemini-4-hydrogen-low",
        medium: "gemini-4-hydrogen-medium",
        high: "gemini-4-hydrogen-high",
        xhigh: "gemini-4-hydrogen-xhigh",
      },
      mode: "google-level",
      efforts: ["low", "medium", "high", "xhigh"],
      requiresEffort: true,
    };
    if (idx >= 0) {
      collapse.variantFamilies.splice(idx + 1, 0, hydroFamily);
    } else {
      collapse.variantFamilies.push(hydroFamily);
    }
    details.push("Added 'gemini-4-hydrogen' variant family to taxonomy.collapse.variantFamilies.");
    changed = true;
  }

  const agQuotaRule = data.behavior?.quotaTiers?.find((q) => q.provider === "google-antigravity");
  if (agQuotaRule) {
    agQuotaRule.tiers ??= [];
    const googleTier = agQuotaRule.tiers.find((t) => t.label === "google");
    if (googleTier && !googleTier.models.includes("gemini-4-hydrogen")) {
      googleTier.models.push("gemini-4-hydrogen");
      details.push("Added 'gemini-4-hydrogen' to 'google' quotaTier.");
      changed = true;
    }
    const existingArgon = agQuotaRule.tiers.find((t) => t.label === "google-argon" || t.label === "argon");
    if (!existingArgon) {
      agQuotaRule.tiers.push({ label: "google-argon", models: ["gemini-4-argon"] });
      details.push("Added 'google-argon' tier (gemini-4-argon) to google-antigravity quotaTiers.");
      changed = true;
    } else if (!existingArgon.models.includes("gemini-4-argon")) {
      existingArgon.models.push("gemini-4-argon");
      details.push(`Added gemini-4-argon to existing '${existingArgon.label}' quotaTier.`);
      changed = true;
    }

    agQuotaRule.fallbacks ??= [];
    const hasArgonFallback = agQuotaRule.fallbacks.some((f) => f.label === "google-argon" || f.label === "argon");
    if (!hasArgonFallback) {
      const googleIdx = agQuotaRule.fallbacks.findIndex((f) => f.label === "google" && f.substring === "gemini-");
      const entry: QuotaFallbackEntry = { label: "google-argon", substring: "gemini-4-argon" };
      if (googleIdx >= 0) {
        agQuotaRule.fallbacks.splice(googleIdx, 0, entry);
      } else {
        agQuotaRule.fallbacks.unshift(entry);
      }
      details.push("Added 'google-argon' substring fallback before 'gemini-' in google-antigravity quotaTiers.");
      changed = true;
    }
  }

  if (customClientId) {
    ag.login ??= {};
    ag.login.clientId = {
      value: Buffer.from(customClientId).toString("base64"),
      encoding: "base64",
    };
    details.push(`Injected custom OAuth Client ID (${customClientId.slice(0, 16)}...).`);
    changed = true;
  }

  if (customClientSecret) {
    ag.login ??= {};
    ag.login.clientSecret = {
      value: Buffer.from(customClientSecret).toString("base64"),
      encoding: "base64",
    };
    details.push("Injected custom OAuth Client Secret.");
    changed = true;
  }

  return { changed, foundProvider: true, details };
}

function atomicWriteFile(targetPath: string, data: string | Uint8Array): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, targetPath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

export function readPatchState(statePath = defaultPatchStatePath()): OmpPatchState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<OmpPatchState> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    if (
      typeof parsed.distDir !== "string" ||
      typeof parsed.zstFile !== "string" ||
      typeof parsed.cliSize !== "number" ||
      typeof parsed.cliMtimeMs !== "number"
    ) {
      return null;
    }
    return {
      version: 1,
      ompVersion: typeof parsed.ompVersion === "string" ? parsed.ompVersion : null,
      distDir: parsed.distDir,
      zstFile: parsed.zstFile,
      cliSize: parsed.cliSize,
      cliMtimeMs: parsed.cliMtimeMs,
      patchedAt: typeof parsed.patchedAt === "number" ? parsed.patchedAt : 0,
      reverted: Boolean(parsed.reverted),
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    };
  } catch {
    return null;
  }
}

function writePatchState(state: OmpPatchState, statePath = defaultPatchStatePath()): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

function acquirePatchLock(statePath: string): string | null {
  const lockPath = `${statePath}.lock`;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
    return lockPath;
  } catch {}

  // Stale reclaim: rename the old lock aside instead of unlinking it, and put it
  // back if it turns out to be still fresh. Reclaiming by unlink could delete a
  // racer's just-created lock and yield two concurrent holders.
  try {
    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    fs.renameSync(lockPath, stalePath);
    if (Date.now() - fs.statSync(stalePath).mtimeMs <= LOCK_STALE_MS) {
      try {
        fs.renameSync(stalePath, lockPath);
      } catch {}
      return null;
    }
    try {
      fs.unlinkSync(stalePath);
    } catch {}
    fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
    return lockPath;
  } catch {
    return null;
  }
}

function releasePatchLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

function isRulesPatched(data: RulesCatalogData): boolean {
  const ag = data.auth?.providers?.find((p) => p.id === "google-antigravity");
  if (!ag || ag.disabled) return false;
  const qt = data.behavior?.quotaTiers?.find((q) => q.provider === "google-antigravity");
  if (!qt) return true;
  const hasArgonTier = Boolean(
    qt.tiers?.some((t) => (t.label === "google-argon" || t.label === "argon") && t.models.includes("gemini-4-argon"))
  );
  const hasArgonFallback = Boolean(
    qt.fallbacks?.some((f) => f.label === "google-argon" || f.label === "argon")
  );
  const collapse = (data.taxonomy as { collapse?: { variantFamilies?: CompiledVariantFamily[] } } | undefined)?.collapse;
  const hasHydrogenFamily = Boolean(
    collapse?.variantFamilies?.some((f) => f.provider === "google-antigravity" && f.id === "gemini-4-hydrogen")
  );
  return hasArgonTier && hasArgonFallback && hasHydrogenFamily;
}

export function inspectOmpPatchStatus(
  options: OmpPatchOptions & { verifyFiles?: boolean } = {}
): OmpPatchResult {
  const distDir = options.distDir ?? resolvePatchTargetDistDir(options.rootsOverride);
  if (!distDir) {
    return { status: "unavailable", changed: false, details: ["OMP dist directory not found (standalone binary or Pi)."] };
  }

  const ompVersion = readAgentVersion(distDir);
  const zstFile = findRulesBundleFile(distDir);
  const cliPath = path.join(distDir, "cli.js");
  if (!zstFile) {
    return { status: "unavailable", distDir, ompVersion, changed: false, details: ["rules.json-*.zst not found."] };
  }

  const statePath = options.statePath ?? defaultPatchStatePath();
  const state = readPatchState(statePath);
  if (state?.reverted && !options.verifyFiles) {
    return { status: "reverted", distDir, ompVersion, changed: false, details: ["OMP patch explicitly reverted."] };
  }

  if (!options.verifyFiles && state && state.distDir === distDir && state.zstFile === zstFile && fs.existsSync(cliPath)) {
    try {
      const st = fs.statSync(cliPath);
      if (state.cliSize === st.size && Math.abs(state.cliMtimeMs - st.mtimeMs) < 1) {
        return {
          status: "already-patched",
          distDir,
          ompVersion,
          changed: false,
          details: [`OMP v${ompVersion ?? "unknown"} matches cached patch receipt.`],
        };
      }
    } catch {}
  }

  const details: string[] = [];
  const zstd = getZstdFns();
  let rulesOk = false;
  if (zstd) {
    try {
      const data = JSON.parse(zstd.decompress(fs.readFileSync(path.join(distDir, zstFile))).toString("utf8")) as RulesCatalogData;
      rulesOk = isRulesPatched(data);
      details.push(rulesOk ? `${zstFile}: patched (argon tier active)` : `${zstFile}: unpatched`);
    } catch (err) {
      details.push(`${zstFile}: unreadable (${err instanceof Error ? err.message : String(err)})`);
    }
  } else {
    details.push("Zstd runtime unavailable; cannot inspect rules bundle.");
  }

  let cliOk = true;
  if (fs.existsSync(cliPath)) {
    const cliSrc = fs.readFileSync(cliPath, "utf8");
    const compat = checkCliCompatibility(cliSrc);
    cliOk = compat.summary === "patched" && compat.resolveOAuth === "patched" && compat.meter === "patched";
    details.push(
      `cli.js: summary=${compat.summary}, resolveOAuth=${compat.resolveOAuth}, meter=${compat.meter}`
    );
  }

  return {
    status: rulesOk && cliOk ? "already-patched" : "unpatched",
    distDir,
    ompVersion,
    changed: false,
    details,
  };
}

export function applyOmpPatch(options: OmpPatchOptions = {}): OmpPatchResult {
  const distDir = options.distDir ?? resolvePatchTargetDistDir(options.rootsOverride);
  if (!distDir) {
    return {
      status: "unavailable",
      changed: false,
      details: ["Could not locate @oh-my-pi/pi-coding-agent dist directory."],
    };
  }

  const zstd = getZstdFns();
  if (!zstd) {
    return {
      status: "unavailable",
      distDir,
      ompVersion: readAgentVersion(distDir),
      changed: false,
      details: ["Zstd compression API unavailable in this runtime (requires Bun or Node with zstd)."],
    };
  }

  const zstFile = findRulesBundleFile(distDir);
  if (!zstFile) {
    return {
      status: "unavailable",
      distDir,
      ompVersion: readAgentVersion(distDir),
      changed: false,
      details: ["Could not find rules.json-*.zst inside dist directory."],
    };
  }

  const statePath = options.statePath ?? defaultPatchStatePath();
  const lock = acquirePatchLock(statePath);
  if (lock === null) {
    return {
      status: "locked",
      distDir,
      ompVersion: readAgentVersion(distDir),
      changed: false,
      details: ["Another process is currently patching OMP."],
    };
  }

  const clock = options.now ?? Date.now;
  const ompVersion = readAgentVersion(distDir);
  const zstPath = path.join(distDir, zstFile);
  const zstBakPath = `${zstPath}.bak`;
  const cliPath = path.join(distDir, "cli.js");
  const cliBakPath = `${cliPath}.bak`;

  try {
    const details: string[] = [];
    let anyChanged = false;

    // 1. Patch rules.json-*.zst
    const rawCompressed = fs.readFileSync(zstPath);
    const data = JSON.parse(zstd.decompress(rawCompressed).toString("utf8")) as RulesCatalogData;
    const wasRulesPatched = isRulesPatched(data);
    if (!fs.existsSync(zstBakPath) || !wasRulesPatched) {
      atomicWriteFile(zstBakPath, rawCompressed);
    }

    const rulesPatch = patchRulesData(data, options.clientId, options.clientSecret);
    details.push(...rulesPatch.details);
    if (!rulesPatch.foundProvider) {
      return { status: "failed", distDir, ompVersion, changed: false, details };
    }
    if (rulesPatch.changed) {
      const recompressed = zstd.compress(Buffer.from(JSON.stringify(data), "utf8"));
      atomicWriteFile(zstPath, recompressed);
      details.push(`Wrote patched ${zstFile} (${recompressed.length} bytes).`);
      anyChanged = true;
    }

    // Sync sibling @oh-my-pi/pi-catalog/src/compat/rules.json if present
    const catalogRulesJson = path.resolve(distDir, "..", "..", "pi-catalog", "src", "compat", "rules.json");
    if (fs.existsSync(catalogRulesJson)) {
      const catalogData = JSON.parse(fs.readFileSync(catalogRulesJson, "utf8")) as RulesCatalogData;
      const catPatch = patchRulesData(catalogData, null, null);
      if (catPatch.changed) {
        atomicWriteFile(catalogRulesJson, JSON.stringify(catalogData));
        details.push("Synced patch to @oh-my-pi/pi-catalog/src/compat/rules.json.");
        anyChanged = true;
      }
    }

    // 2. Patch cli.js
    if (fs.existsSync(cliPath)) {
      const cliSrc = fs.readFileSync(cliPath, "utf8");
      const compat = checkCliCompatibility(cliSrc);
      const isFreshUnpatched =
        compat.summary === "unpatched" && compat.resolveOAuth === "unpatched" && compat.meter === "unpatched";
      if (!fs.existsSync(cliBakPath) || isFreshUnpatched) {
        atomicWriteFile(cliBakPath, cliSrc);
      }

      const cliPatch = patchCliSource(cliSrc);
      details.push(...cliPatch.details);
      if (cliPatch.changed) {
        atomicWriteFile(cliPath, cliPatch.source);
        details.push("Wrote patched cli.js.");
        anyChanged = true;
      }
    }

    const cliStat = fs.existsSync(cliPath) ? fs.statSync(cliPath) : null;
    writePatchState(
      {
        version: 1,
        ompVersion,
        distDir,
        zstFile,
        cliSize: cliStat?.size ?? 0,
        cliMtimeMs: cliStat?.mtimeMs ?? 0,
        patchedAt: clock(),
        reverted: false,
        lastError: null,
      },
      statePath
    );

    return {
      status: anyChanged ? "patched" : "already-patched",
      distDir,
      ompVersion,
      changed: anyChanged,
      details,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      distDir,
      ompVersion,
      changed: false,
      details: [message],
    };
  } finally {
    releasePatchLock(lock);
  }
}

export function revertOmpPatch(options: OmpPatchOptions = {}): OmpPatchResult {
  const distDir = options.distDir ?? resolvePatchTargetDistDir(options.rootsOverride);
  if (!distDir) {
    return { status: "unavailable", changed: false, details: ["Could not locate OMP dist directory."] };
  }

  const zstFile = findRulesBundleFile(distDir);
  if (!zstFile) {
    return { status: "unavailable", distDir, changed: false, details: ["Could not find rules.json-*.zst."] };
  }

  const statePath = options.statePath ?? defaultPatchStatePath();
  const lock = acquirePatchLock(statePath);
  if (lock === null) {
    return { status: "locked", distDir, changed: false, details: ["Patch lock is currently held."] };
  }

  try {
    const zstPath = path.join(distDir, zstFile);
    const zstBakPath = `${zstPath}.bak`;
    const cliPath = path.join(distDir, "cli.js");
    const cliBakPath = `${cliPath}.bak`;
    const details: string[] = [];
    let restoredAny = false;

    if (fs.existsSync(zstBakPath)) {
      atomicWriteFile(zstPath, fs.readFileSync(zstBakPath));
      details.push(`Restored original rules bundle from ${zstBakPath}`);
      restoredAny = true;
    }
    if (fs.existsSync(cliBakPath)) {
      atomicWriteFile(cliPath, fs.readFileSync(cliBakPath));
      details.push(`Restored original cli.js from ${cliBakPath}`);
      restoredAny = true;
    }

    if (!restoredAny) {
      return { status: "failed", distDir, ompVersion: readAgentVersion(distDir), changed: false, details: ["No backups found to revert."] };
    }

    const cliStat = fs.existsSync(cliPath) ? fs.statSync(cliPath) : null;
    writePatchState(
      {
        version: 1,
        ompVersion: readAgentVersion(distDir),
        distDir,
        zstFile,
        cliSize: cliStat?.size ?? 0,
        cliMtimeMs: cliStat?.mtimeMs ?? 0,
        patchedAt: (options.now ?? Date.now)(),
        reverted: true,
        lastError: null,
      },
      statePath
    );

    return {
      status: "reverted",
      distDir,
      ompVersion: readAgentVersion(distDir),
      changed: true,
      details,
    };
  } finally {
    releasePatchLock(lock);
  }
}

export function isRunningUnderTests(): boolean {
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") return true;
  const bunMain = readObjectProp(readObjectProp(globalThis, "Bun"), "main");
  if (typeof bunMain === "string" && (bunMain.endsWith(".test.ts") || bunMain.endsWith(".test.js"))) return true;
  if (process.argv.some((a) => a.includes(".test."))) return true;
  return false;
}

/**
 * Fast, idempotent startup guard that re-applies OMP patches after an `omp update`.
 */
export function ensureOmpPatched(options: OmpPatchOptions = {}): OmpPatchResult {
  if (process.env.PI_ANTIGRAVITY_SKIP_AUTO_PATCH && !options.force) {
    return { status: "skipped", changed: false, details: ["Auto-patch disabled via PI_ANTIGRAVITY_SKIP_AUTO_PATCH."] };
  }
  if (!options.force && !options.distDir && !options.rootsOverride && isRunningUnderTests()) {
    return { status: "skipped", changed: false, details: ["Skipped auto-patch inside test runner."] };
  }

  const check = inspectOmpPatchStatus(options);
  if (
    check.status === "already-patched" ||
    check.status === "unavailable" ||
    (check.status === "reverted" && !options.force)
  ) {
    return check;
  }

  return applyOmpPatch({
    ...options,
    distDir: check.distDir ?? options.distDir,
  });
}
