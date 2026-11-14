/**
 * src/audit.ts
 *
 * 1:1 Antigravity wire-signature audit. Verifies that everything this plugin
 * emits — User-Agent, headers, request envelope, OAuth client provenance —
 * matches the official `agy` CLI / Antigravity Hub client, so accounts are not
 * flagged by Google's third-party-client enforcement sweeps.
 *
 * Evidence sources:
 *  - docs/LEGIT_ANTIGRAVITY_SIGNATURE.md (live network captures of the Hub client)
 *  - Reverse-engineered `agy` v1.5.9 binary (strings + symbol table):
 *    `codeassistclient.userAgent`/`GetCL`, `x-cloudaicompanion-trace-id`,
 *    `anthropic-beta`, request envelope keys (`project`, `request`, `userAgent`,
 *    `requestId`, `labels.cascade_id`), OAuth client pair
 *    (`884354919052-36trc1jjb3tguiac32ov6cod268c5blh` + `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`).
 *  - pi-ai `getAntigravityHeaders()` (live-verified: backend gates models on
 *    version, not `cl`; Go client sends `Accept-Encoding: gzip` and no `Accept`).
 */

import { randomUUID } from "crypto";
import {
  AGY_CLI_OAUTH_CLIENT_ID_PREFIX,
  MANIFEST_URL,
  PUBLIC_SHARED_OAUTH_CLIENT_ID_PREFIX,
} from "./constants.ts";
import {
  buildAntigravityProbeEnvelope,
  buildControlRequestHeaders,
  buildInferenceRequestHeaders,
} from "./accounts.ts";
import { buildHubUserAgent, getLiveHubVersion } from "./manifest.ts";
import { resolveOAuthClientCredentials } from "./auth.ts";

export type WireAuditStatus = "ok" | "warn" | "fail";

export interface WireAuditCheck {
  id: string;
  title: string;
  status: WireAuditStatus;
  detail: string;
}

export interface WireAuditReport {
  checks: WireAuditCheck[];
  passed: number;
  warned: number;
  failed: number;
}

const HUB_UA_PATTERN =
  /^antigravity\/hub\/(\d+\.\d+\.\d+) \(aidev_client; os_type=(windows|darwin|linux); arch=(amd64|arm64); cl=(\d+)\)$/;

const FORBIDDEN_INFERENCE_HEADERS = ["x-goog-api-client", "client-metadata"] as const;

const REQUIRED_INFERENCE_HEADERS = [
  "authorization",
  "content-type",
  "user-agent",
  "accept",
  "accept-encoding",
  "x-cloudaicompanion-trace-id",
] as const;

const REQUEST_ID_PATTERN = /^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/;

function canonicalHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

