/**
 * src/accounts.ts
 *
 * Discovery, tier detection, and management of saved Google Antigravity OAuth credentials in agent.db (OMP / Pi).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createRequire } from "module";
import {
  ANTIGRAVITY_ENDPOINT_DAILY,
  APPEAL_FORM_URL,
  FALLBACK_PROJECT_ID,
} from "./constants.ts";
import { buildHubUserAgent } from "./manifest.ts";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDb {
  query(sql: string): SqliteStatement;
  close(): void;
}

const requireFromHere = createRequire(import.meta.url);

function openSqlite(dbPath: string, readonly: boolean): SqliteDb | null {
  try {
    if (typeof process.versions?.bun === "string") {
      const mod = requireFromHere("bun:sqlite") as {
        Database: new (p: string, opts?: { readonly?: boolean }) => SqliteDb;
      };
      return new mod.Database(dbPath, readonly ? { readonly: true } : undefined);
    }
  } catch {}

  try {
    const mod = requireFromHere("node:sqlite") as {
      DatabaseSync: new (
        p: string,
        opts?: { readOnly?: boolean }
      ) => { prepare(sql: string): SqliteStatement; close(): void };
    };
    const db = new mod.DatabaseSync(dbPath, readonly ? { readOnly: true } : undefined);
    return {
      query: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}
export interface AccountTierInfo {
  tierId: string;
  tierName: string;
  isPaid: boolean;
  upgradeText?: string;
}

export interface StoredAntigravityAccount {
  id: number;
  email?: string;
  projectId?: string;
  expiresAt?: number;
  isExpired: boolean;
  hasRefreshToken: boolean;
  disabledCause: string | null;
  dbPath: string;
  token?: string;
  refreshToken?: string;
  /** OAuth client that minted the stored refresh token (client-bound refresh). */
  oauthClientId?: string;
}

export interface SaveAccountInput {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  projectId?: string;
  email?: string;
  /** OAuth client that minted the refresh token (client-bound refresh). */
  oauthClientId?: string;
}

export function findAgentDbPaths(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    path.join(home, ".omp", "agent", "agent.db"),
    path.join(home, ".pi", "agent", "agent.db"),
  ];

  return candidates.filter((p) => fs.existsSync(p));
}

export function maskEmail(email: string): string {
  const parts = email.split("@");
  if (parts.length !== 2) return email;
  const [user, domain] = parts;
  if (!user || user.length <= 2) return `*@${domain}`;
  const first = user[0];
  const last = user[user.length - 1];
  return `${first}${"*".repeat(Math.max(1, user.length - 2))}${last}@${domain}`;
}

export function listStoredAccounts(): StoredAntigravityAccount[] {
  const dbPaths = findAgentDbPaths();
  const accounts: StoredAntigravityAccount[] = [];

  for (const dbPath of dbPaths) {
    try {
      const db = openSqlite(dbPath, true);
      if (!db) continue;
      const rows = db
        .query(
          "SELECT id, identity_key, data, disabled_cause FROM auth_credentials WHERE provider = 'google-antigravity'"
        )
        .all() as Array<{
        id: number;
        identity_key: string | null;
        data: string;
        disabled_cause: string | null;
      }>;

      for (const row of rows) {
        let email: string | undefined;
        let projectId: string | undefined;
        let expiresAt: number | undefined;
        let token: string | undefined;
        let hasRefreshToken = false;
        let refreshToken: string | undefined;
        let oauthClientId: string | undefined;

        if (row.identity_key?.startsWith("email:")) {
          email = row.identity_key.slice(6);
        }

        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          if (!email && typeof parsed.email === "string") {
            email = parsed.email;
          }
          if (typeof parsed.oauthClientId === "string" && parsed.oauthClientId.length > 0) {
            oauthClientId = parsed.oauthClientId;
          } else if (typeof parsed.oauth_client_id === "string" && parsed.oauth_client_id.length > 0) {
            oauthClientId = parsed.oauth_client_id;
          }
          if (typeof parsed.projectId === "string") {
            projectId = parsed.projectId;
          }
          if (typeof parsed.access === "string") {
            token = parsed.access;
          } else if (typeof parsed.access_token === "string") {
            token = parsed.access_token;
          }
          if (typeof parsed.expires === "number") {
            expiresAt = parsed.expires;
          } else if (typeof parsed.expires_at === "number") {
            expiresAt = parsed.expires_at;
          }
          if (typeof parsed.refresh === "string" && parsed.refresh.length > 0) {
            refreshToken = parsed.refresh;
            hasRefreshToken = true;
          } else if (typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0) {
            refreshToken = parsed.refresh_token;
            hasRefreshToken = true;
          }
        } catch {}
        const isExpired = expiresAt !== undefined ? Date.now() >= expiresAt : false;

        accounts.push({
          id: row.id,
          email,
          projectId,
          expiresAt,
          isExpired,
          hasRefreshToken,
          disabledCause: row.disabled_cause,
          dbPath,
          token,
          refreshToken,
          oauthClientId,
        });
      }
      db.close();
    } catch {}
  }

  return accounts;
}


