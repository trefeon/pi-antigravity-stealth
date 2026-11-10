/**
 * src/index.ts
 *
 * Oh My Pi (OMP) & Pi extension factory for Google Antigravity.
 * Unpauses OMP's already-shipped google-antigravity provider using registerProvider(),
 * delegates login/refresh/wire transport to OMP's built-in implementation unless custom
 * client credentials are configured, and patches only what is broken (Argon quota isolation,
 * structured API key fields, Hub manifest sync, and /agy account commands).
 */

import { FALLBACK_PROJECT_ID } from "./constants";
import { buildHubUserAgent, getLiveHubVersion, resolvePlatform } from "./manifest";
import { hasCustomOAuthClient, loginWithBrowser, refreshAccessToken } from "./auth";
import { getBuiltinAntigravityDefinition } from "./omp-builtin";
import { createAntigravityUsageProvider } from "./usage";
import {
  listStoredAccounts,
  maskEmail,
  probeAccountTier,
  removeStoredAccount,
  restoreAllStoredAccounts,
  saveAccountToAgentDb,
} from "./accounts";
import {
  detectInstall,
  formatUpdateResult,
  maybeAutoUpdate,
  pendingUpdate,
} from "./updater";

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
  on?(
    event: string,
    handler: (event: unknown, ctx?: ExtensionCommandContext) => Promise<void> | void
  ): void;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export function extractCredentials(c: Record<string, unknown>) {
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
      : FALLBACK_PROJECT_ID;

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

  const email = typeof c.email === "string" && c.email.length > 0 ? c.email : undefined;
  const accountId = typeof c.accountId === "string" && c.accountId.length > 0 ? c.accountId : undefined;
  const apiEndpoint = typeof c.apiEndpoint === "string" && c.apiEndpoint.length > 0 ? c.apiEndpoint : undefined;
  const enterpriseUrl = typeof c.enterpriseUrl === "string" && c.enterpriseUrl.length > 0 ? c.enterpriseUrl : undefined;

  return { token, projectId, refreshToken, expiresAt, email, accountId, apiEndpoint, enterpriseUrl };
}

export function formatStructuredApiKey(credentials: Record<string, unknown>): string {
  const creds = extractCredentials(credentials);
  if (!creds.token) return "";

  // Matches OMP's getOAuthApiKey structured credential envelope (`apiKeyFormat: "structured"`).
  return JSON.stringify({
    ...(creds.apiEndpoint !== undefined ? { apiEndpoint: creds.apiEndpoint } : {}),
    token: creds.token,
    ...(creds.enterpriseUrl !== undefined ? { enterpriseUrl: creds.enterpriseUrl } : {}),
    projectId: creds.projectId,
    ...(creds.refreshToken !== undefined ? { refreshToken: creds.refreshToken } : {}),
    ...(creds.expiresAt !== undefined ? { expiresAt: creds.expiresAt } : {}),
    ...(creds.email !== undefined ? { email: creds.email } : {}),
    ...(creds.accountId !== undefined ? { accountId: creds.accountId } : {}),
  });
}

async function runUnifiedLogin(callbacks: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (hasCustomOAuthClient()) {
    const creds = await loginWithBrowser(callbacks);
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
  }

  const builtin = await getBuiltinAntigravityDefinition();
  if (builtin?.login) {
    return builtin.login(callbacks);
  }

  const creds = await loginWithBrowser(callbacks);
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
}

async function runUnifiedRefresh(credentials: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!credentials || typeof credentials !== "object") {
    throw new Error("Invalid Antigravity credentials object");
  }
  const c = credentials as Record<string, unknown>;
  const extracted = extractCredentials(c);
  if (!extracted.refreshToken) {
    return c;
  }

  if (!hasCustomOAuthClient()) {
    const builtin = await getBuiltinAntigravityDefinition();
    if (builtin?.refreshToken) {
      const refreshed = await builtin.refreshToken(c, signal);
      return {
        ...c,
        ...refreshed,
        projectId:
          typeof refreshed.projectId === "string" && refreshed.projectId.length > 0
            ? refreshed.projectId
            : extracted.projectId,
        ...(typeof refreshed.email === "string" && refreshed.email.length > 0
          ? { email: refreshed.email }
          : extracted.email
          ? { email: extracted.email }
          : {}),
        ...(typeof refreshed.accountId === "string" && refreshed.accountId.length > 0
          ? { accountId: refreshed.accountId }
          : extracted.accountId
          ? { accountId: extracted.accountId }
          : {}),
      };
    }
  }

  const refreshed = await refreshAccessToken(extracted.refreshToken, extracted.projectId, {
    email: extracted.email,
    accountId: extracted.accountId,
    signal,
  });
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
}

