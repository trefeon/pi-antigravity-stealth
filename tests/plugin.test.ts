import { describe, expect, it } from "bun:test";
import antigravityPlugin from "../src/index.ts";
import { buildHubUserAgent, getLiveHubVersion, resolvePlatform } from "../src/manifest.ts";
import { getEffectiveClientId, getEffectiveClientSecret } from "../src/auth.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "../src/constants.ts";
import { listStoredAccounts, maskEmail, restoreAllStoredAccounts } from "../src/accounts.ts";

describe("pi-antigravity-stealth Plugin", () => {
  it("resolves the current live or fallback Hub version and changelist", async () => {
    const { version, changelist } = await getLiveHubVersion();
    expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(changelist).toMatch(/^[0-9]+$/);
  });

  it("builds the canonical Hub User-Agent matching official Google format", async () => {
    const ua = await buildHubUserAgent();
    expect(ua).toMatch(/^antigravity\/hub\/[0-9]+\.[0-9]+\.[0-9]+ \(aidev_client; os_type=(windows|darwin|linux); arch=(amd64|arm64)(; cl=[0-9]+)?\)$/);
  });

  it("masks email addresses for logging and status displays", () => {
    expect(maskEmail("user@domain.com")).toBe("u**r@domain.com");
    expect(maskEmail("trefeon@gmail.com")).toBe("t*****n@gmail.com");
    expect(maskEmail("ab@domain.com")).toBe("*@domain.com");
  });

  it("discovers existing stored Antigravity accounts from local agent.db", () => {
    const accounts = listStoredAccounts();
    expect(Array.isArray(accounts)).toBe(true);
    // On this workstation, 12 accounts exist in agent.db
    if (accounts.length > 0) {
      expect(accounts[0]?.id).toBeDefined();
    }
  });

  it("uses custom OAuth client credentials when provided in env", () => {
    const originalId = process.env.ANTIGRAVITY_CLIENT_ID;
    try {
      process.env.ANTIGRAVITY_CLIENT_ID = "custom-test-client-id.apps.googleusercontent.com";
      expect(getEffectiveClientId()).toBe("custom-test-client-id.apps.googleusercontent.com");
    } finally {
      if (originalId !== undefined) {
        process.env.ANTIGRAVITY_CLIENT_ID = originalId;
      } else {
        delete process.env.ANTIGRAVITY_CLIENT_ID;
      }
    }
    expect(getEffectiveClientId()).toBe(DEFAULT_CLIENT_ID);
    expect(getEffectiveClientSecret()).toBe(DEFAULT_CLIENT_SECRET);
  });

  it("registers provider google-antigravity and unpauses provider in OMP", async () => {
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
    expect(registeredOptions.baseUrl).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(registeredOptions.oauth).toBeDefined();
    expect(registeredCmd).toBe("agy");
  });
});