function ensureSaveAgentDbPaths(): string[] {
  const existing = findAgentDbPaths();
  if (existing.length > 0) return existing;

  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) return [];
  const defaultDir = path.join(home, ".omp", "agent");
  const defaultDb = path.join(defaultDir, "agent.db");
  try {
    fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    const db = openSqlite(defaultDb, false);
    if (!db) return [];
    db.query(
      "CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ).run();
    db.close();
    return [defaultDb];
  } catch {
    return [];
  }
}
export function saveAccountToAgentDb(creds: SaveAccountInput): boolean {
  const dbPaths = ensureSaveAgentDbPaths();
  const email = creds.email || "unknown";
  const identityKey = `email:${email}`;
  const now = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({
    access: creds.access_token,
    refresh: creds.refresh_token,
    expires: creds.expires_at,
    email: creds.email,
    projectId: creds.projectId || FALLBACK_PROJECT_ID,
    authorizedAt: Date.now(),
    ...(creds.oauthClientId ? { oauthClientId: creds.oauthClientId } : {}),
  });

  let savedAny = false;
  for (const dbPath of dbPaths) {
    try {
      const db = openSqlite(dbPath, false);
      if (!db) continue;
      const existing = db
        .query(
          "SELECT id FROM auth_credentials WHERE provider = 'google-antigravity' AND identity_key = ?"
        )
        .get(identityKey) as { id: number } | null;

      if (existing) {
        db.query(
          "UPDATE auth_credentials SET data = ?, disabled_cause = NULL, updated_at = ? WHERE id = ?"
        ).run(data, now, existing.id);
      } else {
        db.query(
          "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES ('google-antigravity', 'oauth', ?, NULL, ?, ?, ?)"
        ).run(data, identityKey, now, now);
      }
      db.close();
      savedAny = true;
    } catch {}
  }

  return savedAny;
}

/**
 * Records which OAuth client minted a credential's refresh token
 * (`oauthClientId` inside the row's data JSON). Refresh tokens are bound to
 * their issuing client, so refresh paths need this binding hint.
 */
export function recordCredentialClient(
  identifier: { email?: string; refreshToken?: string },
  clientId: string
): boolean {
  if (!identifier.email && !identifier.refreshToken) return false;

  const dbPaths = findAgentDbPaths();
  let updated = false;

  for (const dbPath of dbPaths) {
    try {
      const db = openSqlite(dbPath, false);
      if (!db) continue;
      const rows = db
        .query(
          "SELECT id, identity_key, data FROM auth_credentials WHERE provider = 'google-antigravity'"
        )
        .all() as Array<{ id: number; identity_key: string | null; data: string }>;

      for (const row of rows) {
        const rowEmail = row.identity_key?.startsWith("email:")
          ? row.identity_key.slice("email:".length).toLowerCase()
          : "";
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(row.data) as Record<string, unknown>;
        } catch {}
        const rowRefresh =
          typeof parsed.refresh === "string" ? parsed.refresh : typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";

        const emailMatch = Boolean(identifier.email && rowEmail && rowEmail === identifier.email.toLowerCase());
        const refreshMatch = Boolean(identifier.refreshToken && rowRefresh && rowRefresh === identifier.refreshToken);
        if (!emailMatch && !refreshMatch) continue;

        const next = { ...parsed, oauthClientId: clientId };
        db.query("UPDATE auth_credentials SET data = ? WHERE id = ?").run(JSON.stringify(next), row.id);
        updated = true;
      }
      db.close();
    } catch {}
  }

  return updated;
}

