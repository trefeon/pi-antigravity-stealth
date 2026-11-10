/**
 * src/omp-builtin.ts
 *
 * Resolves OMP's already-shipped built-in Google Antigravity OAuth, usage, and rules
 * metadata from the running installation so the plugin patches only what is necessary
 * instead of re-implementing OMP core behavior.
 */

import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";

export interface BuiltinOAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface BuiltinProviderDefinition {
  id: string;
  name: string;
  login?: (callbacks: Record<string, unknown>) => Promise<Record<string, unknown>>;
  refreshToken?: (credentials: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
}

export interface BuiltinUsageProvider {
  id: string;
  cacheVersion?: number;
  fetchUsage(params: Record<string, unknown>, ctx: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

const requireFromHere = createRequire(import.meta.url);

function getCandidatePackageRoots(): string[] {
  const roots = new Set<string>();

  // 1. Resolve from running OMP binary entrypoint (e.g. .../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js)
  if (process.argv[1]) {
    try {
      const realArgv = fs.realpathSync(process.argv[1]);
      const dir = path.dirname(realArgv);
      roots.add(path.resolve(dir, "..", ".."));
      roots.add(path.resolve(dir, "..", "..", ".."));
    } catch {}
  }

  // 2. Standard global Bun install path
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    roots.add(path.join(home, ".bun", "install", "global", "node_modules", "@oh-my-pi"));
  }

  // 3. Local dev node_modules if present
  try {
    const pkgPath = requireFromHere.resolve("@oh-my-pi/pi-ai/package.json");
    roots.add(path.dirname(path.dirname(pkgPath)));
  } catch {}

  return [...roots];
}

export function findOmpAgentDistDir(): string | null {
  for (const root of getCandidatePackageRoots()) {
    const candidate = path.join(root, "pi-coding-agent", "dist");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function findPiAiPackageDir(): string | null {
  for (const root of getCandidatePackageRoots()) {
    const candidate = path.join(root, "pi-ai");
    if (fs.existsSync(path.join(candidate, "src"))) {
      return candidate;
    }
  }
  return null;
}

function decodeRuleValue(val: unknown): string {
  if (!val || typeof val !== "object") return "";
  const rec = val as { value?: unknown; encoding?: unknown };
  if (typeof rec.value !== "string") return "";
  if (rec.encoding === "base64") {
    return Buffer.from(rec.value, "base64").toString("utf8");
  }
  return rec.value;
}

let cachedRulesClientCreds: BuiltinOAuthClientCredentials | null | undefined;

/**
 * Reads OMP's shipped google-antigravity OAuth client credentials from rules.json-*.zst
 * so fallback OAuth login/refresh works even without env vars or @oh-my-pi/pi-ai source files.
 */
export function getBuiltinAntigravityClientCredentials(): BuiltinOAuthClientCredentials | null {
  if (cachedRulesClientCreds !== undefined) {
    return cachedRulesClientCreds;
  }

  const distDir = findOmpAgentDistDir();
  if (!distDir) {
    cachedRulesClientCreds = null;
    return null;
  }

  try {
    const zstFile = fs
      .readdirSync(distDir)
      .find((f) => f.startsWith("rules.json-") && f.endsWith(".zst") && !f.endsWith(".bak"));
    if (!zstFile) {
      cachedRulesClientCreds = null;
      return null;
    }
    const compressed = fs.readFileSync(path.join(distDir, zstFile));
    const data = JSON.parse(Bun.zstdDecompressSync(compressed).toString("utf8")) as {
      auth?: { providers?: Array<Record<string, unknown>> };
    };
    const ag = data.auth?.providers?.find((p) => p.id === "google-antigravity");
    const login = ag?.login as Record<string, unknown> | undefined;
    const clientId = decodeRuleValue(login?.clientId);
    const clientSecret = decodeRuleValue(login?.clientSecret);
    if (clientId && clientSecret) {
      cachedRulesClientCreds = { clientId, clientSecret };
      return cachedRulesClientCreds;
    }
  } catch {}

  cachedRulesClientCreds = null;
  return null;
}

let cachedProviderDef: BuiltinProviderDefinition | null | undefined;

export async function getBuiltinAntigravityDefinition(): Promise<BuiltinProviderDefinition | null> {
  if (cachedProviderDef !== undefined) {
    return cachedProviderDef;
  }

  const piAiDir = findPiAiPackageDir();
  const candidates = [
    ...(piAiDir ? [pathToFileURL(path.join(piAiDir, "src", "registry", "index.ts")).href] : []),
    "@oh-my-pi/pi-ai/registry",
  ];

  for (const spec of candidates) {
    try {
      // Runtime-resolved path into the host OMP installation; not a static package dep.
      const mod = (await import(spec)) as {
        getProviderDefinition?: (id: string) => BuiltinProviderDefinition | undefined;
      };
      const def = mod.getProviderDefinition?.("google-antigravity");
      if (def && typeof def.login === "function" && typeof def.refreshToken === "function") {
        cachedProviderDef = def;
        return def;
      }
    } catch {}
  }

  cachedProviderDef = null;
  return null;
}

let cachedUsageProvider: BuiltinUsageProvider | null | undefined;

export async function getBuiltinAntigravityUsageProvider(): Promise<BuiltinUsageProvider | null> {
  if (cachedUsageProvider !== undefined) {
    return cachedUsageProvider;
  }

  const piAiDir = findPiAiPackageDir();
  const candidates = [
    ...(piAiDir ? [pathToFileURL(path.join(piAiDir, "src", "usage", "google-antigravity.ts")).href] : []),
    "@oh-my-pi/pi-ai/usage/google-antigravity",
  ];

  for (const spec of candidates) {
    try {
      // Runtime-resolved path into the host OMP installation; not a static package dep.
      const mod = (await import(spec)) as {
        antigravityUsageProvider?: BuiltinUsageProvider;
      };
      if (mod.antigravityUsageProvider && typeof mod.antigravityUsageProvider.fetchUsage === "function") {
        cachedUsageProvider = mod.antigravityUsageProvider;
        return cachedUsageProvider;
      }
    } catch {}
  }

  cachedUsageProvider = null;
  return null;
}
