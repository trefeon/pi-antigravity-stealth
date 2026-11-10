/**
 * src/usage.ts
 *
 * UsageProvider override for google-antigravity that delegates to OMP's built-in
 * usage fetcher and separates Gemini 4 Argon quota buckets (`gemini-argon-*`) out
 * of the `google` counter into an `argon` counter.
 *
 * Without this separation, an exhausted Gemini 4 Argon weekly bucket (0%) gets sorted
 * to index 0 of `google-antigravity:google:*`, poisoning Gemini 3.8 Flash / 3.1 Pro
 * and blocking healthy Google AI Pro accounts with 60–100% Gemini quota left.
 */

import { ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_SANDBOX } from "./constants";
import { buildHubUserAgent } from "./manifest";
import { getBuiltinAntigravityUsageProvider } from "./omp-builtin";

export interface UsageLimitLike {
  id: string;
  label?: string;
  scope?: Record<string, unknown>;
  window?: {
    id?: string;
    label?: string;
    durationMs?: number;
    resetsAt?: number;
  };
  amount: {
    unit?: string;
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
  };
  status?: string;
}

export interface UsageReportLike {
  provider: string;
  fetchedAt: number;
  limits: UsageLimitLike[];
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

interface SummaryBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  remainingFraction?: number;
  remainingAmount?: number | string;
  disabled?: boolean;
}

interface SummaryGroup {
  displayName?: string;
  buckets?: SummaryBucket[];
}

interface SummaryResponse {
  groups?: SummaryGroup[];
  buckets?: SummaryBucket[];
}

function collectArgonBucketIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!raw || typeof raw !== "object") return ids;
  const r = raw as SummaryResponse;
  const groups = Array.isArray(r.groups) ? r.groups : [];
  for (const g of groups) {
    const groupArgon = (g.displayName ?? "").toLowerCase().includes("argon");
    for (const b of g.buckets ?? []) {
      const bid = b.bucketId?.toLowerCase() ?? "";
      if (bid && (groupArgon || bid.includes("argon"))) {
        ids.add(bid);
      }
    }
  }
  for (const b of r.buckets ?? []) {
    const bid = b.bucketId?.toLowerCase() ?? "";
    if (bid && bid.includes("argon")) {
      ids.add(bid);
    }
  }
  return ids;
}

function isArgonLimit(limit: UsageLimitLike, argonBucketIds: Set<string>): boolean {
  const idLower = limit.id.toLowerCase();
  const labelLower = (limit.label ?? "").toLowerCase();
  if (labelLower.includes("argon")) return true;
  if (idLower.includes(":gemini-argon-")) return true;
  const suffix = idLower.split(":").slice(3).join(":");
  if (suffix && argonBucketIds.has(suffix)) return true;
  return false;
}

/**
 * Rewrites Argon quota limits from `<provider>:google:...` to `<provider>:argon:...`
 * so Argon weekly exhaustion never poisons shared Gemini (`google`) quota ranking or healing.
 */
export function sanitizeAntigravityUsageReport<T extends UsageReportLike>(report: T): T {
  if (!report || !Array.isArray(report.limits) || report.limits.length === 0) {
    return report;
  }

  const argonBucketIds = collectArgonBucketIds(report.raw);
  let changed = false;

  const limits = report.limits.map((limit) => {
    if (!isArgonLimit(limit, argonBucketIds)) {
      return limit;
    }
    const parts = limit.id.split(":");
    if (parts.length >= 2 && parts[1] !== "argon") {
      parts[1] = "argon";
      changed = true;
      return {
        ...limit,
        id: parts.join(":"),
      };
    }
    return limit;
  });

  if (!changed) {
    return report;
  }

  limits.sort((a, b) => {
    const aFrac = a.amount?.remainingFraction ?? 1;
    const bFrac = b.amount?.remainingFraction ?? 1;
    return aFrac - bFrac;
  });

  return {
    ...report,
    limits,
  };
}

function classifyWindowFallback(windowStr?: string, displayName?: string) {
  const w = (windowStr ?? "").toLowerCase();
  const d = (displayName ?? "").toLowerCase();
  if (w === "weekly" || d.includes("weekly")) {
    return { id: "weekly", label: "Weekly", durationMs: 7 * 24 * 60 * 60 * 1000 };
  }
  if (w === "5h" || w === "5hour" || d.includes("five hour") || d.includes("5-hour")) {
    return { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 };
  }
  if (w === "daily" || d.includes("daily")) {
    return { id: "daily", label: "Daily", durationMs: 24 * 60 * 60 * 1000 };
  }
  return undefined;
}

function parseIsoMs(raw?: string): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function clampFrac(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(1, v));
}

