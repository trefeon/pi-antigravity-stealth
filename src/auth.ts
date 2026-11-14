/**
 * src/auth.ts
 *
 * OAuth authentication, token refresh, and GCP project discovery for Antigravity.
 * Delegates to OMP's shipped Google Antigravity client credentials unless custom
 * ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET env vars are explicitly configured.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as crypto from "crypto";
import { execFile } from "child_process";
import {
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_SCOPES,
  CALLBACK_PATH,
  CALLBACK_PORT,
  FALLBACK_PROJECT_ID,
  OAUTH_AUTH_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  REDIRECT_URI,
} from "./constants.ts";
import { buildHubUserAgent } from "./manifest.ts";
import { getBuiltinAntigravityClientCredentials } from "./omp-builtin.ts";

export interface AntigravityCredentials {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  projectId?: string;
  email?: string;
  accountId?: string;
}

export interface BrowserLoginCallbacks {
  onProgress?: (message: string) => void;
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onPrompt?: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onManualCodeInput?: () => Promise<string>;
  openBrowser?: boolean;
  signal?: AbortSignal;
}

export function parseOAuthCallbackInput(rawInput: string, expectedState: string): { code: string } {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error("Empty OAuth callback URL or authorization code.");
  }

  let params: URLSearchParams | null = null;
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    params = parsed.searchParams;
  } else if (trimmed.includes("code=") || trimmed.includes("error=") || trimmed.startsWith("?")) {
    params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
  }

  if (params) {
    const error = params.get("error");
    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }
    const returnedState = params.get("state");
    if (returnedState && returnedState !== expectedState) {
      throw new Error("OAuth state verification failed.");
    }
    const code = params.get("code");
    if (!code) {
      throw new Error("Missing authorization code in pasted callback URL.");
    }
    return { code };
  }

  return { code: trimmed };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getEffectiveClientId(): string {
  return process.env.ANTIGRAVITY_CLIENT_ID?.trim() || "";
}

export function getEffectiveClientSecret(): string {
  return process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() || "";
}

export function hasCustomOAuthClient(): boolean {
  return Boolean(process.env.ANTIGRAVITY_CLIENT_ID?.trim() && process.env.ANTIGRAVITY_CLIENT_SECRET?.trim());
}

export function resolveOAuthClientCredentials(): { clientId: string; clientSecret: string } {
  const customId = getEffectiveClientId();
  const customSecret = getEffectiveClientSecret();
  if (customId && customSecret) {
    return { clientId: customId, clientSecret: customSecret };
  }
  const builtin = getBuiltinAntigravityClientCredentials();
  if (builtin) {
    return builtin;
  }
  return { clientId: customId, clientSecret: customSecret };
}

const ALLOWED_ENV_FILE_KEY = /^(ANTIGRAVITY_[A-Z0-9_]+|PI_(?:AI_)?ANTIGRAVITY_[A-Z0-9_]+)$/;

/**
 * Populates unset Antigravity env vars from `.env` and `~/.omp/antigravity.env`.
 * Explicit process environment variables always take precedence.
 */
export function loadAntigravityEnvFiles(pathsOverride?: string[]): number {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const files =
    pathsOverride ?? [
      path.resolve(process.cwd(), ".env"),
      ...(home ? [path.join(home, ".omp", "antigravity.env")] : []),
    ];

  let loaded = 0;
  for (const filePath of files) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    try {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
        const eqIdx = line.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        if (!ALLOWED_ENV_FILE_KEY.test(key)) continue;
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
          (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
        ) {
          val = val.slice(1, -1);
        } else {
          const commentIdx = val.indexOf(" #");
          if (commentIdx >= 0) {
            val = val.slice(0, commentIdx).trim();
          }
        }
        if (val && !process.env[key]) {
          process.env[key] = val;
          loaded++;
        }
      }
    } catch {}
  }
  return loaded;
}

