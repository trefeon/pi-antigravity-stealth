/**
 * src/updater.ts
 *
 * Self-updater for pi-antigravity-stealth backed by GitHub Releases (no npm required).
 * Resolves the latest release via github.com/<owner>/<repo>/releases/latest redirect
 * (zero api.github.com quota dependency), updates script-installed and git-installed
 * hosts in place, and leaves developer git checkouts untouched.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GITHUB_REPO = "trefeon/pi-antigravity-stealth";
export const PACKAGE_NAME = "pi-antigravity-stealth";
export const INSTALL_MARKER_FILE = ".pi-antigravity-install.json";

const LATEST_RELEASE_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const UPGRADE_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 4_000;

export type InstallKind = "script" | "omp-git" | "pi-git" | "omp-npm" | "pi-npm" | "git" | "unknown";

export interface InstallInfo {
  kind: InstallKind;
  root: string;
  version: string;
}

export interface UpdateState {
  version: 1;
  checkedAt: number;
  latest: string | null;
  latestTag: string | null;
  attemptedAt: number;
  attemptedVersion: string | null;
  updatedAt: number;
  lastError: string | null;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>
) => Promise<{ code: number; output: string }>;

export type UpdateStatus =
  | "current"
  | "updated"
  | "failed"
  | "unavailable"
  | "throttled"
  | "unmanaged"
  | "locked"
  | "disabled";

export interface UpdateResult {
  status: UpdateStatus;
  current: string;
  latest?: string;
  detail?: string;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  tag: string | null;
  error: string | null;
}

export interface UpdateOptions {
  root?: string;
  statePath?: string;
  force?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  exec?: CommandRunner;
}

let inflight: Promise<UpdateCheck> | null = null;

/** Test seam: clears in-flight update request dedupe. */
export function resetUpdateMemory(): void {
  inflight = null;
}

/** Package root directory (parent of `src/`). */
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function defaultUpdateStatePath(): string {
  const override = process.env.PI_ANTIGRAVITY_UPDATE_STATE?.trim();
  if (override) return override;
  const home = process.env.USERPROFILE || process.env.HOME || tmpdir();
  const ompAgentDir = join(home, ".omp", "agent");
  const piAgentDir = join(home, ".pi", "agent");
  const dir = existsSync(ompAgentDir) || !existsSync(piAgentDir) ? ompAgentDir : piAgentDir;
  return join(dir, "pi-antigravity-stealth-update.json");
}

function normalizeVersionString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^v/i, "");
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

export function readPackageVersion(root: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return normalizeVersionString(parsed.version) ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface ParsedSemver {
  core: [number, number, number];
  pre: Array<number | string> | null;
}

function parseSemver(raw: string): ParsedSemver | null {
  const clean = raw.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const dashIdx = clean.indexOf("-");
  const corePart = dashIdx >= 0 ? clean.slice(0, dashIdx) : clean;
  const prePart = dashIdx >= 0 ? clean.slice(dashIdx + 1) : "";
  const segs = corePart.split(".");
  if (segs.length !== 3) return null;
  const nums = segs.map((s) => Number(s));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const pre =
    prePart.length > 0
      ? prePart.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : null;
  return { core: [nums[0]!, nums[1]!, nums[2]!], pre };
}

export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;

  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) {
      return a.core[i]! - b.core[i]!;
    }
  }

  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;

  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = a.pre[i];
    const bi = b.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    if (typeof ai === "number" && typeof bi === "number") return ai - bi;
    if (typeof ai === "number") return -1;
    if (typeof bi === "number") return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