function buildFallbackSummaryReport(
  data: SummaryResponse,
  params: Record<string, unknown>,
  endpoint: string,
  nowMs: number
): UsageReportLike | null {
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const topBuckets = Array.isArray(data.buckets) ? data.buckets : [];
  const hasGrouped = groups.some((g) => Array.isArray(g.buckets) && g.buckets.length > 0);
  if (!hasGrouped && topBuckets.length === 0) return null;

  const credential = (params.credential ?? {}) as Record<string, unknown>;
  const provider = typeof params.provider === "string" ? params.provider : "google-antigravity";
  const limits: UsageLimitLike[] = [];

  const addBucket = (b: SummaryBucket, g?: SummaryGroup) => {
    if (b.disabled === true) return;
    const desc = classifyWindowFallback(b.window, b.displayName);
    const resetsAt = parseIsoMs(b.resetTime);
    const windowId = desc?.id ?? b.window ?? b.bucketId ?? "default";
    const window =
      desc || resetsAt !== undefined
        ? {
            id: windowId,
            label: desc?.label ?? b.window ?? "Usage",
            ...(desc?.durationMs ? { durationMs: desc.durationMs } : {}),
            ...(resetsAt !== undefined ? { resetsAt } : {}),
          }
        : undefined;

    const rem = clampFrac(b.remainingFraction);
    const amount =
      rem !== undefined
        ? {
            unit: "percent",
            used: Math.round((1 - rem) * 1000) / 10,
            limit: 100,
            remaining: Math.round(rem * 1000) / 10,
            usedFraction: 1 - rem,
            remainingFraction: rem,
          }
        : { unit: "unknown" };

    const status =
      rem === undefined ? "unknown" : rem <= 0 ? "exhausted" : rem <= 0.2 ? "warning" : "ok";

    const bid = (b.bucketId ?? "").toLowerCase();
    const gname = (g?.displayName ?? "").toLowerCase();

    let counterKeys: string[];
    if (bid.startsWith("gemini-argon-") || gname.includes("argon")) {
      counterKeys = ["argon"];
    } else if (bid.startsWith("gemini-") || gname.includes("gemini")) {
      counterKeys = ["google"];
    } else if (
      bid.startsWith("3p-") ||
      gname.includes("claude") ||
      gname.includes("gpt") ||
      gname.includes("third party")
    ) {
      counterKeys = ["anthropic", "openai"];
    } else {
      counterKeys = ["default"];
    }

    const sharedGroup =
      counterKeys.length > 1
        ? `${b.bucketId ?? g?.displayName ?? "third-party"}:${windowId}`
        : undefined;

    for (const ck of counterKeys) {
      const label =
        sharedGroup !== undefined
          ? "Claude & GPT (shared)"
          : ck === "argon"
          ? "Gemini (Argon)"
          : ck === "google"
          ? "Gemini"
          : g?.displayName ?? b.displayName ?? "Usage";

      limits.push({
        id: `${provider}:${ck}:default:${b.bucketId ?? windowId}`,
        label,
        scope: {
          provider,
          accountId: credential.accountId,
          projectId: credential.projectId,
          windowId,
          ...(sharedGroup !== undefined ? { shared: true, sharedGroup } : {}),
        },
        window,
        amount,
        status,
      });
    }
  };

  if (hasGrouped) {
    for (const g of groups) {
      for (const b of g.buckets ?? []) addBucket(b, g);
    }
  } else {
    for (const b of topBuckets) addBucket(b);
  }

  limits.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));

  const metadata: Record<string, unknown> = {
    endpoint,
    projectId: credential.projectId,
  };
  if (typeof credential.email === "string") metadata.email = credential.email;
  if (typeof credential.accountId === "string") metadata.accountId = credential.accountId;

  return {
    provider,
    fetchedAt: nowMs,
    limits,
    metadata,
    raw: data,
  };
}

async function fetchSummaryFallback(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<UsageReportLike | null> {
  const credential = (params.credential ?? {}) as Record<string, unknown>;
  const accessToken = typeof credential.accessToken === "string" ? credential.accessToken : "";
  const projectId = typeof credential.projectId === "string" ? credential.projectId : "";
  const expiresAt = typeof credential.expiresAt === "number" ? credential.expiresAt : undefined;
  if (!accessToken || !projectId) return null;
  if (expiresAt !== undefined && expiresAt <= Date.now()) return null;

  const baseUrl = typeof params.baseUrl === "string" ? params.baseUrl.replace(/\/+$/, "") : "";
  const endpoints = baseUrl ? [baseUrl] : [ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_SANDBOX];
  const fetchImpl = (typeof ctx.fetch === "function" ? ctx.fetch : fetch) as typeof fetch;
  const ua = await buildHubUserAgent();

  for (const endpoint of endpoints) {
    try {
      const res = await fetchImpl(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": ua,
          "Accept-Encoding": "gzip",
        },
        body: JSON.stringify({ project: projectId }),
        signal: params.signal as AbortSignal | undefined,
      });
      if (res.ok) {
        const json = (await res.json()) as SummaryResponse;
        const report = buildFallbackSummaryReport(json, params, endpoint, Date.now());
        if (report) return report;
      }
      if (res.status !== 408 && res.status !== 429 && res.status < 500) {
        break;
      }
    } catch (err) {
      if (endpoint === endpoints[endpoints.length - 1]) {
        throw err;
      }
    }
  }
  return null;
}

/**
 * Runtime UsageProvider registered on `google-antigravity`.
 * Intentionally omits `supports` and `parseRateLimitHeaders` so subagent worker
 * serialization guards do not reject it.
 */
export interface AntigravityUsageProvider {
  id: string;
  cacheVersion: number;
  fetchUsage(
    params: Record<string, unknown>,
    ctx: Record<string, unknown>
  ): Promise<UsageReportLike | null>;
}

export function createAntigravityUsageProvider(): AntigravityUsageProvider {
  return {
    id: "google-antigravity",
    cacheVersion: 3,
    async fetchUsage(
      params: Record<string, unknown>,
      ctx: Record<string, unknown>
    ): Promise<UsageReportLike | null> {
      const builtin = await getBuiltinAntigravityUsageProvider();
      if (builtin) {
        const report = (await builtin.fetchUsage(params, ctx)) as UsageReportLike | null;
        return report ? sanitizeAntigravityUsageReport(report) : null;
      }
      const fallback = await fetchSummaryFallback(params, ctx);
      return fallback ? sanitizeAntigravityUsageReport(fallback) : null;
    },
  };
}
