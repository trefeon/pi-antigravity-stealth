import { describe, expect, it } from "bun:test";
import antigravityPlugin, {
  AGY_SUBCOMMANDS,
  extractCredentials,
  formatStructuredApiKey,
  getAgyArgumentCompletions,
} from "../src/index.ts";
import { buildHubUserAgent, getLiveHubVersion } from "../src/manifest.ts";
import {
  escapeHtml,
  getEffectiveClientId,
  getEffectiveClientSecret,
  loadAntigravityEnvFiles,
  parseOAuthCallbackInput,
  resolveBrowserLaunch,
  resolveOAuthClientCredentials,
} from "../src/auth.ts";
import { findOmpAgentDistDir } from "../src/omp-builtin.ts";
import {
  applyOmpPatch,
  checkCliCompatibility,
  ensureOmpPatched,
  inspectOmpPatchStatus,
  revertOmpPatch,
} from "../src/omp-patch.ts";
import { applyUpstreamSync } from "../scripts/check-upstream-drift.ts";
import { FALLBACK_PROJECT_ID } from "../src/constants.ts";
import { type AntigravityUsageProvider, sanitizeAntigravityUsageReport } from "../src/usage.ts";
import {
  auditAndQuarantineAccounts,
  listStoredAccounts,
  markAccountDisabled,
  maskEmail,
  probeAccountInference,
  purgeBannedAccounts,
  removeStoredAccount,
  saveAccountToAgentDb,
} from "../src/accounts.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkForUpdate,
  compareVersions,
  detectInstall,
  fetchLatestGitHubRelease,
  INSTALL_MARKER_FILE,
  maybeAutoUpdate,
  parseReleaseTagFromLocation,
  resetUpdateMemory,
} from "../src/updater.ts";

function safeRm(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows file locking / indexer fallback
  }
}