function readOmpPluginsDependencySpec(normalizedRoot: string): string | null {
  const marker = "/.omp/plugins/";
  const idx = normalizedRoot.indexOf(marker);
  if (idx < 0) return null;
  const pluginsRoot = normalizedRoot.slice(0, idx + "/.omp/plugins".length);
  try {
    const pkg = JSON.parse(readFileSync(join(pluginsRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    const spec = pkg.dependencies?.[PACKAGE_NAME];
    return typeof spec === "string" ? spec : null;
  } catch {
    return null;
  }
}

export function detectInstall(root = packageRoot()): InstallInfo {
  const version = readPackageVersion(root);
  // Protect developer git checkouts first (including directory links into ~/.omp/plugins).
  if (existsSync(join(root, ".git"))) {
    return { kind: "git", root, version };
  }
  if (existsSync(join(root, INSTALL_MARKER_FILE))) {
    return { kind: "script", root, version };
  }

  const normalized = root.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.omp/plugins/")) {
    const rawNormalized = root.replace(/\\/g, "/");
    const spec = readOmpPluginsDependencySpec(rawNormalized);
    if (spec && /^(github:|git\+|https?:\/\/|ssh:\/\/|git:)/i.test(spec)) {
      return { kind: "omp-git", root, version };
    }
    return { kind: "omp-npm", root, version };
  }
  if (normalized.includes("/.pi/agent/git/")) {
    return { kind: "pi-git", root, version };
  }
  if (normalized.includes("/.pi/agent/npm/")) {
    return { kind: "pi-npm", root, version };
  }
  return { kind: "unknown", root, version };
}

function blankState(): UpdateState {
  return {
    version: 1,
    checkedAt: 0,
    latest: null,
    latestTag: null,
    attemptedAt: 0,
    attemptedVersion: null,
    updatedAt: 0,
    lastError: null,
  };
}

function mergeState(state: UpdateState | null, patch: Partial<UpdateState>): UpdateState {
  return { ...(state ?? blankState()), ...patch, version: 1 };
}

export function readUpdateState(statePath = defaultUpdateStatePath()): UpdateState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<UpdateState> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.checkedAt !== "number") {
      return null;
    }
    return mergeState(null, {
      checkedAt: parsed.checkedAt,
      latest: normalizeVersionString(parsed.latest),
      latestTag: typeof parsed.latestTag === "string" && parsed.latestTag.length > 0 ? parsed.latestTag : null,
      attemptedAt: typeof parsed.attemptedAt === "number" ? parsed.attemptedAt : 0,
      attemptedVersion:
        typeof parsed.attemptedVersion === "string" ? normalizeVersionString(parsed.attemptedVersion) : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    });
  } catch {
    return null;
  }
}

function writeUpdateState(state: UpdateState, statePath: string): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort cache write.
  }
}

export function parseReleaseTagFromLocation(locationOrUrl: string): { tag: string; version: string } | null {
  const clean = locationOrUrl.trim().split("#")[0]?.split("?")[0] ?? "";
  const marker = "/releases/tag/";
  const idx = clean.indexOf(marker);
  if (idx < 0) return null;
  const tag = clean.slice(idx + marker.length).replace(/\/+$/, "");
  if (!tag || tag.includes("/")) return null;
  const version = normalizeVersionString(tag);
  if (!version) return null;
  return { tag, version };
}

export async function fetchLatestGitHubRelease(
  fetchImpl: typeof fetch = fetch
): Promise<{ tag: string; version: string }> {
  const res = await fetchImpl(LATEST_RELEASE_URL, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "text/html",
      "User-Agent": `${PACKAGE_NAME}-updater`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`GitHub releases redirect (${res.status}) missing Location header`);
    }
    const parsed = parseReleaseTagFromLocation(location);
    if (!parsed) {
      throw new Error(`Unexpected release redirect Location: ${location}`);
    }
    return parsed;
  }

  if (res.ok && res.url) {
    const parsed = parseReleaseTagFromLocation(res.url);
    if (parsed) return parsed;
  }

  throw new Error(`GitHub releases answered HTTP ${res.status}`);
}