export function restoreAllStoredAccounts(): {
  restored: number;
  total: number;
  accounts: string[];
} {
  const dbPaths = findAgentDbPaths();
  let restored = 0;
  let total = 0;
  const accounts: string[] = [];

  for (const dbPath of dbPaths) {
    try {
      const db = openSqlite(dbPath, false);
      if (!db) continue;
      const rows = db
        .query(
          "SELECT id, identity_key, disabled_cause FROM auth_credentials WHERE provider = 'google-antigravity'"
        )
        .all() as Array<{
        id: number;
        identity_key: string | null;
        disabled_cause: string | null;
      }>;

      total += rows.length;

      for (const row of rows) {
        const email = row.identity_key?.startsWith("email:")
          ? row.identity_key.slice(6)
          : `Account #${row.id}`;

        if (row.disabled_cause !== null) {
          db.query(
            "UPDATE auth_credentials SET disabled_cause = NULL WHERE id = ?"
          ).run(row.id);
          restored++;
        }
        accounts.push(maskEmail(email));
      }
      db.close();
    } catch {}
  }

  return { restored, total, accounts };
}

export function removeStoredAccount(
  identifier: string,
  hard = false,
  cause = "deleted by user"
): { success: boolean; affected: number; message: string } {
  const target = identifier.trim().toLowerCase();
  if (!target) {
    return { success: false, affected: 0, message: "Please specify an account email or ID." };
  }

  const dbPaths = findAgentDbPaths();
  let affected = 0;

  for (const dbPath of dbPaths) {
    try {
      const db = openSqlite(dbPath, false);
      if (!db) continue;
      const rows = db
        .query(
          "SELECT id, identity_key FROM auth_credentials WHERE provider = 'google-antigravity'"
        )
        .all() as Array<{ id: number; identity_key: string | null }>;

      for (const row of rows) {
        const idMatch = String(row.id) === target;
        const identity = row.identity_key?.toLowerCase() || "";
        const email = identity.startsWith("email:") ? identity.slice("email:".length) : "";
        // Exact match only: substring targeting with --hard permanently deleted
        // unintended accounts ("ice@x.com" matched "malice@x.com" too).
        const emailMatch = email === target;

        if (idMatch || emailMatch) {
          if (hard) {
            db.query("DELETE FROM auth_credentials WHERE id = ?").run(row.id);
          } else {
            db.query(
              "UPDATE auth_credentials SET disabled_cause = ? WHERE id = ?"
            ).run(cause, row.id);
          }
          affected++;
        }
      }
      db.close();
    } catch (err) {
      return {
        success: false,
        affected,
        message: `Database error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (affected === 0) {
    return {
      success: false,
      affected: 0,
      message: `No Antigravity account matched "${identifier}" exactly. Use '/agy accounts' to list exact emails and IDs.`,
    };
  }

  const actionStr = hard ? "permanently deleted" : "deactivated (soft-deleted)";
  return {
    success: true,
    affected,
    message: `Successfully ${actionStr} ${affected} account(s). Use '/agy restore' to re-activate soft-deleted accounts.`,
  };
}

export function markAccountDisabled(
  identifier: string,
  cause = "403: Terms of Service violation"
): { success: boolean; affected: number; message: string } {
  return removeStoredAccount(identifier, false, cause);
}

/**
 * `sessionId` as the official client sends it: a signed decimal string
 * (mirrors pi-ai's `randomSignedDecimalSessionId`).
 */
function randomSignedDecimalSessionId(): string {
  try {
    const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 15);
    const raw = BigInt(`0x${hex}`);
    const sign = (raw & 1n) === 1n ? "" : "-";
    return `${sign}${raw}`;
  } catch {
    return `${Date.now()}`;
  }
}

/**
 * Full 1:1 Antigravity client request identity for inference calls, extracted
 * from `agy` v1.5.9 and cross-checked against pi-ai's live-verified envelope:
 * `requestId` is `agent/<agentId>/<ts>/<trajectoryId>/<step>`; `labels` carry
 * cascade ids; the top level carries `project`, `model`, `request`,
 * `userAgent: "antigravity"`.
 */
export function buildAntigravityProbeEnvelope(project: string, model: string, prompt = "ping") {
  const agentId = crypto.randomUUID();
  const trajectoryId = crypto.randomUUID();
  const step = 1;
  return {
    project,
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    request: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1 },
      sessionId: randomSignedDecimalSessionId(),
      labels: {
        cascade_id: agentId,
        root_cascade_id: agentId,
        last_step_index: String(step - 1),
        used_non_gemini_model: "false",
      },
    },
    model,
    userAgent: "antigravity",
  };
}

/**
 * Headers exactly as the official client sends them on inference
 * (`Accept: text/event-stream` + `Accept-Encoding: gzip`, Go-client style).
 * NEVER sends `X-Goog-Api-Client` or `Client-Metadata` — the Hub backend
 * treats their presence on inference as a third-party-wrapper indicator.
 */
export async function buildInferenceRequestHeaders(token: string): Promise<Record<string, string>> {
  const userAgent = await buildHubUserAgent();
  return {
    Accept: "text/event-stream",
    "Accept-Encoding": "gzip",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "x-cloudaicompanion-trace-id": crypto.randomUUID(),
  };
}

/**
 * Control-plane headers (loadCodeAssist / fetchAvailableModels / quota).
 */
export async function buildControlRequestHeaders(token: string): Promise<Record<string, string>> {
  const userAgent = await buildHubUserAgent();
  return {
    "Accept-Encoding": "gzip",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "x-cloudaicompanion-trace-id": crypto.randomUUID(),
  };
}

export function purgeBannedAccounts(): {
  purged: number;
  accounts: string[];
} {
  const dbPaths = findAgentDbPaths();
  let purged = 0;
  const accounts: string[] = [];

  for (const dbPath of dbPaths) {
    try {
      const db = openSqlite(dbPath, false);
      if (!db) continue;
      const rows = db
        .query(
          "SELECT id, identity_key, disabled_cause FROM auth_credentials WHERE provider = 'google-antigravity'"
        )
        .all() as Array<{
        id: number;
        identity_key: string | null;
        disabled_cause: string | null;
      }>;

      for (const row of rows) {
        const isBanned =
          row.disabled_cause !== null &&
          (row.disabled_cause.includes("Terms of Service") ||
            row.disabled_cause.includes("403") ||
            row.disabled_cause.includes("banned"));

        if (isBanned) {
          const email = row.identity_key?.startsWith("email:")
            ? row.identity_key.slice("email:".length)
            : `ID #${row.id}`;
          db.query("DELETE FROM auth_credentials WHERE id = ?").run(row.id);
          accounts.push(maskEmail(email));
          purged++;
        }
      }
      db.close();
    } catch {}
  }

  return { purged, accounts };
}