describe("pi-antigravity-stealth Plugin", () => {
  it("resolves the current live or fallback Hub version and changelist", async () => {
    const { version, changelist } = await getLiveHubVersion();
    expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(changelist).toMatch(/^[0-9]+$/);
  });

  it("builds the canonical Hub User-Agent matching official Google format", async () => {
    const ua = await buildHubUserAgent();
    expect(ua).toMatch(
      /^antigravity\/hub\/[0-9]+\.[0-9]+\.[0-9]+ \(aidev_client; os_type=(windows|darwin|linux); arch=(amd64|arm64)(; cl=[0-9]+)?\)$/
    );
  });

  it("masks email addresses for logging and status displays", () => {
    expect(maskEmail("user@domain.com")).toBe("u**r@domain.com");
    expect(maskEmail("trefeon@gmail.com")).toBe("t*****n@gmail.com");
    expect(maskEmail("ab@domain.com")).toBe("*@domain.com");
  });

  it("discovers existing stored Antigravity accounts from local agent.db", () => {
    const accounts = listStoredAccounts();
    expect(Array.isArray(accounts)).toBe(true);
    if (accounts.length > 0) {
      expect(accounts[0]?.id).toBeDefined();
    }
  });

  it("handles removeStoredAccount gracefully when target is not found", () => {
    const res = removeStoredAccount("non-existent-account-xyz-12345");
    expect(res.success).toBe(false);
    expect(res.affected).toBe(0);
  });

  it("uses custom OAuth client credentials when provided in env and falls back safely", () => {
    const originalId = process.env.ANTIGRAVITY_CLIENT_ID;
    const originalSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
    try {
      process.env.ANTIGRAVITY_CLIENT_ID = "custom-test-client-id.apps.googleusercontent.com";
      process.env.ANTIGRAVITY_CLIENT_SECRET = "custom-test-secret";
      expect(getEffectiveClientId()).toBe("custom-test-client-id.apps.googleusercontent.com");
      expect(resolveOAuthClientCredentials()).toEqual({
        clientId: "custom-test-client-id.apps.googleusercontent.com",
        clientSecret: "custom-test-secret",
      });
    } finally {
      if (originalId !== undefined) {
        process.env.ANTIGRAVITY_CLIENT_ID = originalId;
      } else {
        delete process.env.ANTIGRAVITY_CLIENT_ID;
      }
      if (originalSecret !== undefined) {
        process.env.ANTIGRAVITY_CLIENT_SECRET = originalSecret;
      } else {
        delete process.env.ANTIGRAVITY_CLIENT_SECRET;
      }
    }
    expect(getEffectiveClientId()).toBe("");
    expect(getEffectiveClientSecret()).toBe("");
  });

  it("formats structured apiKey JSON preserving accountId and OMP built-in fields", () => {
    const encoded = formatStructuredApiKey({
      access: "tok-123",
      refresh: "ref-456",
      expires: 9999999999999,
      projectId: "aicode-consumers",
      email: "user@example.com",
      accountId: "acct-789",
      apiEndpoint: "https://daily-cloudcode-pa.googleapis.com",
    });

    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    expect(parsed.token).toBe("tok-123");
    expect(parsed.refreshToken).toBe("ref-456");
    expect(parsed.expiresAt).toBe(9999999999999);
    expect(parsed.projectId).toBe("aicode-consumers");
    expect(parsed.email).toBe("user@example.com");
    expect(parsed.accountId).toBe("acct-789");
    expect(parsed.apiEndpoint).toBe("https://daily-cloudcode-pa.googleapis.com");

    expect(extractCredentials({ access: "tok-only" }).projectId).toBe(FALLBACK_PROJECT_ID);
  });

  it("isolates Gemini 4 Argon buckets from the google counter so healthy Gemini quota stays usable", () => {
    const sanitized = sanitizeAntigravityUsageReport({
      provider: "google-antigravity",
      fetchedAt: Date.now(),
      limits: [
        {
          id: "google-antigravity:google:default:gemini-argon-wtu-weekly",
          label: "Gemini (Argon)",
          amount: { remainingFraction: 0, usedFraction: 1 },
          status: "exhausted",
        },
        {
          id: "google-antigravity:anthropic:default:3p-weekly",
          label: "Claude & GPT (shared)",
          amount: { remainingFraction: 0, usedFraction: 1 },
          status: "exhausted",
        },
        {
          id: "google-antigravity:google:default:gemini-weekly",
          label: "Gemini",
          amount: { remainingFraction: 0.99, usedFraction: 0.01 },
          status: "ok",
        },
        {
          id: "google-antigravity:google:default:gemini-5h",
          label: "Gemini",
          amount: { remainingFraction: 1, usedFraction: 0 },
          status: "ok",
        },
      ],
      raw: {
        groups: [
          { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly" }, { bucketId: "gemini-5h" }] },
          { displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-wtu-weekly" }] },
        ],
      },
    });

    const googleLimits = sanitized.limits.filter((l) => l.id.startsWith("google-antigravity:google:"));
    const argonLimits = sanitized.limits.filter(
      (l) => l.id.startsWith("google-antigravity:google-argon:") || l.id.startsWith("google-antigravity:argon:")
    );

    expect(googleLimits.length).toBe(2);
    expect(googleLimits.every((l) => (l.amount.remainingFraction ?? 0) > 0.9)).toBe(true);
    expect(argonLimits.length).toBe(1);
    expect(argonLimits[0]?.id).toBe("google-antigravity:google-argon:default:gemini-argon-wtu-weekly");
  });

  it("registers google-antigravity with usage override and oauth without overriding built-in baseUrl", async () => {
    let registeredId = "";
    let registeredOptions: Record<string, unknown> | undefined;
    let registeredCmd = "";

    const mockPi = {
      registerProvider(id: string, options: Record<string, unknown>) {
        registeredId = id;
        registeredOptions = options;
      },
      registerCommand(name: string) {
        registeredCmd = name;
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    };

    await antigravityPlugin(mockPi);

    expect(registeredId).toBe("google-antigravity");
    expect(registeredOptions).toBeDefined();
    if (!registeredOptions) throw new Error("Expected options to be registered");
    expect(registeredOptions.baseUrl).toBeUndefined();
    expect(registeredOptions.usage).toBeDefined();
    const usageProvider = registeredOptions.usage as AntigravityUsageProvider;
    expect(usageProvider.id).toBe("google-antigravity");
    expect(usageProvider.cacheVersion).toBe(3);
    expect("supports" in usageProvider ? usageProvider.supports : undefined).toBeUndefined();
    expect(registeredOptions.oauth).toBeDefined();
    expect(registeredCmd).toBe("agy");
  });

  it("exposes /agy slash-command autocomplete snippets and dynamic account ID completions", async () => {
    let commandSpec:
      | {
          description?: string;
          getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string; hint?: string }> | null;
          handler: (args: string, ctx?: unknown) => Promise<void> | void;
        }
      | undefined;

    await antigravityPlugin({
      registerProvider() {},
      registerCommand(_name: string, options: unknown) {
        commandSpec = options as typeof commandSpec;
      },
    });

    expect(commandSpec).toBeDefined();
    expect(typeof commandSpec?.getArgumentCompletions).toBe("function");

    const top = commandSpec?.getArgumentCompletions?.("") ?? [];
    expect(top.map((c) => c.label)).toEqual(AGY_SUBCOMMANDS.map((s) => s.name));
    for (const item of top) {
      expect(item.description).toBeTruthy();
      expect(item.hint).toBeTruthy();
    }

    const filtered = getAgyArgumentCompletions("ti") ?? [];
    expect(filtered).toEqual([
      {
        value: "tier ",
        label: "tier",
        description: "Probe account tier and Hydrogen entitlement",
        hint: "er [email|id]",
      },
    ]);

    const sampleAccounts = [
      {
        id: 7,
        email: "alice@example.com",
        isExpired: false,
        hasRefreshToken: true,
        disabledCause: null,
        dbPath: "/tmp/agent.db",
      },
    ];
    const tierTargets = getAgyArgumentCompletions("tier ", () => sampleAccounts) ?? [];
    expect(tierTargets).toHaveLength(1);
    expect(tierTargets[0]?.value).toBe("tier 7");
    expect(tierTargets[0]?.label).toBe("#7");
    expect(tierTargets[0]?.description).toContain("a***e@example.com");

    const hardFlags = getAgyArgumentCompletions("remove 7 --h", () => sampleAccounts) ?? [];
    expect(hardFlags).toEqual([
      {
        value: "remove 7 --hard",
        label: "--hard",
        description: "Permanently delete row from agent.db",
        hint: "ard",
      },
    ]);

    const messages: string[] = [];
    await commandSpec?.handler("doctor", {
      hasUI: true,
      ui: {
        notify(msg: string) {
          messages.push(msg);
        },
      },
    });
    expect(messages[0]).toContain("pi-antigravity-stealth Doctor");
    expect(messages[0]).toContain("OMP Patch Status:");
    expect(messages[0]).toContain("Host Runtime:");
  });

  it("parses pasted OAuth callback URLs, query strings, and bare codes safely", () => {
    expect(
      parseOAuthCallbackInput("http://127.0.0.1:51121/oauth-callback?code=abc123&state=st1", "st1")
    ).toEqual({ code: "abc123" });
    expect(parseOAuthCallbackInput("?code=xyz&state=st1", "st1")).toEqual({ code: "xyz" });
    expect(parseOAuthCallbackInput("4/0A-bare-code", "st1")).toEqual({ code: "4/0A-bare-code" });
    expect(() =>
      parseOAuthCallbackInput("http://127.0.0.1:51121/oauth-callback?code=abc&state=wrong", "st1")
    ).toThrow("OAuth state verification failed");
  });

  it("registers cleanly on Pi hosts where pi.logger is absent", async () => {
    let registeredId = "";
    await antigravityPlugin({
      registerProvider(id: string) {
        registeredId = id;
      },
      registerCommand() {},
    });
    expect(registeredId).toBe("google-antigravity");
  });

  it("parses GitHub releases/latest redirect tags without calling api.github.com", async () => {
    expect(parseReleaseTagFromLocation("/trefeon/pi-antigravity-stealth/releases/tag/v1.2.3")).toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
    });
    expect(
      parseReleaseTagFromLocation("https://github.com/trefeon/pi-antigravity-stealth/releases/tag/v2.0.0-rc.1?foo=1")
    ).toEqual({
      tag: "v2.0.0-rc.1",
      version: "2.0.0-rc.1",
    });
    expect(parseReleaseTagFromLocation("/trefeon/pi-antigravity-stealth/releases/tag/")).toBeNull();

    const mockFetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://github.com/trefeon/pi-antigravity-stealth/releases/tag/v1.4.0" },
      })) as unknown as typeof fetch;

    const rel = await fetchLatestGitHubRelease(mockFetch);
    expect(rel).toEqual({ tag: "v1.4.0", version: "1.4.0" });
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.2.0-beta.1")).toBeGreaterThan(0);
  });

  it("detects install kinds safely and protects git checkouts from overwrite", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-detect-"));
    try {
      const gitRoot = path.join(tmp, "git-repo");
      fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
      fs.writeFileSync(path.join(gitRoot, "package.json"), JSON.stringify({ name: "pi-antigravity-stealth", version: "1.1.0" }));
      expect(detectInstall(gitRoot).kind).toBe("git");

      const scriptRoot = path.join(tmp, "script-install");
      fs.mkdirSync(scriptRoot, { recursive: true });
      fs.writeFileSync(path.join(scriptRoot, "package.json"), JSON.stringify({ name: "pi-antigravity-stealth", version: "1.1.0" }));
      fs.writeFileSync(path.join(scriptRoot, INSTALL_MARKER_FILE), JSON.stringify({ source: "github-release" }));
      expect(detectInstall(scriptRoot).kind).toBe("script");

      const ompGitRoot = path.join(tmp, ".omp", "plugins", "node_modules", "pi-antigravity-stealth");
      fs.mkdirSync(ompGitRoot, { recursive: true });
      fs.writeFileSync(path.join(ompGitRoot, "package.json"), JSON.stringify({ name: "pi-antigravity-stealth", version: "1.1.0" }));
      fs.writeFileSync(
        path.join(tmp, ".omp", "plugins", "package.json"),
        JSON.stringify({ dependencies: { "pi-antigravity-stealth": "github:trefeon/pi-antigravity-stealth" } })
      );
      expect(detectInstall(ompGitRoot).kind).toBe("omp-git");
    } finally {
      safeRm(tmp);
    }
  });

  it("caches GitHub release checks and self-updates script installs in place", async () => {
    resetUpdateMemory();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-update-test-"));
    try {
      const installDir = path.join(tmp, "installed");
      const statePath = path.join(tmp, "state.json");
      fs.mkdirSync(path.join(installDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "pi-antigravity-stealth", version: "1.1.0" }));
      fs.writeFileSync(path.join(installDir, "index.ts"), 'export { default } from "./src/index.ts";\n');
      fs.writeFileSync(path.join(installDir, "src", "index.ts"), "// v1.1.0\n");
      fs.writeFileSync(path.join(installDir, "src", "obsolete.ts"), "// old file\n");
      fs.writeFileSync(path.join(installDir, INSTALL_MARKER_FILE), JSON.stringify({ source: "github-release", version: "1.1.0" }));

      // Build a real archive of v1.2.0 using host tooling
      const payloadRoot = path.join(tmp, "payload", "pi-antigravity-stealth-v1.2.0");
      fs.mkdirSync(path.join(payloadRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(payloadRoot, "package.json"), JSON.stringify({ name: "pi-antigravity-stealth", version: "1.2.0" }));
      fs.writeFileSync(path.join(payloadRoot, "index.ts"), 'export { default } from "./src/index.ts";\n');
      fs.writeFileSync(path.join(payloadRoot, "src", "index.ts"), "// v1.2.0 updated\n");

      const isWin = process.platform === "win32";
      const archiveFile = path.join(tmp, isWin ? "release.zip" : "release.tar.gz");
      if (isWin) {
        const psRes = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Compress-Archive -Path $env:SRC_DIR -DestinationPath $env:OUT_ZIP -Force",
          ],
          {
            env: { ...process.env, SRC_DIR: payloadRoot, OUT_ZIP: archiveFile },
            encoding: "utf8",
          }
        );
        expect(psRes.status).toBe(0);
      } else {
        const tarRes = spawnSync("tar", ["-C", path.join(tmp, "payload"), "-czf", archiveFile, "pi-antigravity-stealth-v1.2.0"], {
          encoding: "utf8",
        });
        expect(tarRes.status).toBe(0);
      }
      const archiveBytes = fs.readFileSync(archiveFile);

      let fetchCount = 0;
      const mockFetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCount++;
        if (url.endsWith("/releases/latest")) {
          return new Response(null, {
            status: 302,
            headers: { location: "/trefeon/pi-antigravity-stealth/releases/tag/v1.2.0" },
          });
        }
        if (url.includes("/releases/download/v1.2.0/")) {
          return new Response(archiveBytes, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      }) as unknown as typeof fetch;

      const nowMs = 1_700_000_000_000;
      const check1 = await checkForUpdate({ root: installDir, statePath, now: () => nowMs, fetchImpl: mockFetch });
      expect(check1).toEqual({ current: "1.1.0", latest: "1.2.0", tag: "v1.2.0", error: null });
      expect(fetchCount).toBe(1);

      // Second check within 6h TTL answers from cache without network hit
      const check2 = await checkForUpdate({ root: installDir, statePath, now: () => nowMs + 60_000, fetchImpl: mockFetch });
      expect(check2.latest).toBe("1.2.0");
      expect(fetchCount).toBe(1);

      const res = await maybeAutoUpdate({
        root: installDir,
        statePath,
        now: () => nowMs + 60_000,
        fetchImpl: mockFetch,
      });
      expect(res.status).toBe("updated");
      expect(res.current).toBe("1.1.0");
      expect(res.latest).toBe("1.2.0");

      const updatedPkg = JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")) as { version: string };
      expect(updatedPkg.version).toBe("1.2.0");
      expect(fs.readFileSync(path.join(installDir, "src", "index.ts"), "utf8")).toContain("v1.2.0 updated");
      expect(fs.existsSync(path.join(installDir, "src", "obsolete.ts"))).toBe(false);

      // Subsequent run sees installed version matches latest
      const res2 = await maybeAutoUpdate({
        root: installDir,
        statePath,
        now: () => nowMs + 120_000,
        fetchImpl: mockFetch,
      });
      expect(res2.status).toBe("current");
    } finally {
      safeRm(tmp);
    }
  });

  it("builds shell-less browser launch commands preserving query ampersands on Windows", () => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz";
    expect(resolveBrowserLaunch(url, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(resolveBrowserLaunch(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(resolveBrowserLaunch(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });

  it("verifies @oh-my-pi package ownership in findOmpAgentDistDir and ignores @earendil-works/pi-coding-agent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-omp-dir-"));
    try {
      const piScope = path.join(tmp, "@earendil-works");
      fs.mkdirSync(path.join(piScope, "pi-coding-agent", "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(piScope, "pi-coding-agent", "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent" })
      );
      expect(findOmpAgentDistDir([piScope])).toBeNull();

      const ompScope = path.join(tmp, "@oh-my-pi");
      fs.mkdirSync(path.join(ompScope, "pi-coding-agent", "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(ompScope, "pi-coding-agent", "package.json"),
        JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" })
      );
      expect(findOmpAgentDistDir([piScope, ompScope])).toBe(path.join(ompScope, "pi-coding-agent", "dist"));
    } finally {
      safeRm(tmp);
    }
  });

  it("loads unset Antigravity env vars from env files without overwriting explicit env or reading unrelated keys", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-env-"));
    const origId = process.env.ANTIGRAVITY_CLIENT_ID;
    const origSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
    const origVer = process.env.PI_AI_ANTIGRAVITY_VERSION;
    const origOther = process.env.UNRELATED_KEY;
    try {
      delete process.env.ANTIGRAVITY_CLIENT_ID;
      process.env.ANTIGRAVITY_CLIENT_SECRET = "already-set-secret";
      delete process.env.PI_AI_ANTIGRAVITY_VERSION;
      delete process.env.UNRELATED_KEY;

      const envPath = path.join(tmp, "antigravity.env");
      fs.writeFileSync(
        envPath,
        [
          "# comment",
          'export ANTIGRAVITY_CLIENT_ID="file-client-id.apps.googleusercontent.com"',
          "ANTIGRAVITY_CLIENT_SECRET=file-secret-ignored",
          "PI_AI_ANTIGRAVITY_VERSION=2.31.0 # inline comment",
          "UNRELATED_KEY=should-not-load",
        ].join("\n")
      );

      const count = loadAntigravityEnvFiles([envPath]);
      expect(count).toBe(2);
      expect(Reflect.get(process.env, "ANTIGRAVITY_CLIENT_ID")).toBe("file-client-id.apps.googleusercontent.com");
      expect(Reflect.get(process.env, "ANTIGRAVITY_CLIENT_SECRET")).toBe("already-set-secret");
      expect(Reflect.get(process.env, "PI_AI_ANTIGRAVITY_VERSION")).toBe("2.31.0");
      expect(Reflect.get(process.env, "UNRELATED_KEY")).toBeUndefined();
    } finally {
      if (origId !== undefined) process.env.ANTIGRAVITY_CLIENT_ID = origId;
      else delete process.env.ANTIGRAVITY_CLIENT_ID;
      if (origSecret !== undefined) process.env.ANTIGRAVITY_CLIENT_SECRET = origSecret;
      else delete process.env.ANTIGRAVITY_CLIENT_SECRET;
      if (origVer !== undefined) process.env.PI_AI_ANTIGRAVITY_VERSION = origVer;
      else delete process.env.PI_AI_ANTIGRAVITY_VERSION;
      if (origOther !== undefined) process.env.UNRELATED_KEY = origOther;
      else delete process.env.UNRELATED_KEY;
      safeRm(tmp);
    }
  });

  it("auto-patches OMP bundles, survives simulated upgrades, and honors revert", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-patch-"));
    try {
      const pkgDir = path.join(tmp, "pi-coding-agent");
      const distDir = path.join(pkgDir, "dist");
      const statePath = path.join(tmp, "patch-state.json");
      fs.mkdirSync(distDir, { recursive: true });

      const writeFakeOmp = (version: string, zstName: string) => {
        fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
        const rules = {
          auth: { providers: [{ id: "google-antigravity", loginWarning: "warn" }] },
          behavior: {
            quotaTiers: [
              {
                provider: "google-antigravity",
                tiers: [{ label: "google", models: ["gemini-3-pro"] }],
                fallbacks: [{ label: "google", substring: "gemini-" }],
              },
            ],
          },
        };
        fs.writeFileSync(path.join(distDir, zstName), Bun.zstdCompressSync(Buffer.from(JSON.stringify(rules))));
        const fakeCli = [
          "function f1(g,b){let id=b.bucketId?.toLowerCase()??\"\",gn=g?.displayName?.toLowerCase()??\"\";if(id.startsWith(\"gemini-\")||gn.includes(\"gemini\"))return[\"google\"];return[\"other\"];}",
          "function resolveOAuth(p,a){let passes=[{allowBlocked:!1,enforcePlanRequirement:r,enforceAccounts:e}];if(e)passes.push({allowBlocked:!1,enforcePlanRequirement:r,enforceAccounts:!1});if(passes.push({allowBlocked:!0,enforcePlanRequirement:r,enforceAccounts:e}),r)passes.push({allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:e});if(e)passes.push({allowBlocked:!0,enforcePlanRequirement:!1,enforceAccounts:!1});return passes;}",
          "function m1(rep,lim){if(rep.provider!==\"anthropic\"&&rep.provider!==\"openai-codex\")return;return\"t\";}",
        ].join("\n");
        fs.writeFileSync(path.join(distDir, "cli.js"), fakeCli, "utf8");
      };

      writeFakeOmp("18.18.8", "rules.json-111.zst");
      const first = ensureOmpPatched({ distDir, statePath, now: () => 1000 });
      expect(first.status).toBe("patched");
      expect(first.changed).toBe(true);
      const patchedRules = JSON.parse(Bun.zstdDecompressSync(fs.readFileSync(path.join(distDir, "rules.json-111.zst"))).toString("utf8"));
      const hydroFamily = patchedRules.taxonomy?.collapse?.variantFamilies?.find(
        (f: { id: string }) => f.id === "gemini-4-hydrogen"
      );
      expect(hydroFamily).toBeDefined();
      expect(hydroFamily.members).toContain("gemini-4-hydrogen-medium");
      expect(hydroFamily.members).toContain("gemini-4-hydrogen-xhigh");
      const agTiers = patchedRules.behavior?.quotaTiers?.find(
        (q: { provider: string }) => q.provider === "google-antigravity"
      );
      const googleTier = agTiers?.tiers?.find((t: { label: string }) => t.label === "google");
      expect(googleTier?.models).toContain("gemini-4-hydrogen");
      expect(checkCliCompatibility(fs.readFileSync(path.join(distDir, "cli.js"), "utf8"))).toEqual({
        summary: "patched",
        resolveOAuth: "patched",
        meter: "patched",
        compatible: true,
      });

      // Second check hits stat receipt
      const cached = ensureOmpPatched({ distDir, statePath, now: () => 2000 });
      expect(cached.status).toBe("already-patched");
      expect(cached.changed).toBe(false);

      // Simulate OMP upgrade replacing files
      fs.unlinkSync(path.join(distDir, "rules.json-111.zst"));
      writeFakeOmp("18.18.9", "rules.json-222.zst");
      const upgraded = ensureOmpPatched({ distDir, statePath, now: () => 3000 });
      expect(upgraded.status).toBe("patched");
      expect(upgraded.ompVersion).toBe("18.18.9");
      const verified = inspectOmpPatchStatus({ distDir, statePath, verifyFiles: true });
      expect(verified.status).toBe("already-patched");

      // Revert restores original unpatched files and suppresses auto-patch until forced
      const rev = revertOmpPatch({ distDir, statePath, now: () => 4000 });
      expect(rev.status).toBe("reverted");
      const afterRevert = ensureOmpPatched({ distDir, statePath, now: () => 5000 });
      expect(afterRevert.status).toBe("reverted");
      const reapplied = applyOmpPatch({ distDir, statePath, force: true, now: () => 6000 });
      expect(reapplied.status).toBe("patched");
    } finally {
      safeRm(tmp);
    }
  });

  it("syncs upstream Hub, CLI, and OMP versions cleanly via applyUpstreamSync", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-sync-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });

      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify(
          {
            name: "pi-antigravity-stealth",
            version: "1.2.2",
            devDependencies: { "@oh-my-pi/pi-ai": "^18.18.8", "@oh-my-pi/pi-coding-agent": "^18.18.8" },
          },
          null,
          2
        )
      );
      fs.writeFileSync(
        path.join(tmp, "src", "constants.ts"),
        'export const FALLBACK_VERSION = "2.31.0";\nexport const FALLBACK_CL = "6379060755038208";\nexport const CLI_BASELINE_VERSION = "1.5.5";\n'
      );
      fs.writeFileSync(
        path.join(tmp, "scripts", "antigravity-unpause-extension.ts"),
        'process.env.PI_AI_ANTIGRAVITY_VERSION ??= "2.31.0";\nprocess.env.PI_AI_ANTIGRAVITY_CL ??= "6379060755038208";\n'
      );
      fs.writeFileSync(
        path.join(tmp, "README.md"),
        "manifest (`2.31.0`, CL `6379060755038208`)\nUser-Agent: antigravity/hub/2.31.0 (aidev_client; os_type=windows; arch=amd64; cl=6379060755038208)\n"
      );

      const outcome = applyUpstreamSync(tmp, {
        hubVersion: "2.32.0",
        hubCL: "7777777777777777",
        cliVersion: "1.5.6",
        ompVersion: "18.18.9",
        bumpPatch: true,
      });

      expect(outcome.needsRelease).toBe(true);
      expect(outcome.newVersion).toBe("1.2.3");
      expect(outcome.changedFiles).toContain("src/constants.ts");
      expect(outcome.changedFiles).toContain("package.json");
      expect(fs.readFileSync(path.join(tmp, "src", "constants.ts"), "utf8")).toContain('FALLBACK_VERSION = "2.32.0"');
      expect(fs.readFileSync(path.join(tmp, "README.md"), "utf8")).toContain("antigravity/hub/2.32.0");
    } finally {
      safeRm(tmp);
    }
  });

  it("escapes OAuth error output before reflecting it into callback HTML", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
    expect(escapeHtml("a&b'c")).toBe("a&amp;b&#39;c");
  });

  it("removes accounts only on exact id or exact email match", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-remove-"));
    const prevUserProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    try {
      fs.mkdirSync(path.join(tmpHome, ".omp", "agent"), { recursive: true });
      process.env.USERPROFILE = tmpHome;
      process.env.HOME = tmpHome;

      expect(saveAccountToAgentDb({ access_token: "t1", refresh_token: "r1", email: "alice@x.com", projectId: "p" })).toBe(true);
      expect(saveAccountToAgentDb({ access_token: "t2", refresh_token: "r2", email: "malice@x.com", projectId: "p" })).toBe(true);
      expect(listStoredAccounts()).toHaveLength(2);

      // Substring of both emails must not delete either account
      const partial = removeStoredAccount("ice@x.com", true);
      expect(partial.success).toBe(false);
      expect(partial.affected).toBe(0);
      expect(listStoredAccounts()).toHaveLength(2);

      // Exact email (case-insensitive) deletes exactly one account
      const exact = removeStoredAccount("Alice@X.com", true);
      expect(exact.success).toBe(true);
      expect(exact.affected).toBe(1);
      const remaining = listStoredAccounts().map((a) => a.email);
      expect(remaining).toEqual(["malice@x.com"]);
    } finally {
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      safeRm(tmpHome);
    }
  });

  it("detects 403 Terms of Service violation in probeAccountInference and auto-quarantines", async () => {
    const healthyAcc = {
      id: 101,
      email: "healthy@x.com",
      token: "tok-healthy",
      isExpired: false,
      hasRefreshToken: true,
      disabledCause: null,
      dbPath: "memory",
    };

    const bannedAcc = {
      id: 102,
      email: "banned@x.com",
      token: "tok-banned",
      isExpired: false,
      hasRefreshToken: true,
      disabledCause: null,
      dbPath: "memory",
    };

    // Mock fetch
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.["Authorization"] || "";
      if (auth.includes("tok-healthy")) {
        return new Response('data: {"response":{"candidates":[]}}', { status: 200 });
      }
      if (auth.includes("tok-banned")) {
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              message:
                "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
              status: "PERMISSION_DENIED",
            },
          }),
          { status: 403 }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const resHealthy = await probeAccountInference(healthyAcc, mockFetch);
    expect(resHealthy.status).toBe("healthy");

    const resBanned = await probeAccountInference(bannedAcc, mockFetch);
    expect(resBanned.status).toBe("banned");
    expect(resBanned.message).toContain("Terms of Service");
  });

  it("audits accounts and automatically quarantines banned accounts in agent.db", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-audit-"));
    const prevUserProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    try {
      fs.mkdirSync(path.join(tmpHome, ".omp", "agent"), { recursive: true });
      process.env.USERPROFILE = tmpHome;
      process.env.HOME = tmpHome;

      saveAccountToAgentDb({ access_token: "tok-h", email: "h@x.com", projectId: "p" });
      saveAccountToAgentDb({ access_token: "tok-b", email: "b@x.com", projectId: "p" });

      const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.["Authorization"] || "";
        if (auth.includes("tok-h")) {
          return new Response("data: ok", { status: 200 });
        }
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "This service has been disabled in this account for violation of Terms of Service.",
              status: "PERMISSION_DENIED",
            },
          }),
          { status: 403 }
        );
      }) as unknown as typeof fetch;

      const report = await auditAndQuarantineAccounts(true, mockFetch);
      expect(report.total).toBe(2);
      expect(report.active).toBe(2);
      expect(report.healthy).toBe(1);
      expect(report.quarantined).toBe(1);

      const accountsAfter = listStoredAccounts();
      expect(accountsAfter).toHaveLength(1);
      expect(accountsAfter[0]?.email).toBe("h@x.com");
      expect(accountsAfter.find((a) => a.email === "b@x.com")).toBeUndefined();

      // Test purgeBannedAccounts
      saveAccountToAgentDb({ access_token: "tok-tos", email: "tos@x.com", projectId: "p" });
      markAccountDisabled("tos@x.com", "403: Terms of Service violation");
      expect(listStoredAccounts()).toHaveLength(2);
      const purgeRes = purgeBannedAccounts();
      expect(purgeRes.purged).toBe(1);
      expect(listStoredAccounts()).toHaveLength(1);
      expect(listStoredAccounts()[0]?.email).toBe("h@x.com");
    } finally {
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      safeRm(tmpHome);
    }
  });
});
