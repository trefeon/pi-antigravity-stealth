/**
 * scripts/antigravity-unpause-extension.ts
 *
 * Standalone Oh My Pi extension that un-pauses Google Antigravity on OMP 18.18.4–18.18.6
 * without patching node_modules, and primes verified Hub version/changelist on all OMP versions.
 *
 * How it works:
 * Upstream OMP defines:
 *   function providerPauseReason(provider) {
 *     return customOAuthProviders.has(provider) ? undefined : providerDisabledReason(provider);
 *   }
 * "An extension that registers its own OAuth login under the paused id takes the id back:
 *  that is the end user's choice." (packages/ai/src/registry/oauth/index.ts)
 *
 * Installation:
 *   Copy this file to ~/.omp/agent/extensions/antigravity-unpause.ts
 *   Windows: C:/Users/<User>/.omp/agent/extensions/antigravity-unpause.ts
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function antigravityUnpauseExtension(pi: ExtensionAPI): void {
  // Ensure verified stealth Antigravity Hub version and internal changelist are active
  process.env.PI_AI_ANTIGRAVITY_VERSION ??= "2.32.1";
  process.env.PI_AI_ANTIGRAVITY_CL ??= "6001966350991360";
  if (process.platform === "win32") {
    process.env.PI_AI_ANTIGRAVITY_OS ??= "windows";
  }

  // Registering an OAuth handler under "google-antigravity" populates customOAuthProviders,
  // causing providerPauseReason("google-antigravity") to return undefined.
  pi.registerProvider("google-antigravity", {
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    oauth: {
      name: "Google Antigravity (Restored via Extension)",
      async login(callbacks) {
        callbacks.onProgress?.("Re-authenticating Antigravity through extension harness...");
        throw new Error(
          "To log in to new Antigravity accounts, use 'omp login google-antigravity' with a patched bundle, or use the official Cloud Code extension."
        );
      },
      async refreshToken(credentials) {
        // Return credentials unchanged; OMP's built-in refresh hook handles Google token refresh
        return credentials;
      },
      getApiKey(credentials) {
        if (credentials && typeof credentials === "object" && "access" in credentials) {
          const c = credentials as Record<string, unknown>;
          const token = typeof c.access === "string" ? c.access : "";
          if (!token) return "";
          return JSON.stringify({
            ...(typeof c.apiEndpoint === "string" ? { apiEndpoint: c.apiEndpoint } : {}),
            token,
            ...(typeof c.enterpriseUrl === "string" ? { enterpriseUrl: c.enterpriseUrl } : {}),
            projectId:
              typeof c.projectId === "string" && c.projectId.length > 0
                ? c.projectId
                : "rising-fact-p41fc",
            ...(typeof c.refresh === "string" ? { refreshToken: c.refresh } : {}),
            ...(typeof c.expires === "number" ? { expiresAt: c.expires } : {}),
            ...(typeof c.email === "string" ? { email: c.email } : {}),
            ...(typeof c.accountId === "string" ? { accountId: c.accountId } : {}),
          });
        }
        return "";
      },
    },
  });

  pi.logger.info("google-antigravity unpaused and stealth signatures primed via extension hook");
}