export async function loginWithBrowser(
  callbacksOrProgress?: ((message: string) => void) | BrowserLoginCallbacks
): Promise<AntigravityCredentials> {
  const callbacks: BrowserLoginCallbacks =
    typeof callbacksOrProgress === "function"
      ? { onProgress: callbacksOrProgress }
      : callbacksOrProgress ?? {};

  const { clientId, clientSecret } = resolveOAuthClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google Antigravity OAuth client credentials are unavailable. Set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET or run inside OMP."
    );
  }

  const verifier = crypto
    .randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest()
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = new URL(OAUTH_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  const { promise, resolve, reject } = Promise.withResolvers<AntigravityCredentials>();
  let settled = false;

  const cleanup = () => {
    callbacks.signal?.removeEventListener("abort", cleanupAbort);
    try {
      server.close();
    } catch {}
  };

  const fail = (err: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(err instanceof Error ? err : new Error(String(err)));
  };

  const cleanupAbort = () => {
    fail(new Error("Antigravity login cancelled."));
  };

  if (callbacks.signal?.aborted) {
    throw new Error("Antigravity login cancelled.");
  }
  callbacks.signal?.addEventListener("abort", cleanupAbort, { once: true });

  const completeWithCode = async (code: string) => {
    if (settled) return;
    settled = true;
    cleanup();

    try {
      callbacks.onProgress?.("Exchanging authorization code for tokens...");
      const userAgent = await buildHubUserAgent();

      const tokenParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });

      const tokenRes = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent,
          Accept: "application/json",
        },
        body: tokenParams.toString(),
        signal: callbacks.signal,
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        reject(new Error(`Token exchange failed (${tokenRes.status}): ${errText}`));
        return;
      }

      const tokenData = (await tokenRes.json()) as Record<string, unknown>;
      const accessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
      const refreshToken = typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : undefined;
      const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;

      let email: string | undefined;
      try {
        const userinfoRes = await fetch(OAUTH_USERINFO_URL, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": userAgent,
          },
          signal: callbacks.signal,
        });
        if (userinfoRes.ok) {
          const userinfo = (await userinfoRes.json()) as Record<string, unknown>;
          if (typeof userinfo.email === "string") {
            email = userinfo.email;
          }
        }
      } catch {}

      callbacks.onProgress?.("Discovering Cloud Code Assist project...");
      let projectId = FALLBACK_PROJECT_ID;
      try {
        const projRes = await fetch(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": userAgent,
          },
          body: JSON.stringify({
            metadata: { ideType: "ANTIGRAVITY" },
          }),
          signal: callbacks.signal,
        });
        if (projRes.ok) {
          const projData = (await projRes.json()) as Record<string, unknown>;
          const rawProject = projData.cloudaicompanionProject;
          if (typeof rawProject === "string" && rawProject.length > 0) {
            projectId = rawProject;
          } else if (rawProject && typeof rawProject === "object" && "id" in rawProject) {
            const innerId = rawProject.id;
            if (typeof innerId === "string" && innerId.length > 0) {
              projectId = innerId;
            }
          }
        }
      } catch {}

      resolve({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresIn,
        expires_at: Date.now() + expiresIn * 1000 - 300000,
        projectId,
        email,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || "", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h3>Authentication Failed</h3><p>${escapeHtml(error)}</p>`);
        fail(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h3>Invalid Callback</h3><p>State mismatch or missing authorization code.</p>");
        fail(new Error("OAuth state verification failed."));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h3>Success!</h3><p>Antigravity authentication successful. You can close this window.</p>");
      void completeWithCode(code);
    } catch (err) {
      fail(err);
    }
  });

  const startManualInput = () => {
    const reader = callbacks.onManualCodeInput
      ? () => callbacks.onManualCodeInput!()
      : callbacks.onPrompt
      ? () =>
          callbacks.onPrompt!({
            message: "Paste the redirected localhost callback URL (or authorization code)",
            placeholder: `${REDIRECT_URI}?code=...&state=...`,
          })
      : null;
    if (!reader) return;
    void reader()
      .then((raw) => {
        if (settled) return;
        const parsed = parseOAuthCallbackInput(raw, state);
        void completeWithCode(parsed.code);
      })
      .catch((err) => {
        if (!settled) {
          fail(err);
        }
      });
  };

  server.listen(CALLBACK_PORT, "127.0.0.1", () => {
    const urlStr = authUrl.toString();
    callbacks.onAuth?.({
      url: urlStr,
      instructions:
        "Open the URL in your browser. Over SSH, forward port 51121 (ssh -L 51121:127.0.0.1:51121 <host>) or paste the callback URL.",
    });
    callbacks.onProgress?.(`Opening browser for Antigravity sign-in: ${urlStr}`);
    if (callbacks.openBrowser ?? !callbacks.onAuth) {
      openBrowser(urlStr);
    }
    startManualInput();
  });

  server.on("error", (err) => {
    if (callbacks.onManualCodeInput || callbacks.onPrompt) {
      const urlStr = authUrl.toString();
      callbacks.onAuth?.({
        url: urlStr,
        instructions: `Port ${CALLBACK_PORT} is busy; open the URL and paste the redirected callback URL.`,
      });
      startManualInput();
      return;
    }
    fail(new Error(`Failed to bind callback server on port ${CALLBACK_PORT}: ${err.message}`));
  });

  return promise;
}

export async function refreshAccessToken(
  refreshToken: string,
  existingProjectId?: string,
  options?: { email?: string; accountId?: string; signal?: AbortSignal }
): Promise<AntigravityCredentials> {
  const { clientId, clientSecret } = resolveOAuthClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google Antigravity OAuth client credentials are unavailable for token refresh."
    );
  }
  const userAgent = await buildHubUserAgent();

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
      Accept: "application/json",
    },
    body: params.toString(),
    signal: options?.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errText}`);
  }

  const tokenData = (await res.json()) as Record<string, unknown>;
  const accessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
  const newRefreshToken = typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : refreshToken;
  const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;

  return {
    access_token: accessToken,
    refresh_token: newRefreshToken,
    expires_in: expiresIn,
    expires_at: Date.now() + expiresIn * 1000 - 300000,
    projectId: existingProjectId || FALLBACK_PROJECT_ID,
    ...(options?.email ? { email: options.email } : {}),
    ...(options?.accountId ? { accountId: options.accountId } : {}),
  };
}

export function resolveBrowserLaunch(
  url: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  const { command, args } = resolveBrowserLaunch(url);
  try {
    const child = execFile(command, args, { windowsHide: true }, () => {});
    child.unref?.();
  } catch {}
}