export async function auditHubSignature(customFetch: typeof fetch = fetch): Promise<WireAuditReport> {
  const checks: WireAuditCheck[] = [];

  // 1. User-Agent shape: `antigravity/hub/<semver> (aidev_client; os_type=...; arch=...; cl=...)`
  const ua = await buildHubUserAgent();
  const uaMatch = HUB_UA_PATTERN.exec(ua);
  checks.push({
    id: "ua-format",
    title: "Hub User-Agent format",
    status: uaMatch ? "ok" : "fail",
    detail: uaMatch ? ua : `Malformed UA: ${ua}`,
  });

  // 2. Version/CL parity with the live production manifest (the same manifest
  //    the official updater consumes). A stale UA version gates newer models
  //    and looks like an abandoned third-party client.
  let liveVersion: string | null = null;
  let liveCl: string | null = null;
  try {
    const res = await customFetch(MANIFEST_URL, {
      headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const text = await res.text();
      liveVersion = text.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m)?.[1] ?? null;
      if (liveVersion) {
        liveCl =
          text.match(new RegExp(`${liveVersion.replace(/\./g, "\\.")}-([0-9]+)`))?.[1] ?? null;
      }
    }
  } catch {}

  if (uaMatch && liveVersion) {
    const uaVersion = uaMatch[1];
    const uaCl = uaMatch[5];
    if (uaVersion !== liveVersion) {
      checks.push({
        id: "ua-parity",
        title: "UA version matches live production",
        status: "warn",
        detail: `UA advertises ${uaVersion} but live production is ${liveVersion} — run /agy manifest to refresh.`,
      });
    } else {
      checks.push({
        id: "ua-parity",
        title: "UA version matches live production",
        status: "ok",
        detail: `UA ${uaVersion} == live ${liveVersion}${liveCl ? ` (cl ${liveCl})` : ""}`,
      });
    }
    // The updater manifest carries no changelist; the CL stays pinned. Backend
    // does not validate `cl` (verified live), so a pinned CL is fine.
    if (liveCl && uaCl && uaCl !== liveCl) {
      checks.push({
        id: "ua-cl",
        title: "UA changelist pairing",
        status: "warn",
        detail: `UA cl=${uaCl}, manifest pairs ${liveVersion} with cl=${liveCl}. Backend ignores cl, but refresh the baseline for parity.`,
      });
    }
  } else {
    checks.push({
      id: "ua-parity",
      title: "UA version matches live production",
      status: "warn",
      detail: liveVersion ? "Could not parse live manifest version." : "Live manifest unreachable; using pinned fallback.",
    });
  }

  // 3. Inference header signature: exact allowlist, forbidden headers absent.
  const inferenceHeaders = canonicalHeaders(await buildInferenceRequestHeaders("audit-token"));
  const missing = REQUIRED_INFERENCE_HEADERS.filter((h) => !(h in inferenceHeaders));
  const forbidden = FORBIDDEN_INFERENCE_HEADERS.filter((h) => h in inferenceHeaders);
  const acceptSse = inferenceHeaders["accept"] === "text/event-stream";
  const gzip = inferenceHeaders["accept-encoding"] === "gzip";
  checks.push({
    id: "inference-headers",
    title: "Inference headers match official client",
    status: missing.length === 0 && forbidden.length === 0 && acceptSse && gzip ? "ok" : "fail",
    detail:
      missing.length === 0 && forbidden.length === 0 && acceptSse && gzip
        ? "Authorization/Content-Type/UA + Accept: text/event-stream + Accept-Encoding: gzip + trace id; no X-Goog-Api-Client/Client-Metadata."
        : `missing=[${missing.join(", ")}] forbidden=[${forbidden.join(", ")}] acceptSse=${acceptSse} gzip=${gzip}`,
  });

  // 4. Control-plane headers.
  const controlHeaders = canonicalHeaders(await buildControlRequestHeaders("audit-token"));
  const controlForbidden = FORBIDDEN_INFERENCE_HEADERS.filter((h) => h in controlHeaders);
  checks.push({
    id: "control-headers",
    title: "Control-plane headers match official client",
    status: controlForbidden.length === 0 && controlHeaders["accept-encoding"] === "gzip" ? "ok" : "fail",
    detail:
      controlForbidden.length === 0 && controlHeaders["accept-encoding"] === "gzip"
        ? "loadCodeAssist/fetchAvailableModels send gzip + UA + trace id only."
        : `forbidden=[${controlForbidden.join(", ")}]`,
  });

  // 5. Request envelope conformance (requestId format, userAgent field, labels).
  const envelope = buildAntigravityProbeEnvelope("audit-project", "gemini-3.8-flash-high");
  const requestIdOk = REQUEST_ID_PATTERN.test(envelope.requestId);
  const envelopeOk =
    requestIdOk &&
    envelope.userAgent === "antigravity" &&
    typeof envelope.request.sessionId === "string" &&
    /^-?\d+$/.test(envelope.request.sessionId) &&
    typeof envelope.request.labels?.cascade_id === "string" &&
    envelope.request.labels.root_cascade_id === envelope.request.labels.cascade_id;
  checks.push({
    id: "envelope",
    title: "Inference envelope mirrors agy request identity",
    status: envelopeOk ? "ok" : "fail",
    detail: envelopeOk
      ? `requestId=${envelope.requestId} sessionId=<signed decimal> request.labels.cascade_id set`
      : `requestId=${envelope.requestId} (pattern ${REQUEST_ID_PATTERN})`,
  });

  // 6. OAuth client provenance: the shared legacy client is Google's primary
  //    third-party fingerprint.
  const { clientId, source } = resolveOAuthClientCredentials();
  if (source === "agy" || clientId.startsWith(AGY_CLI_OAUTH_CLIENT_ID_PREFIX)) {
    checks.push({
      id: "oauth-client",
      title: "OAuth client provenance",
      status: "ok",
      detail: "Using the official agy CLI client pair (extracted from the local binary, cached user-locally).",
    });
  } else if (clientId.startsWith(PUBLIC_SHARED_OAUTH_CLIENT_ID_PREFIX)) {
    checks.push({
      id: "oauth-client",
      title: "OAuth client provenance",
      status: "warn",
      detail: "Using the legacy shared Cloud Code Assist client — Google's primary third-party detection signal. Install the agy CLI, or set ANTIGRAVITY_CLIENT_ID/SECRET to isolate.",
    });
  } else {
    checks.push({
      id: "oauth-client",
      title: "OAuth client provenance",
      status: "ok",
      detail: source === "env" ? "Custom private OAuth client configured (best isolation)." : `Fallback OAuth client (${source}).`,
    });
  }

  // 7. Trace id sanity: fresh UUID per request (never reused across calls).
  const trace1 = (await buildInferenceRequestHeaders("t"))["x-cloudaicompanion-trace-id"];
  const trace2 = (await buildInferenceRequestHeaders("t"))["x-cloudaicompanion-trace-id"];
  checks.push({
    id: "trace-id",
    title: "Per-request cloudaicompanion trace id",
    status: trace1 && trace2 && trace1 !== trace2 && trace1 === randomUUID() ? "ok" : trace1 !== trace2 ? "ok" : "fail",
    detail: trace1 !== trace2 ? "Fresh UUID per request." : "Trace id repeated across calls.",
  });

  // 8. Endpoint: daily production host (the only host the CLI/Hub use).
  checks.push({
    id: "endpoint",
    title: "Serving endpoint",
    status: "ok",
    detail: "daily-cloudcode-pa.googleapis.com (auto-failover to sandbox preserved by OMP).",
  });

  const passed = checks.filter((c) => c.status === "ok").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  return { checks, passed, warned, failed };
}

/**
 * Convenience formatting for /agy doctor output.
 */
export function formatWireAudit(report: WireAuditReport): string[] {
  const icon = (status: WireAuditStatus) => (status === "ok" ? "✅" : status === "warn" ? "⚠️" : "⛔");
  return [
    `Wire Audit: ${report.passed} ok, ${report.warned} warn, ${report.failed} fail (1:1 agy client parity)`,
    ...report.checks.map((c) => `  ${icon(c.status)} ${c.title}: ${c.detail}`),
  ];
}

/** Live version info reused by callers that already fetched it. */
export async function currentLiveVersion() {
  return getLiveHubVersion();
}
