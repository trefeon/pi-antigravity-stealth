#!/usr/bin/env bun
/**
 * scripts/check-upstream-drift.ts
 *
 * Automated upstream drift monitor & baseline synchronizer for Google Antigravity & Oh My Pi.
 *
 * Probes:
 * 1. Google Antigravity Hub live manifest (version & CL).
 * 2. Google Antigravity CLI live manifest (binary releases).
 * 3. Upstream OMP auth rules (google-antigravity.kdl) & behavior quota tiers.
 * 4. Latest published @oh-my-pi/pi-coding-agent package on npm.
 *
 * Flags:
 *   --apply         Update local constants, standalone script, docs, and package.json OMP pins.
 *   --bump          Increment patch version in package.json when --apply changes code/package pins.
 *   --verify-patch  Verify src/omp-patch.ts regexes match installed node_modules OMP cli.js.
 *   --write-report  Write drift-report.md even outside GitHub Actions.
 *   --json          Print JSON report instead of human-readable summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CLI_BASELINE_VERSION, FALLBACK_CL, FALLBACK_VERSION, MANIFEST_URL } from "../src/constants.ts";
import { checkCliCompatibility, findRulesBundleFile } from "../src/omp-patch.ts";
import { compareVersions } from "../src/updater.ts";

export interface DriftReport {
  timestamp: string;
  hasDrift: boolean;
  requiresManualReview: boolean;
  hub: {
    baselineVersion: string;
    baselineCL: string;
    liveVersion: string;
    liveCL: string;
    drift: boolean;
  };
  cli: {
    baselineVersion: string;
    liveVersion: string;
    url: string;
    drift: boolean;
  };
  ompUpstream: {
    authPolicy: "paused" | "login-warning" | "open" | "unreachable";
    disabledMessage: string | null;
    loginWarning: string | null;
    nativeArgonTier: boolean;
    ruleAccessible: boolean;
    devVersion: string;
    liveVersion: string | null;
    versionDrift: boolean;
  };
  patchCompat: {
    checked: boolean;
    compatible: boolean;
    summary: string;
    resolveOAuth: string;
    meter: string;
  };
  details: string[];
}

export interface SyncInputs {
  hubVersion: string;
  hubCL: string;
  cliVersion: string;
  ompVersion: string | null;
  bumpPatch?: boolean;
}

export interface SyncOutcome {
  changedFiles: string[];
  needsRelease: boolean;
  newVersion: string | null;
}

const CLI_MANIFEST_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json";
const UPSTREAM_KDL_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/compat/rules/auth/google-antigravity.kdl";
const UPSTREAM_BEHAVIOR_KDL_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/compat/rules/runtime/behavior.kdl";
const UPSTREAM_COLLAPSE_KDL_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/compat/rules/taxonomy/_collapse.kdl";
const NPM_OMP_LATEST_URL = "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest";

function readProp(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return Reflect.get(obj, key);
}

function readDevOmpVersion(rootDir: string): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    const devDeps = readProp(pkg, "devDependencies");
    const raw = readProp(devDeps, "@oh-my-pi/pi-coding-agent");
    if (typeof raw === "string") {
      return raw.replace(/^[~^=v]+/, "");
    }
  } catch {}
  return "0.0.0";
}

function bumpPatchSemver(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return version;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `${major}.${minor}.${patch}${match[4] ?? ""}`;
}

export function verifyInstalledOmpPatchCompat(rootDir = process.cwd()): DriftReport["patchCompat"] {
  const distDir = path.join(rootDir, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist");
  const cliPath = path.join(distDir, "cli.js");
  if (!fs.existsSync(cliPath)) {
    return {
      checked: false,
      compatible: true,
      summary: "missing-cli-file",
      resolveOAuth: "missing-cli-file",
      meter: "missing-cli-file",
    };
  }
  const cliSrc = fs.readFileSync(cliPath, "utf8");
  const compat = checkCliCompatibility(cliSrc);
  const zstOk = Boolean(findRulesBundleFile(distDir));
  return {
    checked: true,
    compatible: compat.compatible && zstOk,
    summary: compat.summary,
    resolveOAuth: compat.resolveOAuth,
    meter: compat.meter,
  };
}

export function applyUpstreamSync(rootDir: string, inputs: SyncInputs): SyncOutcome {
  const changedFiles: string[] = [];
  let needsRelease = false;
  let newVersion: string | null = null;

  const writeIfChanged = (relPath: string, nextContent: string, codeChange: boolean) => {
    const absPath = path.join(rootDir, relPath);
    if (!fs.existsSync(absPath)) return;
    const prev = fs.readFileSync(absPath, "utf8");
    if (prev !== nextContent) {
      fs.writeFileSync(absPath, nextContent, "utf8");
      changedFiles.push(relPath);
      if (codeChange) needsRelease = true;
    }
  };

  // 1. src/constants.ts
  const constantsPath = path.join(rootDir, "src", "constants.ts");
  if (fs.existsSync(constantsPath)) {
    let content = fs.readFileSync(constantsPath, "utf8");
    content = content.replace(
      /export const FALLBACK_VERSION = "[^"]+";/,
      `export const FALLBACK_VERSION = "${inputs.hubVersion}";`
    );
    content = content.replace(
      /export const FALLBACK_CL = "[^"]+";/,
      `export const FALLBACK_CL = "${inputs.hubCL}";`
    );
    if (inputs.cliVersion && inputs.cliVersion !== "unknown") {
      content = content.replace(
        /export const CLI_BASELINE_VERSION = "[^"]+";/,
        `export const CLI_BASELINE_VERSION = "${inputs.cliVersion}";`
      );
    }
    writeIfChanged("src/constants.ts", content, true);
  }

  // 2. scripts/antigravity-unpause-extension.ts (standalone copyable fallback values)
  const unpausePath = path.join(rootDir, "scripts", "antigravity-unpause-extension.ts");
  if (fs.existsSync(unpausePath)) {
    let content = fs.readFileSync(unpausePath, "utf8");
    content = content.replace(
      /process\.env\.PI_AI_ANTIGRAVITY_VERSION \?\?= "[^"]+";/,
      `process.env.PI_AI_ANTIGRAVITY_VERSION ??= "${inputs.hubVersion}";`
    );
    content = content.replace(
      /process\.env\.PI_AI_ANTIGRAVITY_CL \?\?= "[^"]+";/,
      `process.env.PI_AI_ANTIGRAVITY_CL ??= "${inputs.hubCL}";`
    );
    writeIfChanged("scripts/antigravity-unpause-extension.ts", content, true);
  }

  // 3. README.md
  const readmePath = path.join(rootDir, "README.md");
  if (fs.existsSync(readmePath)) {
    let content = fs.readFileSync(readmePath, "utf8");
    content = content.replace(
      /\(`[0-9]+\.[0-9]+\.[0-9]+`, CL `[0-9]+`\)/g,
      `(\`${inputs.hubVersion}\`, CL \`${inputs.hubCL}\`)`
    );
    content = content.replace(
      /User-Agent: antigravity\/hub\/[0-9]+\.[0-9]+\.[0-9]+ \(aidev_client; os_type=windows; arch=amd64; cl=[0-9]+\)/g,
      `User-Agent: antigravity/hub/${inputs.hubVersion} (aidev_client; os_type=windows; arch=amd64; cl=${inputs.hubCL})`
    );
    writeIfChanged("README.md", content, false);
  }

  // 4. docs/ARCHITECTURE.md
  const archPath = path.join(rootDir, "docs", "ARCHITECTURE.md");
  if (fs.existsSync(archPath)) {
    let content = fs.readFileSync(archPath, "utf8");
    content = content.replace(
      /`antigravity\/hub\/[0-9]+\.[0-9]+\.[0-9]+` with `cl=[0-9]+`/g,
      `\`antigravity/hub/${inputs.hubVersion}\` with \`cl=${inputs.hubCL}\``
    );
    writeIfChanged("docs/ARCHITECTURE.md", content, false);
  }

  // 5. docs/LEGIT_ANTIGRAVITY_SIGNATURE.md
  const sigPath = path.join(rootDir, "docs", "LEGIT_ANTIGRAVITY_SIGNATURE.md");
  if (fs.existsSync(sigPath)) {
    let content = fs.readFileSync(sigPath, "utf8");
    if (inputs.cliVersion && inputs.cliVersion !== "unknown") {
      content = content.replace(
        /(\*\*Official Google Antigravity CLI \(`agy`\)\*\* v)[0-9]+\.[0-9]+\.[0-9]+/g,
        `$1${inputs.cliVersion}`
      );
    }
    content = content.replace(
      /\| `PI_AI_ANTIGRAVITY_VERSION` \| `"[^"]+"` \| `"[^"]+"` or manifest-resolved \| Hub version \|/,
      `| \`PI_AI_ANTIGRAVITY_VERSION\` | \`"2.26.0"\` | \`"${inputs.hubVersion}"\` or manifest-resolved | Hub version |`
    );
    content = content.replace(
      /\| `PI_AI_ANTIGRAVITY_CL` \| `"[^"]+"` \| `"[^"]+"` \| Internal Google Changelist \|/,
      `| \`PI_AI_ANTIGRAVITY_CL\` | \`"1005016104"\` | \`"${inputs.hubCL}"\` | Internal Google Changelist |`
    );
    const rowPattern = `| \`${inputs.hubVersion}\` | \`${inputs.hubCL}\` |`;
    if (!content.includes(rowPattern)) {
      content = content.replace(/✅ Latest Production/g, "✅ Active Baseline");
      content = content.replace(
        /(\| Hub Version \| Changelist \(`cl`\) \| Minimum Required \|\r?\n\|---\|---\|---\|(?:\r?\n\|[^\n]+)*)/,
        `$1\n| \`${inputs.hubVersion}\` | \`${inputs.hubCL}\` | ✅ Latest Production |`
      );
    }
    writeIfChanged("docs/LEGIT_ANTIGRAVITY_SIGNATURE.md", content, false);
  }

  // 6. package.json devDependencies (+ optional version bump)
  const pkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const devDeps = readProp(parsed, "devDependencies");
      let pkgChanged = false;
      if (inputs.ompVersion && devDeps && typeof devDeps === "object") {
        for (const dep of ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-coding-agent"]) {
          const cur = readProp(devDeps, dep);
          const curClean = typeof cur === "string" ? cur.replace(/^[~^=v]+/, "") : "0.0.0";
          if (compareVersions(inputs.ompVersion, curClean) > 0) {
            Reflect.set(devDeps, dep, `^${inputs.ompVersion}`);
            pkgChanged = true;
            needsRelease = true;
          }
        }
      }
      if (inputs.bumpPatch && needsRelease) {
        const curVer = readProp(parsed, "version");
        if (typeof curVer === "string") {
          const bumped = bumpPatchSemver(curVer);
          Reflect.set(parsed, "version", bumped);
          newVersion = bumped;
          pkgChanged = true;
        }
      }
      if (pkgChanged) {
        writeIfChanged("package.json", `${JSON.stringify(parsed, null, 2)}\n`, true);
      }
    }
  }

  return { changedFiles, needsRelease, newVersion };
}

async function runCheck(rootDir = process.cwd()): Promise<DriftReport> {
  const details: string[] = [];
  let hasDrift = false;
  let requiresManualReview = false;

  // 1. Probe Hub Manifest
  let liveHubVersion = FALLBACK_VERSION;
  let liveHubCL = FALLBACK_CL;
  try {
    const res = await fetch(MANIFEST_URL, {
      headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const text = await res.text();
      const vMatch = text.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m);
      if (vMatch?.[1]) liveHubVersion = vMatch[1];
      const clMatch = text.match(/[0-9]+\.[0-9]+\.[0-9]+-([0-9]+)/);
      if (clMatch?.[1]) liveHubCL = clMatch[1];
    }
  } catch (err) {
    details.push(`Failed to reach Google Hub manifest: ${err}`);
  }

  const hubDrift = liveHubVersion !== FALLBACK_VERSION || liveHubCL !== FALLBACK_CL;
  if (hubDrift) {
    hasDrift = true;
    details.push(
      `Google Hub updated: baseline is v${FALLBACK_VERSION} (cl=${FALLBACK_CL}), live is v${liveHubVersion} (cl=${liveHubCL}).`
    );
  }

  // 2. Probe CLI Manifest
  let liveCliVersion = "unknown";
  let liveCliUrl = "";
  try {
    const res = await fetch(CLI_MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data: unknown = await res.json();
      const ver = readProp(data, "version");
      const url = readProp(data, "url");
      if (typeof ver === "string" && ver.length > 0) liveCliVersion = ver;
      if (typeof url === "string") liveCliUrl = url;
    }
  } catch (err) {
    details.push(`Failed to reach Google CLI manifest: ${err}`);
  }

  const cliDrift = liveCliVersion !== "unknown" && liveCliVersion !== CLI_BASELINE_VERSION;
  if (cliDrift) {
    hasDrift = true;
    details.push(`Google CLI updated: baseline is v${CLI_BASELINE_VERSION}, live is v${liveCliVersion}.`);
  }

  // 3. Probe Upstream OMP KDL rules
  let authPolicy: DriftReport["ompUpstream"]["authPolicy"] = "unreachable";
  let disabledMessage: string | null = null;
  let loginWarning: string | null = null;
  let ruleAccessible = false;
  let nativeArgonTier = false;

  try {
    const [authRes, behaviorRes, collapseRes] = await Promise.all([
      fetch(UPSTREAM_KDL_URL, { signal: AbortSignal.timeout(8000) }),
      fetch(UPSTREAM_BEHAVIOR_KDL_URL, { signal: AbortSignal.timeout(8000) }),
      fetch(UPSTREAM_COLLAPSE_KDL_URL, { signal: AbortSignal.timeout(8000) }),
    ]);
    if (authRes.ok) {
      ruleAccessible = true;
      const kdl = await authRes.text();
      const disabledMatch = kdl.match(/disabled\s+"([^"]+)"/);
      const warningMatch = kdl.match(/login-warning\s+"([^"]+)"/);
      if (disabledMatch?.[1]) {
        authPolicy = "paused";
        disabledMessage = disabledMatch[1];
        requiresManualReview = true;
        hasDrift = true;
        details.push(`Upstream OMP re-added disabled flag in google-antigravity.kdl: "${disabledMessage}".`);
      } else if (warningMatch?.[1]) {
        authPolicy = "login-warning";
        loginWarning = warningMatch[1];
      } else {
        authPolicy = "open";
      }
    }
    if (behaviorRes.ok) {
      const bkdl = await behaviorRes.text();
      const qtMatch = bkdl.match(/quota-tiers\s+provider="google-antigravity"\s*\{[\s\S]*?\}/);
      if (qtMatch && (qtMatch[0].includes('"argon"') || qtMatch[0].includes('"google-argon"'))) {
        nativeArgonTier = true;
      }
    }
    if (collapseRes.ok) {
      const ckdl = await collapseRes.text();
      if (!ckdl.includes('"gemini-4-hydrogen"')) {
        hasDrift = true;
        requiresManualReview = true;
        details.push("Upstream OMP does not yet include native 'gemini-4-hydrogen' in _collapse.kdl (patch required).");
      }
    }
  } catch (err) {
    details.push(`Failed to fetch upstream OMP KDL rules: ${err}`);
  }

  // 4. Probe latest @oh-my-pi/pi-coding-agent npm version
  const devOmpVersion = readDevOmpVersion(rootDir);
  let liveOmpVersion: string | null = null;
  try {
    const res = await fetch(NPM_OMP_LATEST_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const pkg: unknown = await res.json();
      const v = readProp(pkg, "version");
      if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) {
        liveOmpVersion = v;
      }
    }
  } catch (err) {
    details.push(`Failed to query npm for @oh-my-pi/pi-coding-agent: ${err}`);
  }

  const versionDrift = liveOmpVersion !== null && compareVersions(liveOmpVersion, devOmpVersion) > 0;
  if (versionDrift && liveOmpVersion) {
    hasDrift = true;
    details.push(`Upstream OMP package updated: pinned ^${devOmpVersion}, latest npm is v${liveOmpVersion}.`);
  }

  const patchCompat = verifyInstalledOmpPatchCompat(rootDir);
  if (patchCompat.checked && !patchCompat.compatible) {
    hasDrift = true;
    requiresManualReview = true;
    details.push(
      `OMP cli.js patch regex mismatch: summary=${patchCompat.summary}, resolveOAuth=${patchCompat.resolveOAuth}, meter=${patchCompat.meter}.`
    );
  }

  return {
    timestamp: new Date().toISOString(),
    hasDrift,
    requiresManualReview,
    hub: {
      baselineVersion: FALLBACK_VERSION,
      baselineCL: FALLBACK_CL,
      liveVersion: liveHubVersion,
      liveCL: liveHubCL,
      drift: hubDrift,
    },
    cli: {
      baselineVersion: CLI_BASELINE_VERSION,
      liveVersion: liveCliVersion,
      url: liveCliUrl,
      drift: cliDrift,
    },
    ompUpstream: {
      authPolicy,
      disabledMessage,
      loginWarning,
      nativeArgonTier,
      ruleAccessible,
      devVersion: devOmpVersion,
      liveVersion: liveOmpVersion,
      versionDrift,
    },
    patchCompat,
    details,
  };
}

function buildReportMarkdown(report: DriftReport, sync: SyncOutcome | null): string {
  const lines = [
    `### ${report.requiresManualReview ? "🚨 Upstream Drift Requires Review" : "🔄 Upstream Antigravity Drift Detected"}`,
    ``,
    ...report.details.map((d) => `- ${d}`),
    ``,
    `- **Live Google Hub:** \`v${report.hub.liveVersion}\` (CL \`${report.hub.liveCL}\`)`,
    `- **Live Google CLI:** \`v${report.cli.liveVersion}\``,
    `- **Upstream OMP Auth Policy:** \`${report.ompUpstream.authPolicy}\` (native Argon tier: ${report.ompUpstream.nativeArgonTier ? "yes" : "no"})`,
    `- **OMP Package:** pinned \`^${report.ompUpstream.devVersion}\`, latest npm \`v${report.ompUpstream.liveVersion ?? "unknown"}\``,
    `- **OMP Patch Regex Compat:** ${report.patchCompat.checked ? (report.patchCompat.compatible ? "compatible" : `INCOMPATIBLE (summary=${report.patchCompat.summary}, resolveOAuth=${report.patchCompat.resolveOAuth}, meter=${report.patchCompat.meter})`) : "not checked"}`,
  ];
  if (sync && sync.changedFiles.length > 0) {
    lines.push(`- **Synced Files:** ${sync.changedFiles.map((f) => `\`${f}\``).join(", ")}`);
    if (sync.newVersion) {
      lines.push(`- **Bumped Package Version:** \`v${sync.newVersion}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function appendGithubEnv(key: string, value: string): void {
  const envFile = process.env.GITHUB_ENV;
  if (envFile) {
    fs.appendFileSync(envFile, `${key}=${value}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const doApply = args.includes("--apply");
  const doBump = args.includes("--bump");
  const verifyPatchOnly = args.includes("--verify-patch");
  const writeReport = args.includes("--write-report") || process.env.GITHUB_ACTIONS === "true";
  const asJson = args.includes("--json");

  if (verifyPatchOnly) {
    const compat = verifyInstalledOmpPatchCompat(process.cwd());
    if (!compat.checked) {
      console.error("❌ node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js not found.");
      process.exit(1);
    }
    console.log(
      `OMP cli.js patch compatibility: summary=${compat.summary}, resolveOAuth=${compat.resolveOAuth}, meter=${compat.meter}`
    );
    if (!compat.compatible) {
      console.error("❌ OMP cli.js no longer matches one or more patch regexes!");
      process.exit(1);
    }
    console.log("✅ All OMP patch regexes verified compatible.");
    return;
  }

  if (!asJson) {
    console.log("🔍 Checking upstream drift for Google Antigravity & OMP...\n");
  }

  const report = await runCheck(process.cwd());
  let sync: SyncOutcome | null = null;

  if (doApply && report.hasDrift) {
    sync = applyUpstreamSync(process.cwd(), {
      hubVersion: report.hub.liveVersion,
      hubCL: report.hub.liveCL,
      cliVersion: report.cli.liveVersion,
      ompVersion: report.ompUpstream.liveVersion,
      bumpPatch: doBump,
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ report, sync }, null, 2));
  } else {
    console.log(`[Google Antigravity Hub]`);
    console.log(`  Baseline Fallback : v${report.hub.baselineVersion} (cl=${report.hub.baselineCL})`);
    console.log(`  Live Production   : v${report.hub.liveVersion} (cl=${report.hub.liveCL})`);
    console.log(`  Status            : ${report.hub.drift ? "⚠️  DRIFT DETECTED" : "✅ UP TO DATE"}\n`);

    console.log(`[Google Antigravity CLI]`);
    console.log(`  Baseline          : v${report.cli.baselineVersion}`);
    console.log(`  Live Version      : v${report.cli.liveVersion}`);
    console.log(`  Status            : ${report.cli.drift ? "⚠️  DRIFT DETECTED" : "✅ UP TO DATE"}\n`);

    console.log(`[Upstream OMP (can1357/oh-my-pi)]`);
    console.log(`  KDL Accessible    : ${report.ompUpstream.ruleAccessible ? "Yes" : "No"}`);
    console.log(`  Auth Policy       : ${report.ompUpstream.authPolicy}`);
    console.log(`  Native Argon Tier : ${report.ompUpstream.nativeArgonTier ? "Yes" : "No"}`);
    console.log(
      `  Package Version   : ^${report.ompUpstream.devVersion} -> npm v${report.ompUpstream.liveVersion ?? "unknown"}${report.ompUpstream.versionDrift ? " (DRIFT)" : ""}`
    );
    if (report.patchCompat.checked) {
      console.log(
        `  Patch Compat      : ${report.patchCompat.compatible ? "✅ Compatible" : "❌ Incompatible"} (summary=${report.patchCompat.summary}, resolveOAuth=${report.patchCompat.resolveOAuth}, meter=${report.patchCompat.meter})`
      );
    }

    if (report.details.length > 0) {
      console.log(`\nNotes & Alerts:`);
      for (const d of report.details) {
        console.log(`  • ${d}`);
      }
    }

    if (sync) {
      console.log(
        sync.changedFiles.length > 0
          ? `\n🔧 Applied sync to: ${sync.changedFiles.join(", ")}${sync.newVersion ? ` (bumped to v${sync.newVersion})` : ""}`
          : "\n✨ No local file changes needed."
      );
    } else if (!report.hasDrift) {
      console.log("\n✅ All upstream signals are aligned with current baseline.");
    }
  }

  if (report.hasDrift && writeReport) {
    const md = buildReportMarkdown(report, sync);
    fs.writeFileSync("drift-report.md", md);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    }
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    appendGithubEnv("DRIFT_DETECTED", String(report.hasDrift));
    appendGithubEnv("MANUAL_REVIEW_REQUIRED", String(report.requiresManualReview));
    appendGithubEnv("SYNC_APPLIED", String(Boolean(sync && sync.changedFiles.length > 0)));
    appendGithubEnv("SYNC_BUMPED", String(Boolean(sync?.newVersion)));
    if (sync?.newVersion) {
      appendGithubEnv("NEW_VERSION", sync.newVersion);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Monitor error:", err);
    process.exit(1);
  });
}
