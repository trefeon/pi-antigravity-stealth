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
import { AGY_CLI_MANIFEST_BASE } from "./constants.ts";

export interface AgyOAuthPair {
  clientId: string;
  clientSecret: string;
}

export interface AgyClientCache extends AgyOAuthPair {
  source: "agy-binary" | "manual";
  binaryPath?: string;
  /** Binary identity at extraction time; a change triggers automatic re-extraction. */
  binaryMtimeMs?: number;
  binarySize?: number;
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

/**
 * Candidate install locations for the official CLI binary, per platform.
 * The Linux/macOS tarballs ship a binary named `antigravity` (the Windows
 * installer uses `agy.exe`); the CLI installs itself into `~/.local/bin` on
 * Linux ("PATH verification: ~/.local/bin is correctly configured") and
 * `%LOCALAPPDATA%\agy\bin` on Windows.
 */
export function defaultAgyBinaryCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const xdgData = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : "");
  const xdgBin = home ? path.join(home, ".local", "bin") : "";

  const candidates: string[] = [];
  // Plugin-owned auto-installed binary first, then user-managed installs.
  if (home) candidates.push(pluginOwnedAgyBinaryPath(platform));
  if (platform === "win32") {
    if (localAppData) candidates.push(path.join(localAppData, "agy", "bin", "agy.exe"));
    if (xdgBin) candidates.push(path.join(xdgBin, "agy.exe"), path.join(xdgBin, "antigravity.exe"));
  } else if (platform === "darwin") {
    if (home) candidates.push(path.join(home, "Library", "Application Support", "agy", "bin", "agy"));
    if (xdgBin) candidates.push(path.join(xdgBin, "antigravity"), path.join(xdgBin, "agy"));
  } else {
    if (xdgData) candidates.push(path.join(xdgData, "agy", "bin", "antigravity"), path.join(xdgData, "agy", "bin", "agy"));
    if (xdgBin) candidates.push(path.join(xdgBin, "antigravity"), path.join(xdgBin, "agy"));
    candidates.push("/usr/local/bin/antigravity", "/usr/local/bin/agy", "/usr/bin/antigravity", "/usr/bin/agy");
  }

  // Also scan PATH (covers custom install prefixes on Armbian/Debian hosts).
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(
      path.join(dir, platform === "win32" ? "agy.exe" : "agy"),
      path.join(dir, platform === "win32" ? "antigravity.exe" : "antigravity")
    );
  }
  return [...new Set(candidates)];
}

export function defaultAgyBinaryPath(platform: NodeJS.Platform = process.platform): string | null {
  for (const candidate of defaultAgyBinaryCandidates(platform)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Plugin-owned install location for the auto-downloaded agy CLI binary:
 * `~/.omp/agent/agy/bin/<name>`. Kept separate from any user-managed install
 * (the official updater owns `%LOCALAPPDATA%\agy` / `~/.local/bin`); discovery
 * prefers the user's own binary and falls back to this one.
 */
export function pluginOwnedAgyBinaryPath(platform: NodeJS.Platform = process.platform): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const name = platform === "win32" ? "agy.exe" : "antigravity";
  return path.join(home, ".omp", "agent", "agy", "bin", name);
}

export function agyCliManifestPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "windows_amd64.json";
  if (platform === "darwin") return process.arch === "arm64" ? "darwin_arm64.json" : "darwin_amd64.json";
  return process.arch === "arm64" ? "linux_arm64.json" : "linux_amd64.json";
}

export interface AgyCliRelease {
  version: string;
  url: string;
  sha512: string;
}

export async function fetchLatestAgyCliRelease(
  platform: NodeJS.Platform = process.platform,
  customFetch: typeof fetch = fetch
): Promise<AgyCliRelease | null> {
  try {
    const res = await customFetch(`${AGY_CLI_MANIFEST_BASE}/${agyCliManifestPath(platform)}`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const version = typeof data.version === "string" ? data.version : "";
    const url = typeof data.url === "string" ? data.url : "";
    const sha512 = typeof data.sha512 === "string" ? data.sha512 : "";
    if (!version || !url || !sha512) return null;
    return { version, url, sha512 };
  } catch {
    return null;
  }
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
        ...(typeof raw.binaryMtimeMs === "number" ? { binaryMtimeMs: raw.binaryMtimeMs } : {}),
        ...(typeof raw.binarySize === "number" ? { binarySize: raw.binarySize } : {}),
        ...(typeof raw.extractedAt === "string" ? { extractedAt: raw.extractedAt } : {}),
      };
    }
  } catch {}
  return null;
}

