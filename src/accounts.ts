/**
 * src/accounts.ts
 *
 * Discovery, tier detection, and management of saved Google Antigravity OAuth credentials in agent.db (OMP / Pi).
 */

import * as fs from "fs";
import * as path from "path";
import { Database } from "bun:sqlite";
import { ANTIGRAVITY_ENDPOINT_DAILY } from "./constants";
import { buildHubUserAgent } from "./manifest";

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
}

export interface SaveAccountInput {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  projectId?: string;
  email?: string;
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
      const db = new Database(dbPath, { readonly: true });
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

        if (row.identity_key?.startsWith("email:")) {
          email = row.identity_key.slice(6);
        }

        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          if (!email && typeof parsed.email === "string") {
            email = parsed.email;
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
          if (
            (typeof parsed.refresh === "string" && parsed.refresh.length > 0) ||
            (typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0)
          ) {
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
        });
      }
      db.close();
    } catch {}
  }

  return accounts;
}

export function saveAccountToAgentDb(creds: SaveAccountInput): boolean {
  const dbPaths = findAgentDbPaths();
  const email = creds.email || "unknown";
  const identityKey = `email:${email}`;
  const now = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({
    access: creds.access_token,
    refresh: creds.refresh_token,
    expires: creds.expires_at,
    email: creds.email,
    projectId: creds.projectId || "aicode-consumers",
    authorizedAt: Date.now(),
  });

  let savedAny = false;
  for (const dbPath of dbPaths) {
    try {
      const db = new Database(dbPath);
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
      const db = new Database(dbPath);
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
  hard = false
): { success: boolean; affected: number; message: string } {
  const target = identifier.trim().toLowerCase();
  if (!target) {
    return { success: false, affected: 0, message: "Please specify an account email or ID." };
  }

  const dbPaths = findAgentDbPaths();
  let affected = 0;

  for (const dbPath of dbPaths) {
    try {
      const db = new Database(dbPath);
      const rows = db
        .query(
          "SELECT id, identity_key FROM auth_credentials WHERE provider = 'google-antigravity'"
        )
        .all() as Array<{ id: number; identity_key: string | null }>;

      for (const row of rows) {
        const idMatch = String(row.id) === target;
        const email = row.identity_key?.toLowerCase() || "";
        const emailMatch = email.includes(target);

        if (idMatch || emailMatch) {
          if (hard) {
            db.query("DELETE FROM auth_credentials WHERE id = ?").run(row.id);
          } else {
            db.query(
              "UPDATE auth_credentials SET disabled_cause = 'deleted by user' WHERE id = ?"
            ).run(row.id);
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
    return { success: false, affected: 0, message: `No Antigravity account matched "${identifier}".` };
  }

  const actionStr = hard ? "permanently deleted" : "deactivated (soft-deleted)";
  return {
    success: true,
    affected,
    message: `Successfully ${actionStr} ${affected} account(s). Use '/agy restore' to re-activate soft-deleted accounts.`,
  };
}

export async function probeAccountTier(accessToken: string): Promise<AccountTierInfo> {
  const userAgent = await buildHubUserAgent();

  try {
    const res = await fetch(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    });

    if (!res.ok) {
      return {
        tierId: "unknown",
        tierName: `HTTP ${res.status}`,
        isPaid: false,
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
