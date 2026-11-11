# Upstream Disable Analysis (PR #18622 Autopsy)

## 1. Context: Why Upstream Disabled Antigravity

In early November 2026, Google initiated an automated enforcement sweep on Cloud Code Assist (Antigravity) OAuth client usage:
* **Issue [#18341](https://github.com/can1357/oh-my-pi/issues/18341)**: Users reported receiving `403 PERMISSION_DENIED: This service has been disabled in this account for violation of Terms of Service. Error ID: ...`
* **Issue [#18499](https://github.com/can1357/oh-my-pi/issues/18499)**: Multiple users requested disabling Antigravity login out-of-the-box so new users wouldn't unintentionally burn their primary Google accounts.
* **PR [#18622](https://github.com/can1357/oh-my-pi/pull/18622)**: Authored by maintainer `H4vC`, reviewed by `roboomp`, merged into OMP `v18.18.4` (commit `8895c0fa328`).
* **OMP `v18.18.7` (`e3fde96`)**: Upstream later replaced the hard `disabled` flag with a `login-warning` risk prompt in `google-antigravity.kdl`; `pi-antigravity-stealth` continues to provide live Hub UA/CL alignment, private OAuth client ID support, runtime Argon quota isolation, and automatic `cli.js`/`rules.json` patching across upgrades.
---

## 2. Technical Mechanics of the Hard-Pause

### Step A: The KDL Grammar Addition
Upstream added a new `disabled "<reason>"` node in `packages/catalog/src/compat/rules/auth/google-antigravity.kdl`:

```kdl
auth "google-antigravity" {
	name "Google Antigravity (Gemini, Claude, GPT-OSS)"
	disabled "Google may restrict accounts that use Antigravity outside its own apps, so this provider is paused for now."
	login "oauth-code" { ... }
}
```

### Step B: Compilation into `rules.json`
`bun scripts/compile-compat.ts` compiles the KDL rules into a single JSON catalog schema:
```json
{
  "id": "google-antigravity",
  "name": "Google Antigravity (Gemini, Claude, GPT-OSS)",
  "disabled": "Google may restrict accounts that use Antigravity outside its own apps, so this provider is paused for now.",
  ...
}
```

### Step C: Zstandard Compression at Build Time
During package build, `@oh-my-pi/pi-coding-agent` serializes and compresses the entire ruleset using Zstandard into `dist/rules.json-p22aeenf.zst`.

At runtime in `cli.js`:
```javascript
var Sc;
var LQ = x(() => {
    Sc = JSON.parse(Bun.zstdDecompressSync(Rki.readFileSync(Eki.resolve(import.meta.dir, Aki))).toString("utf8"));
});
var y4n, jDi;
var nP = x(() => {
    LQ();
    y4n = Sc.auth.providers;
    jDi = Object.fromEntries(y4n.map(e => [e.id, e]));
});
```

### Step D: Execution-Path Blocking
The pause is enforced at three distinct interception points:

1. **Credential Pool Isolation**:
   ```javascript
   function iv(providerId) {
       return qme.has(providerId) ? void 0 : Fqt(providerId); // Fqt returns jDi[e]?.disabled
   }
   ```
   When `iv("google-antigravity")` returns a string, `AuthStorage` excludes all `google-antigravity` rows from `~/.omp/agent/agent.db`. The credentials remain in SQLite, but are never loaded into the active session pool.

2. **Model Discovery Suppression**:
   Without an active credential loaded in `AuthStorage`, `model-registry.ts`'s `#collectBuiltInModelManagerOptions` skips creating the model manager:
   ```typescript
   if (!isAuthenticated(key)) {
       continue; // google-antigravity is skipped
   }
   ```
   Result: `omp models` shows 0 models for Antigravity.

3. **Runtime Execution Block**:
   If a request attempts to bypass discovery via direct invocation or `config.yml` `modelRoles`, `assertProviderEnabled("google-antigravity")` checks `providerPauseReason` and throws:
   ```typescript
   throw new AIError.ProviderDisabledError(provider, reason);
   ```

---

## 3. Why Standard Configuration Overrides Failed

| User Method Attempted | Why It Fails |
|---|---|
| Remove from `disabledProviders` in `config.yml` | `disabledProviders` is an opt-out list. The `disabled` auth rule is evaluated in the core auth registry independent of user settings. |
| Add manual models to `models.yml` | A custom `models.yml` entry without a custom `baseUrl` delegates to the built-in provider, which triggers `assertProviderEnabled` and aborts. |
| Set `GOOGLE_APPLICATION_CREDENTIALS` or API keys | Antigravity uses Cloud Code Assist OAuth tokens with specific Google OAuth scopes and hooks, not standard Gemini API keys. |
| Re-running `omp login google-antigravity` | The login CLI checks `providerPauseReason` and outright refuses the flow. |

---

## 4. The Turnkey Solution: `pi-antigravity-stealth`

By registering an OAuth provider under `google-antigravity` via OMP's extension API, `customOAuthProviders.has("google-antigravity")` evaluates to `true`.

As designed by upstream:
```typescript
export function providerPauseReason(provider: string): string | undefined {
    return customOAuthProviders.has(provider) ? undefined : providerDisabledReason(provider);
}
```

This immediately:
1. Unlocks `providerPauseReason`, allowing OMP's session pool to load stored accounts from `agent.db`.
2. Re-enables model discovery for all 13 built-in Antigravity models.
3. Bypasses the login block without patching binary bundles.
4. Installs cleanly without npm via `scripts/install.sh` (Linux/macOS), `scripts/install.ps1` (Windows), or `omp plugin install github:trefeon/pi-antigravity-stealth`.
