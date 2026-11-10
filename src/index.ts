/**
 * src/index.ts
 *
 * Oh My Pi (OMP) & Pi extension factory for Google Antigravity.
 * Unpauses OMP's already-shipped google-antigravity provider using registerProvider(),
 * delegates login/refresh/wire transport to OMP's built-in implementation unless custom
 * client credentials are configured, and patches only what is broken (Argon quota isolation,
 * structured API key fields, Hub manifest sync, and /agy account commands).
 */

import { FALLBACK_PROJECT_ID } from "./constants.ts";
import { buildHubUserAgent, getLiveHubVersion, resolvePlatform } from "./manifest.ts";
import { hasCustomOAuthClient, loginWithBrowser, refreshAccessToken, resolveOAuthClientCredentials } from "./auth.ts";
import {
  findOmpAgentDistDir,
  findPiAiPackageDir,
  getBuiltinAntigravityDefinition,
} from "./omp-builtin.ts";
import { createAntigravityUsageProvider } from "./usage.ts";
import {
  findAgentDbPaths,
  listStoredAccounts,
  maskEmail,
  probeAccountTier,
  removeStoredAccount,
  restoreAllStoredAccounts,
  saveAccountToAgentDb,
  type StoredAntigravityAccount,
} from "./accounts.ts";
import {
  detectInstall,
  formatUpdateResult,
  maybeAutoUpdate,
  pendingUpdate,
  readUpdateState,
} from "./updater.ts";

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
  hint?: string;
}

export interface AgySubcommandDef {
  name: string;
  usage?: string;
  takesArgs?: boolean;
  description: string;
}

export const AGY_SUBCOMMANDS: readonly AgySubcommandDef[] = [
  { name: "status", description: "Show plugin, Hub manifest, and account pool status" },
  { name: "accounts", description: "List saved Antigravity accounts in agent.db" },
  { name: "usage", usage: "[email|id]", takesArgs: true, description: "Show live 5h/weekly quota % per pool" },
  { name: "tier", usage: "[email|id]", takesArgs: true, description: "Probe account tier (Free, Plus, Pro, Ultra)" },
  { name: "login", usage: "[--paste]", description: "Authenticate a Google account (--paste for headless SSH)" },
  { name: "remove", usage: "<email|id> [--hard]", takesArgs: true, description: "Deactivate or hard-delete an account" },
  { name: "restore", description: "Re-activate all soft-deleted accounts in agent.db" },
  { name: "manifest", description: "Refresh live Google Hub version and changelist" },
  { name: "doctor", description: "Show sanitized host, OAuth, and updater diagnostics" },
  { name: "update", description: "Check GitHub Releases and auto-update in place" },
];

export function getAgyArgumentCompletions(
  argumentPrefix: string,
  accountsLoader: () => StoredAntigravityAccount[] = listStoredAccounts
): AutocompleteItem[] | null {
  const firstSpace = argumentPrefix.indexOf(" ");
  if (firstSpace < 0) {
    const lower = argumentPrefix.toLowerCase();
    const matches = AGY_SUBCOMMANDS.filter((sub) => sub.name.startsWith(lower)).map((sub) => ({
      value: sub.takesArgs ? `${sub.name} ` : sub.name,
      label: sub.name,
      description: sub.description,
      hint: sub.name.slice(lower.length) + (sub.usage ? ` ${sub.usage}` : ""),
    }));
    return matches.length > 0 ? matches : null;
  }

  const head = argumentPrefix.slice(0, firstSpace).toLowerCase();
  const rest = argumentPrefix.slice(firstSpace + 1);

  if (head === "login") {
    const flag = "--paste";
    const needle = rest.trimStart().toLowerCase();
    if (!flag.startsWith(needle)) return null;
    return [
      {
        value: "login --paste",
        label: "--paste",
        description: "Prompt to paste the redirected OAuth callback URL (headless SSH)",
        hint: flag.slice(needle.length),
      },
    ];
  }

  if (head !== "tier" && head !== "tiers" && head !== "usage" && head !== "remove" && head !== "delete") {
    return null;
  }

  const secondSpace = rest.indexOf(" ");
  if (secondSpace >= 0) {
    if (head === "remove" || head === "delete") {
      const target = rest.slice(0, secondSpace).trim();
      const flagNeedle = rest.slice(secondSpace + 1).trimStart().toLowerCase();
      if (target && "--hard".startsWith(flagNeedle)) {
        return [
          {
            value: `${head} ${target} --hard`,
            label: "--hard",
            description: "Permanently delete row from agent.db",
            hint: "--hard".slice(flagNeedle.length),
          },
        ];
      }
    }
    return null;
  }

  const needle = rest.toLowerCase();
  let accounts: StoredAntigravityAccount[] = [];
  try {
    accounts = accountsLoader();
  } catch {
    return null;
  }

  const matches = accounts
    .filter((a) => {
      const idStr = String(a.id);
      const emailLower = (a.email || "").toLowerCase();
      return idStr.startsWith(needle) || emailLower.includes(needle);
    })
    .map((a) => {
      const idStr = String(a.id);
      const stateTag = a.disabledCause ? "disabled" : a.isExpired ? "expired" : "active";
      return {
        value: `${head} ${idStr}`,
        label: `#${idStr}`,
        description: `${maskEmail(a.email || "Unknown")} (${stateTag})`,
        hint: idStr.startsWith(needle) ? idStr.slice(needle.length) : undefined,
      };
    });

  return matches.length > 0 ? matches : null;
}