export interface AccountInferenceHealth {
  status: "healthy" | "banned" | "error";
  statusCode?: number;
  message?: string;
}

export async function probeAccountInference(
  account: StoredAntigravityAccount,
  customFetch: typeof fetch = fetch
): Promise<AccountInferenceHealth> {
  const token = account.token;
  if (!token) {
    return { status: "error", message: "No access token available" };
  }
  const project = account.projectId && account.projectId.length > 0 ? account.projectId : FALLBACK_PROJECT_ID;
  const headers = await buildInferenceRequestHeaders(token);
  const envelope = buildAntigravityProbeEnvelope(project, "gemini-3.8-flash-high");

  try {
    const res = await customFetch(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });

    if (res.ok) {
      return { status: "healthy", statusCode: res.status };
    }

    const text = await res.text();
    const isBanned =
      res.status === 403 &&
      (text.includes("violation of Terms of Service") ||
        text.includes("PERMISSION_DENIED") ||
        text.includes("disabled in this account"));

    if (isBanned) {
      return {
        status: "banned",
        statusCode: res.status,
        message: `This service has been disabled in this account for violation of Terms of Service. Appeal: ${APPEAL_FORM_URL}`,
      };
    }

    return {
      status: "error",
      statusCode: res.status,
      message: text.slice(0, 200),
    };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AccountAuditReport {
  total: number;
  active: number;
  healthy: number;
  quarantined: number;
  results: Array<{
    id: number;
    email?: string;
    status: "healthy" | "banned" | "error" | "already-disabled";
    quarantinedNow: boolean;
    message?: string;
  }>;
}

export async function auditAndQuarantineAccounts(
  autoRemove = true,
  customFetch: typeof fetch = fetch
): Promise<AccountAuditReport> {
  const accounts = listStoredAccounts();
  const report: AccountAuditReport = {
    total: accounts.length,
    active: 0,
    healthy: 0,
    quarantined: 0,
    results: [],
  };

  for (const acc of accounts) {
    if (acc.disabledCause !== null) {
      const isBanned =
        acc.disabledCause.includes("Terms of Service") ||
        acc.disabledCause.includes("403") ||
        acc.disabledCause.includes("banned");

      let removedNow = false;
      if (isBanned && autoRemove) {
        const delRes = removeStoredAccount(String(acc.id), true);
        removedNow = delRes.success;
      }

      report.results.push({
        id: acc.id,
        email: acc.email,
        status: isBanned ? "banned" : "already-disabled",
        quarantinedNow: removedNow,
        message: acc.disabledCause,
      });
      if (removedNow) {
        report.quarantined++;
      }
      continue;
    }

    report.active++;
    const health = await probeAccountInference(acc, customFetch);

    if (health.status === "healthy") {
      report.healthy++;
      report.results.push({
        id: acc.id,
        email: acc.email,
        status: "healthy",
        quarantinedNow: false,
      });
    } else if (health.status === "banned") {
      let removedNow = false;
      if (autoRemove) {
        const delRes = removeStoredAccount(String(acc.id), true);
        removedNow = delRes.success;
      } else {
        const qRes = markAccountDisabled(String(acc.id), "403: Terms of Service violation");
        removedNow = qRes.success;
      }
      report.quarantined++;
      report.results.push({
        id: acc.id,
        email: acc.email,
        status: "banned",
        quarantinedNow: removedNow,
        message: health.message,
      });
    } else {
      report.results.push({
        id: acc.id,
        email: acc.email,
        status: "error",
        quarantinedNow: false,
        message: health.message,
      });
    }
  }

  return report;
}

export async function probeAccountTier(accessToken: string): Promise<AccountTierInfo> {
  const headers = await buildControlRequestHeaders(accessToken);

  try {
    const res = await fetch(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const isBanned = res.status === 403 && (text.includes("Terms of Service") || text.includes("PERMISSION_DENIED"));
      return {
        tierId: isBanned ? "banned" : "unknown",
        tierName: isBanned ? "Banned (ToS Violation)" : `HTTP ${res.status}`,
        isPaid: false,
        upgradeText: isBanned ? "Account disabled for Terms of Service violation." : undefined,
      };
    }

    const data = (await res.json()) as {
      currentTier?: { id?: string; name?: string; description?: string };
      paidTier?: { id?: string; name?: string; upgradeSubscriptionText?: string };
    };

    const paidId = data.paidTier?.id || "";
    const currentId = data.currentTier?.id || "free-tier";

    if (paidId.includes("ultra") || currentId.includes("ultra")) {
      return {
        tierId: paidId || currentId,
        tierName: "Google AI Ultra",
        isPaid: true,
        upgradeText: data.paidTier?.upgradeSubscriptionText,
      };
    }

    if (paidId.includes("pro") || currentId.includes("pro")) {
      return {
        tierId: paidId || currentId,
        tierName: "Google AI Pro",
        isPaid: true,
        upgradeText: data.paidTier?.upgradeSubscriptionText,
      };
    }

    if (paidId.includes("plus") || currentId.includes("plus")) {
      return {
        tierId: paidId || currentId,
        tierName: "Google AI Plus",
        isPaid: true,
        upgradeText: data.paidTier?.upgradeSubscriptionText,
      };
    }

    return {
      tierId: currentId,
      tierName: "Free Tier",
      isPaid: false,
      upgradeText: data.paidTier?.upgradeSubscriptionText,
    };
  } catch (err) {
    return {
      tierId: "error",
      tierName: "Unreachable",
      isPaid: false,
    };
  }
}
export interface HydrogenEntitlementInfo {
  status: "enabled" | "disabled" | "unknown";
  note?: string;
}

/**
 * Probes whether the account can use gemini-4-hydrogen (paid Pro/Ultra entitlement)
 * via fetchAvailableModels on the daily host.
 */
export async function probeHydrogenEntitlement(
  accessToken: string,
  projectId?: string
): Promise<HydrogenEntitlementInfo> {
  const project = projectId && projectId.length > 0 ? projectId : FALLBACK_PROJECT_ID;
  const headers = await buildControlRequestHeaders(accessToken);
  try {
    const res = await fetch(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const isBanned = res.status === 403 && (text.includes("Terms of Service") || text.includes("PERMISSION_DENIED"));
      return {
        status: "disabled",
        note: isBanned ? "Account disabled for Terms of Service violation" : `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      models?: Record<string, { disabled?: boolean; tagDescription?: string }>;
    };
    const models = data.models ?? {};
    const enabledVariant = ["medium", "low", "high", "xhigh"].find(
      (suffix) => models[`gemini-4-hydrogen-${suffix}`] && models[`gemini-4-hydrogen-${suffix}`].disabled !== true
    );
    if (enabledVariant) {
      return { status: "enabled" };
    }
    const disabledEntry = models["gemini-4-hydrogen-disabled"];
    if (disabledEntry) {
      return { status: "disabled", note: disabledEntry.tagDescription ?? "Pro/Ultra subscription required" };
    }
    return { status: "unknown", note: "gemini-4-hydrogen not listed for this account" };
  } catch {
    return { status: "unknown", note: "Unreachable" };
  }
}
