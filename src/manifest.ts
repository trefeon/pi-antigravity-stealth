/**
 * src/manifest.ts
 *
 * Dynamic Antigravity Hub version fetcher and canonical User-Agent generator.
 */

import { FALLBACK_CL, FALLBACK_VERSION, MANIFEST_URL } from "./constants.ts";

export interface VersionInfo {
  version: string;
  changelist: string;
}

let cachedVersion: VersionInfo | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getLiveHubVersion(timeoutMs = 4000): Promise<VersionInfo> {
  const now = Date.now();
  if (cachedVersion && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedVersion;
  }

  // Allow manual overrides via environment
  if (process.env.PI_AI_ANTIGRAVITY_VERSION && process.env.PI_AI_ANTIGRAVITY_CL) {
    cachedVersion = {
      version: process.env.PI_AI_ANTIGRAVITY_VERSION,
      changelist: process.env.PI_AI_ANTIGRAVITY_CL,
    };
    return cachedVersion;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(MANIFEST_URL, {
      headers: {
        "User-Agent": "electron-builder",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const text = await res.text();
      let version = FALLBACK_VERSION;
      let changelist = FALLBACK_CL;

      const vMatch = text.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m);
      if (vMatch?.[1]) {
        version = vMatch[1];
      }

      // Pair the changelist with the parsed version: only trust a CL when it is
      // published adjacent to the exact Hub version in the manifest, otherwise
      // we risk emitting a UA that advertises a build that never shipped.
      const clMatch = text.match(new RegExp(`${version.replace(/\./g, "\\.").replace(/-/g, "\\-")}-([0-9]+)`));
      if (clMatch?.[1]) {
        changelist = clMatch[1];
      }

      cachedVersion = { version, changelist };
      lastFetchTime = now;
      return cachedVersion;
    }
  } catch {}

  // Cache the failure too: without a lastFetchTime bump, every caller retries the
  // (potentially blocked) manifest fetch and pays the full timeout each time.
  cachedVersion = {
    version: process.env.PI_AI_ANTIGRAVITY_VERSION || FALLBACK_VERSION,
    changelist: process.env.PI_AI_ANTIGRAVITY_CL || FALLBACK_CL,
  };
  lastFetchTime = now;
  return cachedVersion;
}

export function resolvePlatform(): { os: string; arch: string } {
  let os = "linux";
  if (process.platform === "win32") os = "windows";
  else if (process.platform === "darwin") os = "darwin";

  let arch = "amd64";
  if (process.arch === "arm64") arch = "arm64";

  return { os, arch };
}

export async function buildHubUserAgent(): Promise<string> {
  const { version, changelist } = await getLiveHubVersion();
  const { os, arch } = resolvePlatform();
  const clPart = changelist ? `; cl=${changelist}` : "";
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}${clPart})`;
}