function formatResetCountdown(resetsAt?: number): string {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return "";
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return " (resetting)";
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return ` (resets in ${days}d ${hours}h)`;
  if (hours > 0) return ` (resets in ${hours}h ${mins}m)`;
  return ` (resets in ${mins}m)`;
}

interface ExtensionCommandContext {
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
  };
  hasUI?: boolean;
}

interface ExtensionAPI {
  registerProvider(id: string, options: Record<string, unknown>): void;
  registerCommand?(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
      handler: (args: string, ctx?: ExtensionCommandContext) => Promise<void> | void;
    }
  ): void;
  on?(
    event: string,
    handler: (event: unknown, ctx?: ExtensionCommandContext) => Promise<void> | void
  ): void;
  logger?: {
    info?(msg: string): void;
    warn?(msg: string): void;
    error?(msg: string): void;
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
      description:
        "Antigravity: status | accounts | usage | tier | login | remove | restore | manifest | doctor | update",
      getArgumentCompletions: (prefix: string) => getAgyArgumentCompletions(prefix),
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

        if (subcmd === "usage" || subcmd === "quota") {
          const accounts = listStoredAccounts();
          let targets = accounts.filter((a) => a.disabledCause === null && (a.token || a.refreshToken));

          if (param) {
            const needle = param.toLowerCase();
            const numeric = /^\d+$/.test(needle);
            targets = targets.filter((a) =>
              numeric ? String(a.id) === needle : Boolean(a.email && a.email.toLowerCase().includes(needle))
            );
          }

          if (targets.length === 0) {
            notify(`No active Antigravity account found matching "${param || ""}".`);
            return;
          }

          notify(`Fetching live quota summary for ${targets.length} account(s)...`);
          const usageProvider = createAntigravityUsageProvider();
          const lines = ["Google Antigravity Quota Summary:"];

          for (const a of targets) {
            let accessToken = a.token || "";
            let projectId = a.projectId || FALLBACK_PROJECT_ID;
            if ((a.isExpired || !accessToken) && a.refreshToken) {
              try {
                const refreshed = await runUnifiedRefresh({
                  refresh: a.refreshToken,
                  projectId,
                  email: a.email,
                });
                const extracted = extractCredentials(refreshed);
                if (extracted.token) {
                  accessToken = extracted.token;
                  projectId = extracted.projectId;
                  saveAccountToAgentDb({
                    access_token: accessToken,
                    refresh_token: extracted.refreshToken || a.refreshToken,
                    expires_at: extracted.expiresAt,
                    projectId,
                    email: a.email,
                  });
                }
              } catch {}
            }

            if (!accessToken) {
              lines.push(`  • #${a.id} ${maskEmail(a.email || "Unknown")}: [Token unavailable — run '/agy login']`);
              continue;
            }

            const report = await usageProvider.fetchUsage(
              {
                provider: "google-antigravity",
                credential: {
                  accessToken,
                  projectId,
                  email: a.email,
                },
              },
              { fetch }
            );

            lines.push(`  • #${a.id} ${maskEmail(a.email || "Unknown")} (Project: ${projectId}):`);
            if (!report || report.limits.length === 0) {
              lines.push("      No quota buckets returned.");
              continue;
            }

            const seenShared = new Set<string>();
            for (const limit of report.limits) {
              const sharedGroup =
                typeof limit.scope?.sharedGroup === "string" ? limit.scope.sharedGroup : undefined;
              if (sharedGroup) {
                if (seenShared.has(sharedGroup)) continue;
                seenShared.add(sharedGroup);
              }
              const pct =
                typeof limit.amount?.remainingFraction === "number"
                  ? `${Math.round(limit.amount.remainingFraction * 100)}% left`
                  : limit.status || "unknown";
              const winLabel = limit.window?.label ? ` (${limit.window.label})` : "";
              const resetText = formatResetCountdown(limit.window?.resetsAt);
              lines.push(`      - ${limit.label || limit.id}${winLabel}: ${pct}${resetText}`);
            }
          }
          notify(lines.join("\n"));
          return;
        }

        if (subcmd === "tier" || subcmd === "tiers") {
          const accounts = listStoredAccounts();
          let targets = accounts.filter((a) => a.disabledCause === null && (a.token || a.refreshToken));

          if (param) {
            const needle = param.toLowerCase();
            const numeric = /^\d+$/.test(needle);
            targets = targets.filter((a) =>
              numeric ? String(a.id) === needle : Boolean(a.email && a.email.toLowerCase().includes(needle))
            );
          }

          if (targets.length === 0) {
            notify(`No active Antigravity account found matching "${param || ""}".`);
            return;
          }

          notify(`Probing subscription tier for ${targets.length} account(s)...`);
          const lines = [`Google Antigravity Account Tiers:`];

          for (const a of targets) {
            let accessToken = a.token || "";
            if ((a.isExpired || !accessToken) && a.refreshToken) {
              try {
                const refreshed = await runUnifiedRefresh({
                  refresh: a.refreshToken,
                  projectId: a.projectId,
                  email: a.email,
                });
                const extracted = extractCredentials(refreshed);
                if (extracted.token) {
                  accessToken = extracted.token;
                  saveAccountToAgentDb({
                    access_token: accessToken,
                    refresh_token: extracted.refreshToken || a.refreshToken,
                    expires_at: extracted.expiresAt,
                    projectId: extracted.projectId,
                    email: a.email,
                  });
                }
              } catch {}
            }
            if (!accessToken) continue;
            const tier = await probeAccountTier(accessToken);
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
            notify("Usage: /agy remove <email|id> [--hard]\nExample: /agy remove 1", "warning");
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
          const usePastePrompt = parts.includes("--paste") || parts.includes("--manual");
          notify("Starting Antigravity OAuth sign-in...");
          try {
            const creds = await loginWithBrowser({
              openBrowser: !usePastePrompt,
              onAuth: (info) => {
                notify(`Open OAuth URL in browser:\n${info.url}\n${info.instructions || ""}`);
              },
              onProgress: (msg) => notify(`  [OAuth] ${msg}`),
              ...(usePastePrompt && ctx?.ui?.input
                ? {
                    onPrompt: async (prompt) => {
                      const val = await ctx.ui!.input!(prompt.message, prompt.placeholder);
                      if (!val) throw new Error("Antigravity login cancelled.");
                      return val;
                    },
                  }
                : {}),
            });
            const saved = saveAccountToAgentDb(creds);
            notify(
              saved
                ? `Successfully authenticated as ${maskEmail(creds.email || "User")}! Credential saved to agent.db.`
                : `Authenticated as ${maskEmail(creds.email || "User")}, but could not write agent.db.`
            );
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

        if (subcmd === "doctor") {
          const install = detectInstall();
          const runtime =
            typeof process.versions?.bun === "string"
              ? `Bun ${process.versions.bun}`
              : `Node ${process.version}`;
          const distDir = findOmpAgentDistDir();
          const piAiDir = findPiAiPackageDir();
          const resolvedCreds = resolveOAuthClientCredentials();
          const dbPaths = findAgentDbPaths();
          const accounts = listStoredAccounts();
          const activeAcc = accounts.filter((a) => a.disabledCause === null && !a.isExpired).length;
          const expiredAcc = accounts.filter((a) => a.disabledCause === null && a.isExpired).length;
          const disabledAcc = accounts.filter((a) => a.disabledCause !== null).length;
          const upd = readUpdateState();
          const ua = await buildHubUserAgent();

          const lines = [
            `=== pi-antigravity-stealth Doctor ===`,
            `Plugin: v${install.version} (${install.kind}) @ ${install.root}`,
            `Host Runtime: ${runtime} (${process.platform}/${process.arch})`,
            `OMP Built-in Dist: ${distDir ?? "not found (standalone binary or Pi)"}`,
            `OMP Built-in pi-ai: ${piAiDir ?? "not found"}`,
            `OAuth Client Creds: ${
              hasCustomOAuthClient()
                ? "Custom env (ANTIGRAVITY_CLIENT_ID/SECRET)"
                : resolvedCreds.clientId && resolvedCreds.clientSecret
                ? "OMP Built-in rules.json"
                : "MISSING (set ANTIGRAVITY_CLIENT_ID & ANTIGRAVITY_CLIENT_SECRET for /agy login)"
            }`,
            `Database Paths: ${dbPaths.length > 0 ? dbPaths.join(", ") : "none created yet"}`,
            `Accounts: ${activeAcc} active, ${expiredAcc} expired, ${disabledAcc} disabled`,
            `Hub User-Agent: ${ua}`,
            `Updater Cache: ${
              upd
                ? `latest=v${upd.latest ?? "?"}, checked=${upd.checkedAt ? new Date(upd.checkedAt).toISOString() : "never"}${
                    upd.lastError ? `, lastError=${upd.lastError}` : ""
                  }`
                : "no cached check yet"
            }`,
          ];
          notify(lines.join("\n"));
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
          `Subcommands (type '/agy ' for autocomplete):`,
          ...AGY_SUBCOMMANDS.map(
            (s) => `  /agy ${(s.usage ? `${s.name} ${s.usage}` : s.name).padEnd(26)} - ${s.description}`
          ),
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
          pi.logger?.info?.(formatUpdateResult(result));
        }
      })
      .catch(() => {});
  });

  pi.logger?.info?.(
    `pi-antigravity-stealth active (Hub v${version}, cl=${changelist}, ${activeCount} stored accounts loaded)`
  );
}