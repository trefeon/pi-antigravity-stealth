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
