/**
 * src/constants.ts
 *
 * Wire endpoints, OAuth configuration, and baseline parameters for Google Antigravity.
 */

export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = "/oauth-callback";
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
];

export const MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";

export const FALLBACK_VERSION = "2.32.1";
export const FALLBACK_CL = "6001966350991360";
export const CLI_BASELINE_VERSION = "1.5.9";
export const FALLBACK_PROJECT_ID = "rising-fact-p41fc";

/**
 * Google Antigravity appeal form, surfaced whenever a 403 TOS_VIOLATION ban is detected.
 */
export const APPEAL_FORM_URL = "https://forms.gle/hGzM9MEUv2azZsrb9";

/**
 * OAuth client provenance is resolved at runtime (see src/agy-client.ts):
 * explicit env → local `agy` binary extraction (cached user-locally) → OMP
 * built-in pair. GitHub push protection rightly rejects Google OAuth client
 * literals in this public repository, so no credentials live in source.
 *
 * Fragments below are provenance markers only — intentionally incomplete so
 * they cannot be reassembled into working credentials from the repo.
 */

/** Prefix of the official `agy` CLI client ID (first-party logins). */
export const AGY_CLI_OAUTH_CLIENT_ID_PREFIX = "884354919052-";

/** Prefix of the legacy shared Cloud Code Assist client baked into older
 * unofficial clients; its use across thousands of unrelated IPs is Google's
 * primary third-party detection signal (see docs/LEGIT_ANTIGRAVITY_SIGNATURE.md). */
export const PUBLIC_SHARED_OAUTH_CLIENT_ID_PREFIX = "1071006060591-";

/** Redirect path used by the official `agy` CLI (`http://localhost:<port>/auth/callback`). */
export const AGY_CALLBACK_PATH = "/auth/callback";
