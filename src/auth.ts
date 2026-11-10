/**
 * src/auth.ts
 *
 * OAuth authentication, token refresh, and GCP project discovery for Antigravity.
 * Delegates to OMP's shipped Google Antigravity client credentials unless custom
 * ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET env vars are explicitly configured.
 */

import * as http from "http";
import * as crypto from "crypto";
import { exec } from "child_process";
import {
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_SCOPES,
  CALLBACK_PATH,
  CALLBACK_PORT,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  FALLBACK_PROJECT_ID,
  OAUTH_AUTH_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  REDIRECT_URI,
} from "./constants";
import { buildHubUserAgent } from "./manifest";
import { getBuiltinAntigravityClientCredentials } from "./omp-builtin";

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
  signal?: AbortSignal;
}

export function getEffectiveClientId(): string {
  return process.env.ANTIGRAVITY_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

export function getEffectiveClientSecret(): string {
  return process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() || DEFAULT_CLIENT_SECRET;
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
  let resolved = false;

  const cleanupAbort = () => {
    if (!resolved) {
      resolved = true;
      try {
        server.close();
      } catch {}
      reject(new Error("Antigravity login cancelled."));
    }
  };

  if (callbacks.signal?.aborted) {
    throw new Error("Antigravity login cancelled.");
  }
  callbacks.signal?.addEventListener("abort", cleanupAbort, { once: true });

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      const error = reqUrl.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h3>Authentication Failed</h3><p>${error}</p>`);
        if (!resolved) {
          resolved = true;
          server.close();
          reject(new Error(`OAuth error: ${error}`));
        }
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h3>Invalid Callback</h3><p>State mismatch or missing authorization code.</p>");
        if (!resolved) {
          resolved = true;
          server.close();
          reject(new Error("OAuth state verification failed."));
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h3>Success!</h3><p>Antigravity authentication successful. You can close this window.</p>");

      server.close();
      if (resolved) return;
      resolved = true;
      callbacks.signal?.removeEventListener("abort", cleanupAbort);

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

      // Fetch User Email
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

      // Discover GCP Project ID
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
      if (!resolved) {
        resolved = true;
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  server.listen(CALLBACK_PORT, "127.0.0.1", () => {
    const urlStr = authUrl.toString();
    callbacks.onAuth?.({
      url: urlStr,
      instructions: "Complete the sign-in in your browser.",
    });
    callbacks.onProgress?.(`Opening browser for Antigravity sign-in: ${urlStr}`);
    if (!callbacks.onAuth) {
      openBrowser(urlStr);
    }
  });

  server.on("error", (err) => {
    if (!resolved) {
      resolved = true;
      reject(new Error(`Failed to bind callback server on port ${CALLBACK_PORT}: ${err.message}`));
    }
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

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "win32") {
    exec(`start "" "${url}"`);
  } else if (platform === "darwin") {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}
