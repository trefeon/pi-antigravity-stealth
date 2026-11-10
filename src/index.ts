/**
 * src/index.ts
 *
 * Oh My Pi (OMP) & Pi extension factory for Google Antigravity.
 * Re-enables the paused google-antigravity provider using OMP's native registerProvider escape hatch,
 * enforces live Hub version sync, recovers existing saved accounts, and strips non-compliant headers.
 */

import { ANTIGRAVITY_ENDPOINT_DAILY } from "./constants";
import { buildHubUserAgent, getLiveHubVersion, resolvePlatform } from "./manifest";
import { loginWithBrowser, refreshAccessToken } from "./auth";
import {
  listStoredAccounts,
  maskEmail,
  probeAccountTier,
  removeStoredAccount,
  restoreAllStoredAccounts,
} from "./accounts";

interface ExtensionCommandContext {
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
  hasUI?: boolean;
}

interface ExtensionAPI {
  registerProvider(id: string, options: Record<string, unknown>): void;
  registerCommand?(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx?: ExtensionCommandContext) => Promise<void> | void;
    }
  ): void;
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

function extractCredentials(c: Record<string, unknown>) {
  const token =
    typeof c.access === "string"
      ? c.access
      : typeof c.token === "string"
      ? c.token
      : typeof c.access_token === "string"
      ? c.access_token
      : typeof c.accessToken === "string"
      ? c.accessToken
      : "";

  const projectId =
    typeof c.projectId === "string" && c.projectId.length > 0
      ? c.projectId
      : typeof c.project_id === "string" && c.project_id.length > 0
      ? c.project_id
      : "aicode-consumers";

  const refreshToken =
    typeof c.refresh === "string"
      ? c.refresh
      : typeof c.refresh_token === "string"
      ? c.refresh_token
      : typeof c.refreshToken === "string"
      ? c.refreshToken
      : undefined;

  const expiresAt =
    typeof c.expires === "number"
      ? c.expires
      : typeof c.expires_at === "number"
      ? c.expires_at
      : typeof c.expiresAt === "number"
      ? c.expiresAt
      : undefined;

  const email = typeof c.email === "string" ? c.email : undefined;

  return { token, projectId, refreshToken, expiresAt, email };
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
        const creds = await loginWithBrowser(callbacks.onProgress);
        return {
          access: creds.access_token,
          accessToken: creds.access_token,
          refresh: creds.refresh_token,
          refreshToken: creds.refresh_token,
          expires: creds.expires_at,
          expiresAt: creds.expires_at,
          projectId: creds.projectId,
          email: creds.email,
        };
      },
      async refreshToken(credentials: unknown) {
        if (!credentials || typeof credentials !== "object") {
          throw new Error("Invalid Antigravity credentials object");
        }
        const c = credentials as Record<string, unknown>;
        const extracted = extractCredentials(c);
        if (!extracted.refreshToken) {
          return credentials;
        }

        const refreshed = await refreshAccessToken(extracted.refreshToken, extracted.projectId);
        return {
          ...c,
          access: refreshed.access_token,
          accessToken: refreshed.access_token,
          refresh: refreshed.refresh_token,
          refreshToken: refreshed.refresh_token,
          expires: refreshed.expires_at,
          expiresAt: refreshed.expires_at,
          projectId: refreshed.projectId,
        };
      },
      getApiKey(credentials: unknown): string {
        if (!credentials || typeof credentials !== "object") return "";
        const creds = extractCredentials(credentials as Record<string, unknown>);
        if (!creds.token) return "";

        // OMP's YJi requires JSON string: { token, projectId, refreshToken, expiresAt, email }
        return JSON.stringify({
          token: creds.token,
          projectId: creds.projectId,
          refreshToken: creds.refreshToken,
          expiresAt: creds.expiresAt,
          email: creds.email,
        });
      },
    },
  });

  // Slash commands for status, accounts, recovery, tiers, and removal
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("agy", {
      description: "Manage Google Antigravity stealth status, accounts, and tiers",
      handler: async (args: string, ctx?: ExtensionCommandContext) => {
        function notify(msg: string, level: "info" | "warning" | "error" = "info") {
          if (ctx?.hasUI && ctx.ui) {
            ctx.ui.notify(msg, level);
          } else {
            console.log(msg);
          }
        }

        const parts = args.trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase() || "status";
        const param = parts[1];

        if (subcmd === "accounts") {
          const accounts = listStoredAccounts();
          if (accounts.length === 0) {
            notify("No saved Antigravity accounts found in agent.db.\nUse '/agy login' to sign in with Google.");
            return;
          }
          const lines = [`Saved Antigravity Accounts (${accounts.length}):`];
          for (const a of accounts) {
            const status = a.disabledCause
              ? `[Disabled: ${a.disabledCause}]`
              : a.isExpired
              ? "[Token Expired - refreshable]"
              : "[Active]";
            lines.push(
              `  • #${a.id} ${maskEmail(a.email || "Unknown")} (Project: ${a.projectId || "default"}) ${status}`
            );
          }
          lines.push(`\nUse '/agy tier <id>' to inspect account subscription tier.`);
          lines.push(`Use '/agy remove <email|id>' to deactivate an account.`);
          notify(lines.join("\n"));
          return;
        }

        if (subcmd === "tier" || subcmd === "tiers") {
          const accounts = listStoredAccounts();
          let targets = accounts.filter((a) => a.disabledCause === null && a.token);

          if (param) {
            const needle = param.toLowerCase();
            targets = targets.filter(
              (a) => String(a.id) === needle || (a.email && a.email.toLowerCase().includes(needle))
            );
          }

          if (targets.length === 0) {
            notify(`No active Antigravity account found matching "${param || ""}".`);
            return;
          }

          notify(`Probing subscription tier for ${targets.length} account(s)...`);
          const lines = [`Google Antigravity Account Tiers:`];

          for (const a of targets) {
            if (!a.token) continue;
            const tier = await probeAccountTier(a.token);
            const badge = tier.isPaid ? `[${tier.tierName}] 🌟` : `[${tier.tierName}]`;
            lines.push(`  • #${a.id} ${maskEmail(a.email || "Unknown")}: ${badge}`);
            if (tier.upgradeText) {
              lines.push(`      Note: ${tier.upgradeText}`);
            }
          }
          notify(lines.join("\n"));
          return;
        }

        if (subcmd === "remove" || subcmd === "delete") {
          if (!param) {
            notify("Usage: /agy remove <email|id> [--hard]\nExample: /agy remove user@gmail.com", "warning");
            return;
          }
          const hard = parts.includes("--hard") || parts.includes("-f");
          const result = removeStoredAccount(param, hard);
          notify(result.message, result.success ? "info" : "error");
          return;
        }

        if (subcmd === "restore") {
          const result = restoreAllStoredAccounts();
          const lines = [
            `Restored ${result.restored} previously disabled accounts out of ${result.total} total accounts.`,
          ];
          for (const email of result.accounts) {
            lines.push(`  ✓ ${email}`);
          }
          lines.push("All saved Antigravity credentials are now active in OMP / Pi.");
          notify(lines.join("\n"));
          return;
        }

        if (subcmd === "login") {
          notify("Starting Antigravity OAuth browser sign-in...");
          try {
            const creds = await loginWithBrowser((msg) => notify(`  [OAuth] ${msg}`));
            notify(`Successfully authenticated as ${maskEmail(creds.email || "User")}!`);
          } catch (err) {
            notify(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }

        if (subcmd === "manifest" || subcmd === "refresh") {
          const refreshed = await getLiveHubVersion(5000);
          notify(`Antigravity Manifest Refreshed: v${refreshed.version} (cl=${refreshed.changelist})`);
          return;
        }

        // Default: status
        const ua = await buildHubUserAgent();
        const lines = [
          `=== Google Antigravity Stealth Plugin (Pi & OMP) ===`,
          `Provider: google-antigravity (active override)`,
          `Endpoint: ${ANTIGRAVITY_ENDPOINT_DAILY}`,
          `Simulated User-Agent: ${ua}`,
          `Simulated Client: Antigravity Hub v${version} (CL ${changelist})`,
          `Saved Accounts in agent.db: ${activeCount} active (${storedAccounts.length} total)`,
          ``,
          `Subcommands:`,
          `  /agy status               - Show connection and stealth status (default)`,
          `  /agy accounts             - List saved Antigravity accounts in agent.db`,
          `  /agy tier [email|id]      - Probe subscription tier (Free, Plus, Pro, Ultra)`,
          `  /agy remove <email|id>    - Deactivate an account (soft delete)`,
          `  /agy restore              - Re-activate all soft-deleted accounts`,
          `  /agy login                - Authenticate a new Google account`,
          `  /agy manifest             - Refresh Google Hub release version`,
        ];
        notify(lines.join("\n"));
      },
    });
  }

  pi.logger.info(
    `pi-antigravity-stealth active (Hub v${version}, cl=${changelist}, ${activeCount} stored accounts loaded)`
  );
}
