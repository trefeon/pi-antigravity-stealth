# Implementation Strategies & Tradeoffs

To maintain and safely use Google Antigravity on OMP, four distinct architectural paths exist:

---

## Comparison Matrix

| Dimension | Strategy 1: Native Extension | Strategy 2: Binary/Zstd Patcher | Strategy 3: Upstream Fork | Strategy 4: Standalone Proxy |
|---|---|---|---|---|
| **Maintenance** | Low (Zero edits to node_modules) | Very Low (1-command post-update) | High (Syncing upstream commits) | Medium (Independent process) |
| **Update Survival** | Survives OMP updates | Must re-run after `omp update` | Requires custom build/install | Survives OMP updates |
| **ToS Evasion / Stealth** | None (Default OMP headers) | None (Default OMP headers) | High (Custom headers/UA/Client IDs) | High (Arbitrary header control) |
| **Complexity** | 1 TS file in `~/.omp/agent/extensions/` | 1 Bun script | Full monorepo fork | Standalone Go/TS daemon |

---

## Detailed Breakdown

### Strategy 1: The Native Extension Escape Hatch (Zero-Fork)

OMP's own codebase in `@oh-my-pi/pi-ai/src/registry/oauth/index.ts` lines 56–62 contains an intentional user-override mechanism:
```typescript
/**
 * Why `provider` is paused by its auth rules (`disabled "<reason>"`), or
 * undefined when it may be reached. An extension that registers its own OAuth
 * login under the paused id takes the id back: that is the end user's choice.
 */
export function providerPauseReason(provider: string): string | undefined {
    return customOAuthProviders.has(provider) ? undefined : providerDisabledReason(provider);
}
```

#### How it works:
When an extension placed in `~/.omp/agent/extensions/` executes `registerOAuthProvider` or registers a runtime provider with `id: "google-antigravity"`, `customOAuthProviders.has("google-antigravity")` evaluates to `true`.
This causes `providerPauseReason` to return `undefined`, immediately:
1. Enabling `AuthStorage` to load stored credentials from `agent.db`.
2. Unblocking model discovery.
3. Preventing `assertProviderEnabled` from throwing `ProviderDisabledError`.

#### Tradeoff:
* Pros: Completely survives `omp update` because user extensions in `~/.omp/agent/extensions/` are not overwritten during binary upgrades.
* Cons: Uses OMP's default request headers and OAuth client IDs, meaning Google's backend detection signals remain unchanged.

---

### Strategy 2: Automated Global Zstandard Patcher

The runtime bundle in `@oh-my-pi/pi-coding-agent/dist/rules.json-*.zst` can be patched in-place in ~50ms using Bun's native compression API.

#### How it works:
```typescript
import * as fs from "fs";
const compressed = fs.readFileSync(zstPath);
const data = JSON.parse(Bun.zstdDecompressSync(compressed).toString("utf8"));
const ag = data.auth.providers.find(p => p.id === "google-antigravity");
delete ag.disabled;
fs.writeFileSync(zstPath, Bun.zstdCompressSync(Buffer.from(JSON.stringify(data))));
```

#### Tradeoff:
* Pros: Works instantly, 100% native execution, zero runtime extension overhead.
* Cons: Must be re-executed whenever `omp update` or `bun update -g` pulls down fresh package files.

---

### Strategy 3: Upstream Fork of `can1357/oh-my-pi`

Maintaining a private or public fork of the official repository (`packages/catalog`, `packages/ai`, `packages/coding-agent`).

#### Key Improvements to Implement in a Fork:
1. **Remove KDL Rule**: Delete `disabled "..."` in `rules/auth/google-antigravity.kdl`.
2. **Custom Client ID Support**: Allow configuring a personal Google Cloud OAuth client ID via environment variable (`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`) rather than sharing the default public client ID that Google flagged.
3. **Stealth Header Emulation**:
   - Randomize or align `User-Agent` with legitimate VS Code / Cloud Code extensions (e.g. `google.cloudcode/2.x`).
   - Add proper `x-goog-api-client` telemetry headers.
4. **Paced Token Refresh**: Avoid bursts of concurrent token refreshes across multi-account pools that trigger Google's abuse heuristics.

---

### Strategy 4: Local Stand-in Gateway Bridge

Decouple Antigravity from OMP core by writing a lightweight local proxy (similar to `pi-freeflow` or `Zed2Api`).

#### How it works:
1. Daemon runs on `127.0.0.1:<port>`.
2. Reads stored OAuth credentials from `~/.omp/agent/agent.db`.
3. Handles OAuth token refresh, Cloud Code Assist project discovery, and Google request framing.
4. Exposes standard OpenAI `/v1/chat/completions` or Anthropic `/v1/messages`.
5. Registered in `~/.omp/agent/models.yml` as a custom provider:
   ```yaml
   providers:
     antigravity-local:
       baseUrl: http://127.0.0.1:28190/v1
       api: openai-completions
       apiKey: local
       models: [...]
   ```
