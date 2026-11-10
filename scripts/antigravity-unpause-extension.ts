/**
 * scripts/antigravity-unpause-extension.ts
 *
 * Native Oh My Pi extension that un-pauses Google Antigravity WITHOUT patching node_modules.
 * Also seeds verified stealth version and changelist into the environment.
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
  process.env.PI_AI_ANTIGRAVITY_VERSION ??= "2.30.0";
  process.env.PI_AI_ANTIGRAVITY_CL ??= "6386428939206656";
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
          const token = credentials.access;
          if (typeof token === "string") return token;
        }
        return "";
      },
    },
  });

  pi.logger.info("google-antigravity unpaused and stealth signatures primed via extension hook");
}
