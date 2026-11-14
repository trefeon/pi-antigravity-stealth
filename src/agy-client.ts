/**
 * src/agy-client.ts
 *
 * Runtime extraction of the official `agy` CLI's first-party OAuth client pair
 * from the locally installed binary (no credentials are stored in this
 * repository — GitHub push protection correctly rejects Google OAuth client
 * literals, and hardcoding them would also go stale when Google rotates).
 *
 * Evidence (agy v1.5.9, Go/jetski binary):
 *  - Client IDs match /\d{10,13}-[a-z0-9-]+\.apps\.googleusercontent\.com/
 *  - Secrets match /GOCSPX-[A-Za-z0-9_-]{20,}/
 *  - The binary carries two IDs and two secrets; pairing is verified live via
 *    oauth2.googleapis.com: a mismatched pair answers `invalid_client`, a
 *    well-formed pair with a bogus code answers `invalid_grant`.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface AgyOAuthPair {
  clientId: string;
  clientSecret: string;
}

export interface AgyClientCache extends AgyOAuthPair {
  source: "agy-binary" | "manual";
  binaryPath?: string;
  extractedAt?: string;
}

const CLIENT_ID_PATTERN = /\d{10,13}-[a-z0-9][a-z0-9-]*\.apps\.googleusercontent\.com/g;
const CLIENT_SECRET_RUN_PATTERN = /GOCSPX-[A-Za-z0-9_-]{24,}/g;

/**
 * Go string data is concatenated without separators, so a `GOCSPX-…` run in the
 * binary usually carries trailing bytes from the next string. Google installed
 * -app secrets are `GOCSPX-` + 28 chars (verified on both agy and the legacy
 * shared pair), so emit prefix candidates at 28 first, then the plausible
 * remaining lengths; the live pairing probe disambiguates.
 */
function expandSecretCandidates(runs: string[]): string[] {
  const lengths = [28, 35, 24, 25, 26, 27, 29, 30, 31, 32, 33, 34, 36];
  const out = new Set<string>();
  for (const run of runs) {
    for (const len of lengths) {
      if (run.length >= "GOCSPX-".length + len) {
        out.add(run.slice(0, "GOCSPX-".length + len));
      }
    }
  }
  return [...out];
}

export function defaultAgyCachePath(home?: string): string {
  const base = home ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
  return path.join(base, ".omp", "agent", "agy-oauth.json");
}

export function defaultAgyBinaryPath(platform: NodeJS.Platform = process.platform): string | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (platform === "win32") {
    return localAppData ? path.join(localAppData, "agy", "bin", "agy.exe") : null;
  }
  if (platform === "darwin") {
    return home ? path.join(home, "Library", "Application Support", "agy", "bin", "agy") : null;
  }
  return home ? path.join(home, ".local", "agy", "bin", "agy") : null;
}

/**
 * Extracts candidate client IDs and secrets from an `agy`-family binary.
 * Reads the file in chunks to avoid buffering 200+ MB at once.
 */
export function extractAgyOAuthCandidates(binaryPath: string): AgyOAuthPair[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(binaryPath);
  } catch {
    return [];
  }
  // Bail out early on obviously-wrong files.
  if (!stat.isFile() || stat.size < 1_000_000) return [];

  const ids = new Set<string>();
  const secretRuns = new Set<string>();
  const CHUNK = 8 * 1024 * 1024;
  const OVERLAP = 4096;
  const fd = fs.openSync(binaryPath, "r");
  try {
    const buf = Buffer.alloc(CHUNK + OVERLAP);
    let offset = 0;
    let tail = Buffer.alloc(0);
    while (offset < stat.size) {
      const bytes = fs.readSync(fd, buf, 0, buf.length, offset);
      if (bytes <= 0) break;
      const chunk = Buffer.concat([tail, buf.subarray(0, bytes)]).toString("latin1");
      for (const match of chunk.matchAll(CLIENT_ID_PATTERN)) ids.add(match[0]);
      for (const match of chunk.matchAll(CLIENT_SECRET_RUN_PATTERN)) secretRuns.add(match[0]);
      tail = buf.subarray(Math.max(0, bytes - OVERLAP), bytes);
      offset += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }

  const secrets = expandSecretCandidates([...secretRuns]);
  return [...ids].flatMap((clientId) =>
    secrets.map((clientSecret) => ({ clientId, clientSecret }))
  );
}

