import { describe, expect, it } from "bun:test";
import antigravityPlugin, {
  AGY_SUBCOMMANDS,
  extractCredentials,
  formatStructuredApiKey,
  getAgyArgumentCompletions,
} from "../src/index.ts";
import { buildHubUserAgent, getLiveHubVersion } from "../src/manifest.ts";
import {
  getEffectiveClientId,
  getEffectiveClientSecret,
  parseOAuthCallbackInput,
  resolveBrowserLaunch,
  resolveOAuthClientCredentials,
} from "../src/auth.ts";
import { findOmpAgentDistDir } from "../src/omp-builtin.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, FALLBACK_PROJECT_ID } from "../src/constants.ts";
import { type AntigravityUsageProvider, sanitizeAntigravityUsageReport } from "../src/usage.ts";
import {
  listStoredAccounts,
  maskEmail,
  removeStoredAccount,
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
    expect(getEffectiveClientId()).toBe(DEFAULT_CLIENT_ID);
    expect(getEffectiveClientSecret()).toBe(DEFAULT_CLIENT_SECRET);
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
    const argonLimits = sanitized.limits.filter((l) => l.id.startsWith("google-antigravity:argon:"));

    expect(googleLimits.length).toBe(2);
    expect(googleLimits.every((l) => (l.amount.remainingFraction ?? 0) > 0.9)).toBe(true);
    expect(argonLimits.length).toBe(1);
    expect(argonLimits[0]?.id).toBe("google-antigravity:argon:default:gemini-argon-wtu-weekly");
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
        description: "Probe account tier (Free, Plus, Pro, Ultra)",
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
      fs.rmSync(tmp, { recursive: true, force: true });
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
      fs.rmSync(tmp, { recursive: true, force: true });
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
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
