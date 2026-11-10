/**
 * src/accounts.ts
 *
 * Discovery and recovery of saved Google Antigravity OAuth credentials from agent.db (OMP / Pi).
 */

import * as fs from "fs";
import * as path from "path";
import { Database } from "bun:sqlite";

export interface StoredAntigravityAccount {
  id: number;
  email?: string;
  projectId?: string;
  expiresAt?: number;
  isExpired: boolean;
  hasRefreshToken: boolean;
  disabledCause: string | null;
  dbPath: string;
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
          if (typeof parsed.expires_at === "number") {
            expiresAt = parsed.expires_at;
          }
          if (typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0) {
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
        });
      }
      db.close();
    } catch {}
  }

  return accounts;
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
