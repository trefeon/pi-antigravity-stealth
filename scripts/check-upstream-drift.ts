#!/usr/bin/env bun
/**
 * scripts/check-upstream-drift.ts
 *
 * Automated upstream drift monitor for Google Antigravity & Oh My Pi.
 *
 * Probes:
 * 1. Google Antigravity Hub live manifest (version & CL).
 * 2. Google Antigravity CLI live manifest (binary releases).
 * 3. Upstream OMP repository auth rules (packages/catalog/.../google-antigravity.kdl).
 *
 * When run locally: prints a structured report.
 * When run in GitHub Actions: opens an issue to notify the maintainer if drift is detected.
 */

import * as fs from "fs";
import { FALLBACK_CL, FALLBACK_VERSION, MANIFEST_URL } from "../src/constants.ts";

interface DriftReport {
  timestamp: string;
  hasDrift: boolean;
  hub: {
    baselineVersion: string;
    baselineCL: string;
    liveVersion: string;
    liveCL: string;
    drift: boolean;
  };
  cli: {
    liveVersion: string;
    url: string;
  };
  ompUpstream: {
    disabled: boolean;
    disabledMessage: string | null;
    ruleAccessible: boolean;
  };
  details: string[];
}

const CLI_MANIFEST_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json";
const UPSTREAM_KDL_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/compat/rules/auth/google-antigravity.kdl";

async function runCheck(): Promise<DriftReport> {
  const details: string[] = [];
  let hasDrift = false;

  // 1. Probe Hub Manifest
  let liveHubVersion = FALLBACK_VERSION;
  let liveHubCL = FALLBACK_CL;
  try {
    const res = await fetch(MANIFEST_URL, {
      headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
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
      `Google Hub version updated: baseline is v${FALLBACK_VERSION} (cl=${FALLBACK_CL}), live is v${liveHubVersion} (cl=${liveHubCL}).`
    );
  }

  // 2. Probe CLI Manifest
  let liveCliVersion = "unknown";
  let liveCliUrl = "";
  try {
    const res = await fetch(CLI_MANIFEST_URL);
    if (res.ok) {
      const data = (await res.json()) as { version?: string; url?: string };
      liveCliVersion = data.version || "unknown";
      liveCliUrl = data.url || "";
    }
  } catch (err) {
    details.push(`Failed to reach Google CLI manifest: ${err}`);
  }

  // 3. Probe Upstream OMP KDL
  let ompDisabled = true;
  let ompMessage: string | null = null;
  let ompAccessible = false;
  try {
    const res = await fetch(UPSTREAM_KDL_URL);
    if (res.ok) {
      ompAccessible = true;
      const kdl = await res.text();
      const disabledMatch = kdl.match(/disabled\s+"([^"]+)"/);
      if (disabledMatch) {
        ompDisabled = true;
        ompMessage = disabledMatch[1] ?? null;
      } else {
        ompDisabled = false;
        hasDrift = true;
        details.push(
          "Upstream OMP has removed the disabled flag in google-antigravity.kdl!"
        );
      }
    }
  } catch (err) {
    details.push(`Failed to fetch upstream OMP KDL rule: ${err}`);
  }

  return {
    timestamp: new Date().toISOString(),
    hasDrift,
    hub: {
      baselineVersion: FALLBACK_VERSION,
      baselineCL: FALLBACK_CL,
      liveVersion: liveHubVersion,
      liveCL: liveHubCL,
      drift: hubDrift,
    },
    cli: {
      liveVersion: liveCliVersion,
      url: liveCliUrl,
    },
    ompUpstream: {
      disabled: ompDisabled,
      disabledMessage: ompMessage,
      ruleAccessible: ompAccessible,
    },
    details,
  };
}

async function main() {
  console.log("🔍 Checking upstream drift for Google Antigravity & OMP...\n");
  const report = await runCheck();

  console.log(`[Google Antigravity Hub]`);
  console.log(`  Baseline Fallback : v${report.hub.baselineVersion} (cl=${report.hub.baselineCL})`);
  console.log(`  Live Production   : v${report.hub.liveVersion} (cl=${report.hub.liveCL})`);
  console.log(`  Status            : ${report.hub.drift ? "⚠️  DRIFT DETECTED" : "✅ UP TO DATE"}\n`);

  console.log(`[Google Antigravity CLI]`);
  console.log(`  Live Version      : v${report.cli.liveVersion}\n`);

  console.log(`[Upstream OMP (can1357/oh-my-pi)]`);
  console.log(`  KDL Accessible    : ${report.ompUpstream.ruleAccessible ? "Yes" : "No"}`);
  console.log(`  Paused Status     : ${report.ompUpstream.disabled ? "Paused (Expected)" : "Unpaused"}`);
  if (report.ompUpstream.disabledMessage) {
    console.log(`  Reason            : "${report.ompUpstream.disabledMessage}"`);
  }

  if (report.details.length > 0) {
    console.log(`\nNotes & Alerts:`);
    for (const d of report.details) {
      console.log(`  • ${d}`);
    }
  }

  if (report.hasDrift) {
    console.log("\n⚠️  Action required: Upstream changes detected.");
    const reportMd =
      `### 🚨 Upstream Antigravity Drift Detected\n\n` +
      report.details.map((d) => `- ${d}`).join("\n") +
      `\n\n- **Live Google Hub:** \`v${report.hub.liveVersion}\` (CL \`${report.hub.liveCL}\`)\n` +
      `- **Live Google CLI:** \`v${report.cli.liveVersion}\`\n` +
      `- **Upstream OMP Disabled Status:** ${report.ompUpstream.disabled ? "Paused" : "Unpaused"}\n\n` +
      `Please verify and update baseline parameters in \`src/constants.ts\`.\n`;

    fs.writeFileSync("drift-report.md", reportMd);

    if (process.env.GITHUB_ACTIONS === "true") {
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) {
        fs.appendFileSync(summaryFile, reportMd);
      }
      const envFile = process.env.GITHUB_ENV;
      if (envFile) {
        fs.appendFileSync(envFile, `DRIFT_DETECTED=true\n`);
      }
    }
  } else {
    console.log("\n✅ All upstream signals are aligned with current baseline.");
  }
}

main().catch((err) => {
  console.error("Monitor error:", err);
  process.exit(1);
});