export function writeAgyClientCache(
  cachePath: string,
  pair: AgyOAuthPair,
  meta: { source: "agy-binary" | "manual"; binaryPath?: string; binaryMtimeMs?: number; binarySize?: number }
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

/** Drops the cached pair so the next resolve re-extracts from the binary. */
export function invalidateAgyClientCache(cachePath: string = defaultAgyCachePath()): boolean {
  try {
    fs.rmSync(cachePath, { force: true });
    return true;
  } catch {}
  return false;
}

function statBinary(binaryPath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(binaryPath);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

export interface ResolveAgyPairOptions {
  cachePath?: string;
  binaryPath?: string;
  probeFetch?: typeof fetch;
  /** Skip the live pairing probe and trust the first candidate (tests). */
  trustFirstCandidate?: boolean;
}

/**
 * Full resolver that always follows the installed `agy` binary:
 *   1. cache + unchanged binary identity (path + size + mtime) → cached pair
 *   2. binary present but changed (agy self-updated, Google rotated the pair) →
 *      re-extract + live pair-verify + refresh cache
 *   3. binary absent → last cached pair (still valid until Google rotates)
 *   4. nothing → null
 */
export async function resolveAgyOAuthPair(options: ResolveAgyPairOptions = {}): Promise<{
  pair: AgyOAuthPair;
  source: "agy-binary" | "manual";
  fromCache: boolean;
} | null> {
  const cachePath = options.cachePath ?? defaultAgyCachePath();
  const binaryPath =
    options.binaryPath ??
    process.env.AGY_BINARY_PATH?.trim() ??
    defaultAgyBinaryPath() ??
    "";
  const cached = readAgyClientCache(cachePath);
  const binary = binaryPath ? statBinary(binaryPath) : null;
  const asResult = (cache: AgyClientCache) => ({
    pair: { clientId: cache.clientId, clientSecret: cache.clientSecret },
    source: cache.source,
    fromCache: true,
  });

  // Cache is fresh while the recorded binary identity still matches.
  if (
    cached &&
    (!binary ||
      (cached.binaryPath === binaryPath &&
        cached.binarySize === binary.size &&
        Math.abs((cached.binaryMtimeMs ?? 0) - binary.mtimeMs) < 2000))
  ) {
    return asResult(cached);
  }

  if (!binary) return cached ? asResult(cached) : null;

  const candidates = extractAgyOAuthCandidates(binaryPath);
  if (candidates.length === 0) {
    // Unexpected binary layout — keep serving the last known pair.
    return cached ? asResult(cached) : null;
  }

  const paired = options.trustFirstCandidate
    ? candidates[0]
    : await pairAgyOAuthClient(candidates, options.probeFetch);
  if (!paired) {
    // Every candidate rejected: keep the last cache rather than going
    // credential-less (Google may rotate mid-update; the next resolve retries).
    return cached ? asResult(cached) : null;
  }

  writeAgyClientCache(cachePath, paired, {
    source: "agy-binary",
    binaryPath,
    binaryMtimeMs: binary.mtimeMs,
    binarySize: binary.size,
  });
  return { pair: paired, source: "agy-binary", fromCache: false };
}

/** Stable short fingerprint for diagnostics (never logs the secret). */
export function fingerprintPair(pair: AgyOAuthPair): string {
  const hash = crypto.createHash("sha256").update(`${pair.clientId}:${pair.clientSecret}`).digest("hex");
  return `sha256:${hash.slice(0, 12)}`;
}

export interface AgyCliInstallResult {
  status: "installed" | "already-current" | "failed";
  version?: string;
  path?: string;
  error?: string;
}

interface AgyCliInstallRecord {
  version: string;
  sha512: string;
  path: string;
  installedAt: string;
}

function installRecordPath(): string {
  return path.join(path.dirname(pluginOwnedAgyBinaryPath()), "install.json");
}

function readInstallRecord(): AgyCliInstallRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(installRecordPath(), "utf8")) as Record<string, unknown>;
    if (typeof raw.version === "string" && typeof raw.path === "string") {
      return {
        version: raw.version,
        sha512: typeof raw.sha512 === "string" ? raw.sha512 : "",
        path: raw.path,
        installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
      };
    }
  } catch {}
  return null;
}