export function checkForUpdate(options: UpdateOptions = {}): Promise<UpdateCheck> {
  inflight ??= performCheck(options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function performCheck(options: UpdateOptions): Promise<UpdateCheck> {
  const clock = options.now ?? Date.now;
  const statePath = options.statePath ?? defaultUpdateStatePath();
  const current = detectInstall(options.root).version;
  const cached = readUpdateState(statePath);
  const timestamp = clock();

  if (
    options.force !== true &&
    cached !== null &&
    cached.checkedAt > 0 &&
    timestamp - cached.checkedAt < CHECK_TTL_MS
  ) {
    return { current, latest: cached.latest, tag: cached.latestTag, error: null };
  }

  try {
    const release = await fetchLatestGitHubRelease(options.fetchImpl ?? fetch);
    writeUpdateState(
      mergeState(cached, {
        checkedAt: timestamp,
        latest: release.version,
        latestTag: release.tag,
        lastError: null,
      }),
      statePath
    );
    return { current, latest: release.version, tag: release.tag, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeUpdateState(
      mergeState(cached, {
        checkedAt: timestamp,
        lastError: message,
      }),
      statePath
    );
    return {
      current,
      latest: cached?.latest ?? null,
      tag: cached?.latestTag ?? null,
      error: message,
    };
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string | undefined>
): Promise<{ code: number; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
  const child = spawn(command, args, {
    cwd,
    shell: process.platform === "win32" && !command.toLowerCase().endsWith(".exe"),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

  let output = "";
  const capture = (chunk: Buffer | string) => {
    if (output.length < OUTPUT_LIMIT) {
      output += chunk.toString();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {}
    resolve({ code: -1, output: `${output.trim()}\n(timed out after ${UPGRADE_TIMEOUT_MS / 1000}s)`.trim() });
  }, UPGRADE_TIMEOUT_MS);
  timer.unref?.();

  child.on("error", (err) => {
    clearTimeout(timer);
    resolve({ code: -1, output: `${output.trim()}\n${err.message}`.trim() });
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? -1, output: output.trim() });
  });

  return promise;
}

function findExtractedPackageDir(stageDir: string): string | null {
  if (existsSync(join(stageDir, "package.json")) && existsSync(join(stageDir, "src", "index.ts"))) {
    return stageDir;
  }
  const entries = readdirSync(stageDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(stageDir, entry.name);
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "src", "index.ts"))) {
      return candidate;
    }
  }
  return null;
}

const RELEASE_FILES = ["index.ts", "package.json", "README.md", "LICENSE", "tsconfig.json"];
const RELEASE_DIRS = ["src", "scripts", "docs", "skills"];

async function upgradeScriptInstall(
  install: InstallInfo,
  tag: string,
  expectedVersion: string,
  fetchImpl: typeof fetch,
  exec: CommandRunner,
  nowMs: number
): Promise<string | null> {
  const workDir = join(tmpdir(), `pi-ag-update-${process.pid}-${nowMs}`);
  const stageDir = join(workDir, "stage");
  const isWin = process.platform === "win32";
  const ext = isWin ? "zip" : "tar.gz";
  const archivePath = join(workDir, `release.${ext}`);

  const candidateUrls = [
    `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${PACKAGE_NAME}-${tag}.${ext}`,
    `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tag}.${ext}`,
  ];

  mkdirSync(stageDir, { recursive: true });

  try {
    let downloaded: ArrayBuffer | null = null;
    let lastStatus = "no archive candidates responded";

    for (const url of candidateUrls) {
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": `${PACKAGE_NAME}-updater` },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (res.ok) {
          downloaded = await res.arrayBuffer();
          break;
        }
        lastStatus = `HTTP ${res.status} from ${url}`;
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err);
      }
    }

    if (!downloaded) {
      return `Failed to download GitHub release archive (${lastStatus})`;
    }

    writeFileSync(archivePath, Buffer.from(downloaded));

    const extractOutcome = isWin
      ? await exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $env:PI_AG_ARCHIVE -DestinationPath $env:PI_AG_STAGE -Force",
          ],
          workDir,
          { PI_AG_ARCHIVE: archivePath, PI_AG_STAGE: stageDir }
        )
      : await exec("tar", ["-xzf", archivePath, "-C", stageDir], workDir);

    if (extractOutcome.code !== 0) {
      return `Archive extraction failed: ${extractOutcome.output || `exit ${extractOutcome.code}`}`;
    }

    const extractedRoot = findExtractedPackageDir(stageDir);
    if (!extractedRoot) {
      return "Downloaded archive is missing package.json or src/index.ts";
    }

    let pkg: { name?: unknown; version?: unknown };
    try {
      pkg = JSON.parse(readFileSync(join(extractedRoot, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
    } catch {
      return "Downloaded package.json is unreadable";
    }

    if (pkg.name !== PACKAGE_NAME) {
      return `Unexpected package name in release archive: ${String(pkg.name)}`;
    }
    const extractedVersion = normalizeVersionString(pkg.version);
    if (!extractedVersion || compareVersions(extractedVersion, expectedVersion) < 0) {
      return `Release archive version (${String(pkg.version)}) is older than ${expectedVersion}`;
    }

    for (const relFile of RELEASE_FILES) {
      const srcFile = join(extractedRoot, relFile);
      if (existsSync(srcFile)) {
        cpSync(srcFile, join(install.root, relFile), { force: true });
      }
    }

    for (const relDir of RELEASE_DIRS) {
      const srcDir = join(extractedRoot, relDir);
      const destDir = join(install.root, relDir);
      if (existsSync(srcDir)) {
        rmSync(destDir, { recursive: true, force: true });
        cpSync(srcDir, destDir, { recursive: true, force: true });
      }
    }

    let previousMeta: Record<string, unknown> = {};
    try {
      previousMeta = JSON.parse(readFileSync(join(install.root, INSTALL_MARKER_FILE), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {}

    writeFileSync(
      join(install.root, INSTALL_MARKER_FILE),
      `${JSON.stringify(
        {
          ...previousMeta,
          source: "github-release",
          repo: GITHUB_REPO,
          version: extractedVersion,
          tag,
          updatedAt: new Date(nowMs).toISOString(),
        },
        null,
        2
      )}\n`
    );

    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function acquireLock(statePath: string): string | null {
  const lockPath = `${statePath}.lock`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(lockPath, "wx", 0o600));
    return lockPath;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
        closeSync(openSync(lockPath, "wx", 0o600));
        return lockPath;
      }
    } catch {}
    return null;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {}
}

function recordFailure(statePath: string, latest: string, timestamp: number, detail: string): void {
  writeUpdateState(
    mergeState(readUpdateState(statePath), {
      attemptedAt: timestamp,
      attemptedVersion: latest,
      lastError: detail,
    }),
    statePath
  );
}

export async function maybeAutoUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const clock = options.now ?? Date.now;
  const statePath = options.statePath ?? defaultUpdateStatePath();
  const install = detectInstall(options.root);

  if (process.env.PI_ANTIGRAVITY_SKIP_UPDATE_CHECK) {
    return { status: "disabled", current: install.version };
  }

  const check = await checkForUpdate(options);
  if (check.latest === null) {
    return {
      status: "unavailable",
      current: check.current,
      detail: check.error ?? "GitHub releases unavailable",
    };
  }

  if (compareVersions(check.latest, check.current) <= 0) {
    return { status: "current", current: check.current, latest: check.latest };
  }

  const state = readUpdateState(statePath);
  const timestamp = clock();
  if (options.force !== true && state !== null && state.attemptedVersion === check.latest) {
    if (state.lastError === null) {
      return { status: "current", current: check.current, latest: check.latest };
    }
    if (timestamp - state.attemptedAt < RETRY_AFTER_FAILURE_MS) {
      return {
        status: "throttled",
        current: check.current,
        latest: check.latest,
        detail: state.lastError,
      };
    }
  }

  if (install.kind === "git" || install.kind === "omp-npm" || install.kind === "pi-npm" || install.kind === "unknown") {
    return {
      status: "unmanaged",
      current: check.current,
      latest: check.latest,
      detail: install.kind,
    };
  }

  const lock = acquireLock(statePath);
  if (lock === null) {
    return { status: "locked", current: check.current, latest: check.latest };
  }

  try {
    const exec = options.exec ?? runCommand;
    const fetchImpl = options.fetchImpl ?? fetch;
    const targetTag = check.tag ?? `v${check.latest}`;

    if (install.kind === "script") {
      const err = await upgradeScriptInstall(install, targetTag, check.latest, fetchImpl, exec, timestamp);
      if (err) {
        recordFailure(statePath, check.latest, timestamp, err);
        return { status: "failed", current: check.current, latest: check.latest, detail: err };
      }
    } else if (install.kind === "omp-git") {
      const outcome = await exec("omp", ["plugin", "upgrade", PACKAGE_NAME], install.root);
      if (outcome.code !== 0) {
        const detail = `omp exited ${outcome.code}: ${outcome.output}`.trim();
        recordFailure(statePath, check.latest, timestamp, detail);
        return { status: "failed", current: check.current, latest: check.latest, detail };
      }
    } else if (install.kind === "pi-git") {
      const outcome = await exec("pi", ["update", `git:github.com/${GITHUB_REPO}`], install.root);
      if (outcome.code !== 0) {
        const detail = `pi exited ${outcome.code}: ${outcome.output}`.trim();
        recordFailure(statePath, check.latest, timestamp, detail);
        return { status: "failed", current: check.current, latest: check.latest, detail };
      }
    }

    const installed = readPackageVersion(install.root);
    if (compareVersions(installed, check.latest) < 0) {
      const detail = `Upgrade finished but ${install.root} still reports v${installed}`;
      recordFailure(statePath, check.latest, timestamp, detail);
      return { status: "failed", current: check.current, latest: check.latest, detail };
    }

    writeUpdateState(
      mergeState(readUpdateState(statePath), {
        attemptedAt: timestamp,
        attemptedVersion: check.latest,
        updatedAt: timestamp,
        lastError: null,
      }),
      statePath
    );
    return { status: "updated", current: check.current, latest: installed, detail: install.root };
  } finally {
    releaseLock(lock);
  }
}

export function formatUpdateResult(result: UpdateResult): string {
  const latest = result.latest ?? "unknown";
  switch (result.status) {
    case "current":
      return `${PACKAGE_NAME} v${result.current} is up to date.`;
    case "updated":
      return `${PACKAGE_NAME} updated v${result.current} -> v${latest}. Restart OMP / Pi to load the new version.`;
    case "failed":
      return `${PACKAGE_NAME} auto-update to v${latest} failed: ${result.detail ?? "unknown error"}`;
    case "unavailable":
      return `Could not check GitHub Releases for ${PACKAGE_NAME}: ${result.detail ?? "unavailable"}`;
    case "throttled":
      return `${PACKAGE_NAME} v${latest} is available (installed v${result.current}); automatic retry paused after a failure — run '/agy update' to retry.`;
    case "unmanaged":
      if (result.detail === "git") {
        return `${PACKAGE_NAME} v${latest} is available (installed v${result.current}); source checkout detected — run 'git pull' to update.`;
      }
      if (result.detail === "omp-npm" || result.detail === "pi-npm") {
        return `${PACKAGE_NAME} v${latest} is available (installed v${result.current}); legacy npm install detected — re-run the GitHub install script (scripts/install.sh or scripts/install.ps1) to migrate.`;
      }
      return `${PACKAGE_NAME} v${latest} is available (installed v${result.current}); run the GitHub install script to enable automatic updates.`;
    case "locked":
      return `${PACKAGE_NAME} is already being updated by another process.`;
    case "disabled":
      return `${PACKAGE_NAME} update checks are disabled (PI_ANTIGRAVITY_SKIP_UPDATE_CHECK).`;
  }
}

export function pendingUpdate(
  statePath = defaultUpdateStatePath(),
  current = detectInstall().version
): string | null {
  const state = readUpdateState(statePath);
  if (state === null || state.latest === null) return null;
  if (compareVersions(state.latest, current) <= 0) return null;
  return `${PACKAGE_NAME} v${state.latest} is available (installed v${current}); run '/agy update' or restart to apply.`;
}