export default async function antigravityPlugin(pi: ExtensionAPI): Promise<void> {
  const { version, changelist } = await getLiveHubVersion();
  const { os, arch } = resolvePlatform();

  // Prime environment defaults only when unset so user overrides remain authoritative
  process.env.PI_AI_ANTIGRAVITY_VERSION ??= version;
  process.env.PI_AI_ANTIGRAVITY_CL ??= changelist;
  process.env.PI_AI_ANTIGRAVITY_OS ??= os;
  process.env.PI_AI_ANTIGRAVITY_ARCH ??= arch;

  // Inventory saved accounts in agent.db
  const storedAccounts = listStoredAccounts();
  const activeCount = storedAccounts.filter((a) => a.disabledCause === null).length;

  const baseUrlOverride = process.env.ANTIGRAVITY_BASE_URL?.trim();

  // Registering an OAuth handler under "google-antigravity" populates customOAuthProviders,
  // causing providerPauseReason("google-antigravity") to return undefined in OMP/Pi core.
  // Preserve OMP's built-in endpoint auto-failover ([daily, sandbox]), model discovery, and
  // google-gemini-cli transport, patching only OAuth delegation and Argon usage isolation.
  pi.registerProvider("google-antigravity", {
    ...(baseUrlOverride ? { baseUrl: baseUrlOverride } : {}),
    usage: createAntigravityUsageProvider(),
    oauth: {
      name: "Google Antigravity (Stealth Plugin)",
      login: runUnifiedLogin,
      refreshToken: runUnifiedRefresh,
      getApiKey(credentials: unknown): string {
        if (!credentials || typeof credentials !== "object") return "";
        return formatStructuredApiKey(credentials as Record<string, unknown>);
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
            const creds = await loginWithBrowser({
              onProgress: (msg) => notify(`  [OAuth] ${msg}`),
            });
            saveAccountToAgentDb(creds);
            notify(`Successfully authenticated as ${maskEmail(creds.email || "User")}! Credential saved to agent.db.`);
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

        if (subcmd === "update" || subcmd === "upgrade") {
          notify("Checking GitHub Releases for pi-antigravity-stealth updates...");
          const result = await maybeAutoUpdate({ force: true });
          const level =
            result.status === "failed" ? "error" : result.status === "unavailable" ? "warning" : "info";
          notify(formatUpdateResult(result), level);
          return;
        }

        // Default: status
        const ua = await buildHubUserAgent();
        const oauthMode = hasCustomOAuthClient() ? "Custom OAuth Client (env)" : "OMP Built-in OAuth";
        const install = detectInstall();
        const pending = pendingUpdate(undefined, install.version);
        const lines = [
          `=== Google Antigravity Stealth Plugin (Pi & OMP) ===`,
          `Plugin Version: v${install.version} (${install.kind})`,
          ...(pending ? [`Update Notice: ${pending}`] : []),
          `Provider: google-antigravity (built-in + stealth unpause)`,
          `Endpoint: ${baseUrlOverride || "OMP auto [daily-cloudcode-pa, sandbox]"}`,
          `OAuth Mode: ${oauthMode}`,
          `Usage Patch: Argon bucket isolated from Gemini (google) counter`,
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
          `  /agy update               - Check GitHub Releases and auto-update`,
        ];
        notify(lines.join("\n"));
      },
    });
  }

  // Background non-blocking GitHub Release update check on interactive session start
  pi.on?.("session_start", (_event, ctx) => {
    if (!ctx?.hasUI) return;
    if (process.env.PI_ANTIGRAVITY_SKIP_UPDATE_CHECK) return;
    if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") return;
    void maybeAutoUpdate()
      .then((result) => {
        if (result.status !== "updated" && result.status !== "failed") return;
        const level = result.status === "updated" ? "info" : "warning";
        if (ctx.ui) {
          ctx.ui.notify(formatUpdateResult(result), level);
        } else {
          pi.logger.info(formatUpdateResult(result));
        }
      })
      .catch(() => {});
  });

  pi.logger.info(
    `pi-antigravity-stealth active (Hub v${version}, cl=${changelist}, ${activeCount} stored accounts loaded)`
  );
}