function writeInstallRecord(record: AgyCliInstallRecord): boolean {
  try {
    fs.mkdirSync(path.dirname(installRecordPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(installRecordPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {}
  return false;
}

/**
 * Downloads the latest official agy CLI release (manifest carries version +
 * sha512 over HTTPS from Google's own updater endpoint), verifies integrity,
 * and installs the single-file binary into the plugin-owned directory
 * `~/.omp/agent/agy/bin/`. Linux/macOS artifacts are tar.gz archives
 * (extracted with the system `tar`, present on Windows 10+ as bsdtar too);
 * Windows artifacts are bare .exe files.
 *
 * Discovery prefers any user-managed agy binary; this installer only fills
 * the gap when none exists (or `force` re-pins the latest version).
 */
export async function installAgyCli(
  options: {
    platform?: NodeJS.Platform;
    force?: boolean;
    onProgress?: (message: string) => void;
    customFetch?: typeof fetch;
    timeoutMs?: number;
  } = {}
): Promise<AgyCliInstallResult> {
  const platform = options.platform ?? process.platform;
  const progress = options.onProgress ?? (() => {});
  const destPath = pluginOwnedAgyBinaryPath(platform);
  const fetchImpl = options.customFetch ?? fetch;

  try {
    progress("Fetching latest agy CLI release manifest...");
    const release = await fetchLatestAgyCliRelease(platform, fetchImpl);
    if (!release) {
      return { status: "failed", error: "Could not fetch the agy CLI release manifest." };
    }

    // Same-version binary already in place → nothing to do.
    if (!options.force) {
      const record = readInstallRecord();
      if (record?.version === release.version && record.path === destPath && statBinary(destPath)) {
        return { status: "already-current", version: release.version, path: destPath };
      }
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    const isTar = release.url.endsWith(".tar.gz") || release.url.endsWith(".tgz");
    const suffix = isTar ? ".tar.gz" : platform === "win32" ? ".exe.part" : ".part";
    const partPath = `${destPath}${suffix}`;

    progress(`Downloading agy CLI v${release.version}...`);
    const res = await fetchImpl(release.url, { signal: AbortSignal.timeout(options.timeoutMs ?? 600_000) });
    if (!res.ok || !res.body) {
      return { status: "failed", version: release.version, error: `Download failed with HTTP ${res.status}.` };
    }

    const hasher = crypto.createHash("sha512");
    const file = fs.openSync(partPath, "w");
    let received = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hasher.update(chunk);
        fs.writeSync(file, chunk);
        received += chunk.length;
        if (received % (50 * 1024 * 1024) < chunk.length) {
          progress(`Downloading agy CLI v${release.version}... ${(received / 1024 / 1024).toFixed(0)} MB`);
        }
      }
    } finally {
      fs.closeSync(file);
    }

    const digest = hasher.digest("hex");
    if (digest !== release.sha512) {
      try { fs.rmSync(partPath, { force: true }); } catch {}
      return {
        status: "failed",
        version: release.version,
        error: `SHA-512 mismatch for the downloaded agy CLI artifact (expected ${release.sha512.slice(0, 16)}…, got ${digest.slice(0, 16)}…).`,
      };
    }

    if (!isTar) {
      // Bare executable (Windows artifact).
      try { fs.rmSync(destPath, { force: true }); } catch {}
      fs.renameSync(partPath, destPath);
    } else {
      // Single-binary tarball → extract with the system tar (bsdtar ships
      // with Windows 10+, macOS and every Linux distro).
      const extractDir = `${destPath}.extract`;
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(extractDir, { recursive: true });
      const { spawnSync } = await import("child_process");
      const tar = spawnSync("tar", ["-xzf", partPath, "-C", extractDir], { timeout: 120_000, windowsHide: true });
      try { fs.rmSync(partPath, { force: true }); } catch {}
      if (tar.status !== 0) {
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
        return { status: "failed", version: release.version, error: `tar extraction failed: ${tar.stderr?.toString().slice(0, 200) || "unknown error"}` };
      }
      // Locate the extracted single binary.
      let inner: string | null = null;
      const stack = [extractDir];
      while (stack.length > 0 && !inner) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && statBinary(full)) inner = full;
        }
      }
      if (!inner) {
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
        return { status: "failed", version: release.version, error: "No binary found inside the agy CLI archive." };
      }
      if (platform !== "win32") fs.chmodSync(inner, 0o755);
      try { fs.rmSync(destPath, { force: true }); } catch {}
      fs.renameSync(inner, destPath);
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    }

    const finalStat = statBinary(destPath);
    if (!finalStat || finalStat.size < 1_000_000) {
      return { status: "failed", version: release.version, error: "Installed binary failed the sanity check." };
    }

    writeInstallRecord({
      version: release.version,
      sha512: release.sha512,
      path: destPath,
      installedAt: new Date().toISOString(),
    });

    progress(`agy CLI v${release.version} installed.`);
    return { status: "installed", version: release.version, path: destPath };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
