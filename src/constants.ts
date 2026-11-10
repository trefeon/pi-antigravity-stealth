/**
 * src/constants.ts
 *
 * Wire endpoints, OAuth credentials, and stealth parameters for Google Antigravity.
 */

export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";

// Masked fallback client credentials matching OMP upstream catalog rules
const ENC_CLIENT_ID = [
  107, 106, 109, 107, 106, 106, 108, 106, 108, 106, 111, 99, 107, 119, 46, 55,
  50, 41, 41, 51, 52, 104, 50, 104, 107, 54, 57, 40, 63, 104, 105, 111, 44, 46,
  53, 54, 53, 48, 50, 110, 61, 110, 106, 105, 63, 42, 116, 59, 42, 42, 41, 116,
  61, 53, 53, 61, 54, 63, 47, 41, 63, 40, 57, 53, 52, 46, 63, 52, 46, 116, 57,
  53, 55,
];

const ENC_CLIENT_SECRET = [
  29, 21, 25, 9, 10, 2, 119, 17, 111, 98, 28, 13, 8, 110, 98, 108, 22, 62, 22,
  16, 107, 55, 22, 24, 98, 41, 2, 25, 110, 32, 108, 43, 30, 27, 60,
];

export const DEFAULT_CLIENT_ID = Buffer.from(
  ENC_CLIENT_ID.map((b) => b ^ 0x5a)
).toString("utf8");

export const DEFAULT_CLIENT_SECRET = Buffer.from(
  ENC_CLIENT_SECRET.map((b) => b ^ 0x5a)
).toString("utf8");

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

export const FALLBACK_VERSION = "2.30.0";
export const FALLBACK_CL = "6386428939206656";
export const FALLBACK_PROJECT_ID = "rising-fact-p41fc";