/**
 * Verifies which (id, secret) candidate is a well-formed pair by probing
 * Google's token endpoint: `invalid_client` = mismatch, anything else
 * (`invalid_grant` for a bogus code) = the credentials are accepted together.
 */
export async function pairAgyOAuthClient(
  candidates: AgyOAuthPair[],
  probeFetch: typeof fetch = fetch,
  tokenUrl = "https://oauth2.googleapis.com/token"
): Promise<AgyOAuthPair | null> {
  for (const candidate of candidates) {
    try {
      const res = await probeFetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: candidate.clientId,
          client_secret: candidate.clientSecret,
          code: "agy-pair-probe",
          grant_type: "authorization_code",
          redirect_uri: "http://localhost:1/auth/callback",
        }).toString(),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      if (!text.includes("invalid_client")) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

export function readAgyClientCache(cachePath: string): AgyClientCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    if (
      typeof raw.clientId === "string" &&
      typeof raw.clientSecret === "string" &&
      raw.clientId.length > 0 &&
      raw.clientSecret.length > 0
    ) {
      return {
        clientId: raw.clientId,
        clientSecret: raw.clientSecret,
        source: raw.source === "manual" ? "manual" : "agy-binary",
        ...(typeof raw.binaryPath === "string" ? { binaryPath: raw.binaryPath } : {}),
        ...(typeof raw.extractedAt === "string" ? { extractedAt: raw.extractedAt } : {}),
      };
    }
  } catch {}
  return null;
}

export function writeAgyClientCache(
  cachePath: string,
  pair: AgyOAuthPair,
  meta: { source: "agy-binary" | "manual"; binaryPath?: string }
): boolean {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const payload: AgyClientCache = {
      ...pair,
      ...meta,
      extractedAt: new Date().toISOString(),
    };
    fs.writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {}
  return false;
}

export interface ResolveAgyPairOptions {
  cachePath?: string;
  binaryPath?: string;
  probeFetch?: typeof fetch;
  /** Skip the live pairing probe and trust the first candidate (tests). */
  trustFirstCandidate?: boolean;
}

/**
 * Full resolver: cache → binary extraction + live pairing → null.
 * Successful extraction is cached so later runs cost one file read.
 */
export async function resolveAgyOAuthPair(options: ResolveAgyPairOptions = {}): Promise<{
  pair: AgyOAuthPair;
  source: "agy-binary" | "manual";
  fromCache: boolean;
} | null> {
  const cachePath = options.cachePath ?? defaultAgyCachePath();
  const cached = readAgyClientCache(cachePath);
  if (cached) {
    return { pair: { clientId: cached.clientId, clientSecret: cached.clientSecret }, source: cached.source, fromCache: true };
  }

  const binaryPath =
    options.binaryPath ??
    process.env.AGY_BINARY_PATH?.trim() ??
    defaultAgyBinaryPath() ??
    "";
  if (!binaryPath) return null;

  const candidates = extractAgyOAuthCandidates(binaryPath);
  if (candidates.length === 0) return null;

  const paired = options.trustFirstCandidate
    ? candidates[0]
    : await pairAgyOAuthClient(candidates, options.probeFetch);
  if (!paired) return null;

  writeAgyClientCache(cachePath, paired, { source: "agy-binary", binaryPath });
  return { pair: paired, source: "agy-binary", fromCache: false };
}

/** Stable short fingerprint for diagnostics (never logs the secret). */
export function fingerprintPair(pair: AgyOAuthPair): string {
  const hash = crypto.createHash("sha256").update(`${pair.clientId}:${pair.clientSecret}`).digest("hex");
  return `sha256:${hash.slice(0, 12)}`;
}
