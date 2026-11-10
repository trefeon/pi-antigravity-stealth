/**
 * src/index.ts
 *
 * Oh My Pi (OMP) & Pi extension factory for Google Antigravity.
 * Re-enables the paused google-antigravity provider using OMP's native registerProvider escape hatch,
 * enforces live Hub version sync, recovers existing saved accounts, and strips non-compliant headers.
 */

import { ANTIGRAVITY_ENDPOINT_DAILY } from "./constants";
import { buildHubUserAgent, getLiveHubVersion, resolvePlatform } from "./manifest";
import { loginWithBrowser, refreshAccessToken, type AntigravityCredentials } from "./auth";
import { listStoredAccounts, maskEmail, restoreAllStoredAccounts } from "./accounts";

interface ExtensionAPI {
  registerProvider(id: string, options: Record<string, unknown>): void;
  registerCommand?(name: string, handler: (args: string, ctx: unknown) => Promise<void> | void): void;
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

export default async function antigravityPlugin(pi: ExtensionAPI): Promise<void> {
  const { version, changelist } = await getLiveHubVersion();
  const { os, arch } = resolvePlatform();

  // Prime environment so any downstream OMP core components pick up legitimate values
  process.env.PI_AI_ANTIGRAVITY_VERSION = version;
  process.env.PI_AI_ANTIGRAVITY_CL = changelist;
  process.env.PI_AI_ANTIGRAVITY_OS = os;
  process.env.PI_AI_ANTIGRAVITY_ARCH = arch;

  // Inventory saved accounts in agent.db
  const storedAccounts = listStoredAccounts();
  const activeCount = storedAccounts.filter((a) => a.disabledCause === null).length;

  // Registering an OAuth handler under "google-antigravity" populates customOAuthProviders,
  // causing providerPauseReason("google-antigravity") to return undefined in OMP/Pi core.
  pi.registerProvider("google-antigravity", {
    baseUrl: ANTIGRAVITY_ENDPOINT_DAILY,
    oauth: {
      name: "Google Antigravity (Stealth Plugin)",
      async login(callbacks: { onProgress?: (msg: string) => void }) {
        return await loginWithBrowser(callbacks.onProgress);
      },
      async refreshToken(credentials: unknown) {
        if (!credentials || typeof credentials !== "object") {
          throw new Error("Invalid Antigravity credentials object");
        }
        const creds = credentials as AntigravityCredentials;
        if (!creds.refresh_token) {
          return credentials;
        }
        return await refreshAccessToken(creds.refresh_token, creds.projectId);
      },
      getApiKey(credentials: unknown): string {
        if (!credentials || typeof credentials !== "object") return "";
        if ("access_token" in credentials && typeof credentials.access_token === "string") {
          return credentials.access_token;
        }
        if ("access" in credentials && typeof credentials.access === "string") {
          return credentials.access;
        }
        return "";
      },
    },
  });

  // Slash commands for status, accounts, recovery, and login
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("agy", async (args: string) => {
      const parts = args.trim().split(/\s+/);
      const subcmd = parts[0]?.toLowerCase() || "status";

      if (subcmd === "accounts") {
        const accounts = listStoredAccounts();
        if (accounts.length === 0) {
          console.log("No saved Antigravity accounts found in agent.db.");
          console.log("Use '/agy login' to sign in with Google.");
          return;
        }
        console.log(`Saved Antigravity Accounts (${accounts.length}):`);
        for (const a of accounts) {
          const status = a.disabledCause
            ? `[Disabled: ${a.disabledCause}]`
            : a.isExpired
            ? "[Token Expired - refreshable]"
            : "[Active]";
          console.log(
            `  • ${maskEmail(a.email || "Unknown")} (Project: ${a.projectId || "default"}) ${status}`
          );
        }
        return;
      }

      if (subcmd === "restore") {
        const result = restoreAllStoredAccounts();
        console.log(
          `Restored ${result.restored} previously disabled accounts out of ${result.total} total accounts.`
        );
        for (const email of result.accounts) {
          console.log(`  ✓ ${email}`);
        }
        console.log("All saved Antigravity credentials are now active in OMP / Pi.");
        return;
      }

      if (subcmd === "login") {
        console.log("Starting Antigravity OAuth browser sign-in...");
        try {
          const creds = await loginWithBrowser((msg) => console.log(`  [OAuth] ${msg}`));
          console.log(`Successfully authenticated as ${maskEmail(creds.email || "User")}!`);
        } catch (err) {
          console.error("Login failed:", err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (subcmd === "manifest" || subcmd === "refresh") {
        const refreshed = await getLiveHubVersion(5000);
        console.log(
          `Antigravity Manifest Refreshed: v${refreshed.version} (cl=${refreshed.changelist})`
        );
        return;
      }

      // Default: status
      const ua = await buildHubUserAgent();
      console.log(`=== Google Antigravity Stealth Plugin (Pi & OMP) ===`);
      console.log(`Provider: google-antigravity (active override)`);
      console.log(`Endpoint: ${ANTIGRAVITY_ENDPOINT_DAILY}`);
      console.log(`Simulated User-Agent: ${ua}`);
      console.log(`Simulated Client: Antigravity Hub v${version} (CL ${changelist})`);
      console.log(`Saved Accounts in agent.db: ${activeCount} active (${storedAccounts.length} total)`);
      console.log(`\nSubcommands:`);
      console.log(`  /agy status     - Show connection and stealth status (default)`);
      console.log(`  /agy accounts   - List saved Antigravity accounts in agent.db`);
      console.log(`  /agy restore    - Re-activate all saved accounts`);
      console.log(`  /agy login      - Authenticate a new Google account`);
      console.log(`  /agy manifest   - Refresh Google Hub release version`);
    });
  }

  pi.logger.info(
    `pi-antigravity-stealth active (Hub v${version}, cl=${changelist}, ${activeCount} stored accounts loaded)`
  );
}
