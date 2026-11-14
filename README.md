# pi-antigravity-stealth

[![GitHub Release](https://img.shields.io/github/v/release/trefeon/pi-antigravity-stealth)](https://github.com/trefeon/pi-antigravity-stealth/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/trefeon/pi-antigravity-stealth/actions/workflows/ci.yml/badge.svg)](https://github.com/trefeon/pi-antigravity-stealth/actions/workflows/ci.yml)
[![Upstream Watcher](https://github.com/trefeon/pi-antigravity-stealth/actions/workflows/upstream-watch.yml/badge.svg)](https://github.com/trefeon/pi-antigravity-stealth/actions/workflows/upstream-watch.yml)

> Native Oh My Pi (OMP) and Pi Coding Agent extension providing stealth Google Antigravity Hub header spoofing, Argon quota isolation, automatic OMP upgrade patching, and saved credential recovery.

---

## What is pi-antigravity-stealth?

In OMP **v18.18.4** ([PR #18622](https://github.com/can1357/oh-my-pi/pull/18622), commit `8895c0fa328`), upstream maintainers paused the built-in `google-antigravity` provider; in **v18.18.7** (`e3fde96`), upstream replaced the hard pause with a `login-warning` prompt while still leaving `gemini-argon-*` merged into the `google` quota counter and keeping a `2.26.0` / `cl=1005016104` fallback.

`pi-antigravity-stealth` is a standalone, update-safe extension plugin for **Oh My Pi (OMP)** (with `/agy` management commands, bundled skill, and updater also working cleanly on **Pi Coding Agent**):

1. **Unpauses & Delegates to Built-in Antigravity**: Uses OMP's built-in `registerProvider` escape hatch (`customOAuthProviders`) on paused versions (`18.18.4`–`18.18.6`) and delegates OAuth, token refresh, endpoint auto-failover, and wire transport to OMP's shipped `google-antigravity` implementation.
2. **Argon Quota Counter Isolation & Auto-Patching**: Overrides runtime usage parsing (`src/usage.ts`) so exhausted Gemini 4 Argon weekly buckets (`gemini-argon-*`) stay in their own `argon` counter instead of blocking healthy Gemini (`google`) quota across Pro accounts, and automatically re-applies `cli.js` / `rules.json-*.zst` patches (`src/omp-patch.ts`) whenever `omp update` replaces OMP's bundle.
3. **1:1 Antigravity Hub Spoofing**: Dynamically queries Google's production update manifest (`2.32.1`, CL `6001966350991360`) and keeps `PI_AI_ANTIGRAVITY_*` aligned with official Hub signatures.
4. **Automatic Credential Recovery**: Discovers existing saved OAuth accounts from `agent.db` (`~/.omp/agent/agent.db` and `~/.pi/agent/agent.db`) and restores them via `/agy restore`.
5. **Custom Client ID Support**: Allows isolating your Google account with private OAuth client credentials (`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` via environment, `.env`, or `~/.omp/antigravity.env`), falling back cleanly to OMP's shipped client config when unset.
6. **GitHub Release Auto-Updater**: Checks GitHub Releases on interactive session start (every 6 hours, zero API quota) and upgrades script/git installs in place without npm; `/agy update` checks and upgrades immediately.
7. **Interactive Command Snippets & Quota Diagnostics**: Registers `/agy` argument completions (`getArgumentCompletions`) with per-subcommand descriptions and account ID suggestions, plus `/agy usage`, `/agy patch`, `/agy doctor`, headless `--paste` OAuth login, and a bundled agent skill (`skills/antigravity-stealth`).
8. **Continuous Upstream Automation**: Scheduled GitHub Actions monitor Google Hub manifests, CLI binaries, upstream OMP KDL rules, and `@oh-my-pi/pi-coding-agent` npm releases daily, auto-syncing baselines, verifying tests/patch regexes, and cutting verified patch releases when safe.
> **Host Compatibility Note:** On **OMP** (`@oh-my-pi/pi-coding-agent`), all 14 built-in `google-antigravity` models and streaming transport are unlocked out of the box. On **Pi Coding Agent** (`pi`), the extension, `/agy` commands, bundled skill, and updater load cleanly on Node `>=22.5`, while Antigravity model inference still requires OMP (since `@earendil-works/pi-ai` does not ship Cloud Code Assist wire transport natively).

---

## Installation Guide (No npm Required)

### Recommended: One-Line Script Install (Linux, macOS & Windows)

The installer downloads the latest [GitHub Release](https://github.com/trefeon/pi-antigravity-stealth/releases) into `~/.pi-antigravity-stealth` (`%USERPROFILE%\.pi-antigravity-stealth` on Windows), cleans up any legacy npm install if present, links into **OMP** (`omp plugin link`) and/or **Pi** (`pi install`), and enables automatic GitHub Release updates.

**Linux / macOS (bash):**

```bash
curl -fsSL https://raw.githubusercontent.com/trefeon/pi-antigravity-stealth/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/trefeon/pi-antigravity-stealth/main/scripts/install.ps1 | iex
```

Verify that the plugin is loaded and all 14 models are unlocked:

```bash
omp plugin list
omp models google-antigravity
```

**Pin a specific release or uninstall:**

```bash
# Linux / macOS — specific version
curl -fsSL https://raw.githubusercontent.com/trefeon/pi-antigravity-stealth/main/scripts/install.sh | bash -s -- --version v1.2.1

# Linux / macOS — uninstall (preserves agent.db accounts)
bash ~/.pi-antigravity-stealth/scripts/install.sh --uninstall
```

```powershell
# Windows — specific version
$env:PI_ANTIGRAVITY_VERSION = "v1.2.1"; irm https://raw.githubusercontent.com/trefeon/pi-antigravity-stealth/main/scripts/install.ps1 | iex

# Windows — uninstall (preserves agent.db accounts)
& "$env:USERPROFILE\.pi-antigravity-stealth\scripts\install.ps1" -Uninstall
```

### Alternative: Direct Git Install or Local Checkout

Install directly from GitHub without npm:

```bash
# OMP
omp plugin install github:trefeon/pi-antigravity-stealth

# Pi Coding Agent
pi install git:github.com/trefeon/pi-antigravity-stealth
```

Or link a local clone:

```bash
git clone https://github.com/trefeon/pi-antigravity-stealth.git
cd pi-antigravity-stealth

# Link to OMP
omp plugin link .

# Or install into Pi
pi install .
```

---

## Quick Start & Account Setup

### 1. Recovering Existing Stored Accounts

If you previously logged in to Antigravity on OMP or Pi before the upstream pause, your credentials still exist safely inside `agent.db`.

In your OMP or Pi chat session:

```text
/agy accounts
```

This lists all saved accounts found in `agent.db` (with masked emails for privacy).

To ensure all stored accounts are marked active:

```text
/agy restore
```

### 2. Logging in to a New Google Account

To authenticate a new Google account with PKCE browser login and stealth headers:

```text
/agy login
```

This opens your browser to Google's official OAuth authorization page and saves the tokens to your local credential store.

### 3. Optional: Private OAuth Client Isolation

To avoid using public shared OAuth client IDs, you can configure your own Google Cloud OAuth Client ID and Secret in your environment or in `.env` / `~/.omp/antigravity.env`:

```bash
export ANTIGRAVITY_CLIENT_ID="your-client-id.apps.googleusercontent.com"
export ANTIGRAVITY_CLIENT_SECRET="your-client-secret"
```

The plugin automatically detects these variables and uses them for all token exchanges and refreshes.

### 4. Multi-Account Pooling & Automatic Rotation

OMP natively pools all active Antigravity accounts stored in `agent.db`. When you authenticate multiple Google accounts:
- **Automatic Failover & Rotation**: OMP monitors rolling 5-hour and 7-day quota exhaustion per account. When an active account hits its limit (100% used), OMP automatically rotates to the next available account in the pool.
- **Account Inventory**: Run `/agy accounts` to view all saved accounts with masked emails.
- **Tier Verification**: Run `/agy tier <id>` to check subscription levels (**Google AI Ultra**, **Google AI Pro**, **Google AI Plus**, **Free Tier**).
- **Pool Quota Inspection**: Run `omp usage` from your terminal at any time to monitor capacity and reset countdowns across your entire account pool.

### 5. Automatic Updates (GitHub Releases)

Script-installed copies (`~/.pi-antigravity-stealth`) check `github.com/trefeon/pi-antigravity-stealth/releases/latest` in the background once every 6 hours on interactive session start (via HTTP redirect, with zero GitHub API quota or npm usage).

- **Auto-update**: Downloads the matching GitHub Release archive (`.tar.gz` on Linux/macOS, `.zip` on Windows), verifies `package.json`, replaces files in place, and notifies you to restart OMP/Pi.
- **Manual trigger**: Run `/agy update` anytime inside OMP/Pi to check and apply updates immediately.
- **Disable checks**: Set `PI_ANTIGRAVITY_SKIP_UPDATE_CHECK=1`.
- **Source checkouts**: Clones containing `.git` are detected as `git` and are never overwritten automatically.

---

## Available Models (14 Active Models)
Once installed, all built-in Antigravity models are accessible:

| Model ID | Context Window | Max Output | Thinking Support | Multimodal (Images) |
|---|---|---|---|---|
| `google-antigravity/claude-opus-5-5` | 1,000,000 | 128,000 | low, medium, high | Yes |
| `google-antigravity/claude-opus-4-6` | 250,000 | 64,000 | minimal, low, medium, high | Yes |
| `google-antigravity/claude-sonnet-5-5` | 1,000,000 | 128,000 | low, medium, high | Yes |
| `google-antigravity/claude-sonnet-4-6` | 250,000 | 64,000 | minimal, low, medium, high | Yes |
| `google-antigravity/gemini-4-argon` | 1,000,000 | 65,536 | low, medium, high | Yes |
| `google-antigravity/gemini-4-hydrogen` | 1,000,000 | 262,144 | low, medium, high, xhigh | Yes |
| `google-antigravity/gemini-3.8-flash` | 1,000,000 | 65,536 | minimal, low, medium, high | Yes |
| `google-antigravity/gemini-3.5-flash-lite` | 1,000,000 | 65,536 | minimal, low, medium, high | Yes |
| `google-antigravity/gemini-3.1-flash-lite` | 1,000,000 | 65,536 | minimal, low, medium, high | Yes |
| `google-antigravity/gemini-2.5-flash` | 1,000,000 | 65,536 | minimal, low, medium, high | Yes |
| `google-antigravity/gemini-2.5-flash-lite` | 1,000,000 | 65,536 | minimal, low, medium, high | Yes |
| `google-antigravity/gpt-oss-120b` | 131,072 | 32,768 | minimal, low, medium, high | No |
| `google-antigravity/tab_flash_lite_preview` | 16,384 | 4,096 | None | No |
| `google-antigravity/tab_jump_flash_lite_preview` | 16,384 | 4,096 | None | No |

---

## Slash Commands Reference

Type `/agy ` inside OMP or Pi to open interactive subcommand snippets and account ID completions:

| Command | Action |
|---|---|
| `/agy status` | Shows plugin version, install kind, endpoint, live Hub version/CL, and active account count |
| `/agy accounts` | Lists all saved Antigravity accounts in `agent.db` with IDs and masked emails |
| `/agy usage [email\|id]` | Shows live quota % remaining and reset countdowns grouped by Gemini, Argon, and Claude+GPT |
| `/agy tier [email\|id]` | Probes live Google subscription tier (**Free**, **Google AI Plus**, **Google AI Pro**, **Google AI Ultra**) plus per-account `gemini-4-hydrogen` entitlement (Pro/Ultra only) |
| `/agy login [--paste]` | Starts PKCE OAuth login (pass `--paste` on headless SSH servers to paste the callback URL) |
| `/agy remove <email\|id>` | Deactivates an account (`disabled_cause = 'deleted by user'`; use `--hard` for permanent deletion) |
| `/agy restore` | Clears disabled flags on existing accounts and re-activates them in the session pool |
| `/agy manifest` | Forces an immediate refresh check against Google's live update manifest |
| `/agy patch` | Re-applies Argon quota isolation & capacity meter patches to local OMP install |
| `/agy doctor` | Prints sanitized host runtime, `omp-builtin`, `omp-patch`, `agent.db`, Hub UA, and updater diagnostics |
| `/agy update` | Checks GitHub Releases, updates script/git installs in place, and verifies OMP patches |

---

## Stealth Wire Signature & Anti-Ban Architecture

Official Google Antigravity Hub requests terminate at Google Cloud Code Assist gateways (`daily-cloudcode-pa.googleapis.com`).

The plugin enforces exact parity with official client traffic:

```http
POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: text/event-stream
Accept-Encoding: gzip
User-Agent: antigravity/hub/2.32.1 (aidev_client; os_type=windows; arch=amd64; cl=6001966350991360)
```

**Anti-Ban Rules Enforced:**
1. **Header Sanitization:** Omits `X-Goog-Api-Client` and `Client-Metadata` on content streams. Real Antigravity Hub requests send only `User-Agent`.
2. **Dynamic Manifest Synchronization:** Automatically queries `https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml` so outgoing version strings always match Google's active releases.
3. **Claude Thinking Headers:** Stamps `anthropic-beta: interleaved-thinking-2025-05-14` on Claude models with thinking enabled.

For deeper technical analysis, read [`docs/LEGIT_ANTIGRAVITY_SIGNATURE.md`](docs/LEGIT_ANTIGRAVITY_SIGNATURE.md).

---

## Directory Structure

```text
pi-antigravity-stealth/
├── package.json                        # Plugin manifest (dual "omp" and "pi" bindings)
├── index.ts                            # Root extension export
├── src/
│   ├── index.ts                        # Extension factory, built-in delegation, auto-patch, updater & /agy commands
│   ├── omp-builtin.ts                  # Runtime resolver for OMP's built-in OAuth/usage/rules
│   ├── omp-patch.ts                    # Race-safe, stat-cached OMP bundle patcher (survives omp update)
│   ├── usage.ts                        # UsageProvider wrapper isolating Argon from google counter
│   ├── updater.ts                      # GitHub Release auto-updater (no npm required)
│   ├── auth.ts                         # PKCE OAuth flow, token refresh, and project discovery
│   ├── manifest.ts                     # Live Google Hub manifest version synchronizer
│   ├── accounts.ts                     # agent.db credential discovery and recovery
│   └── constants.ts                    # Endpoints, scopes, and baseline fallbacks
├── docs/
│   ├── ARCHITECTURE.md                 # Antigravity integration map across OMP packages
│   ├── UPSTREAM_DISABLE_ANALYSIS.md    # PR #18622 autopsy and why config overrides fail
│   ├── IMPLEMENTATION_STRATEGIES.md    # Tradeoffs: plugin vs patch vs fork vs bridge
│   └── LEGIT_ANTIGRAVITY_SIGNATURE.md  # Official wire protocol, headers and reverse engineering
├── scripts/
│   ├── install.sh                      # Linux/macOS GitHub Release installer (no npm)
│   ├── install.ps1                     # Windows PowerShell GitHub Release installer (no npm)
│   ├── check-upstream-drift.ts         # Automated upstream drift monitor
│   ├── antigravity-stealth-launcher.ts # Manifest-synced wrapper launcher
│   ├── antigravity-unpause-extension.ts # Zero-fork extension hook
│   ├── patch-omp.ts                    # Standalone Zstd rules bundle patcher
│   ├── agy-omp.cmd                     # Windows Command Prompt launcher
│   ├── agy-omp.ps1                     # PowerShell launcher
│   └── agy-omp.sh                      # Shell launcher
├── skills/
│   └── antigravity-stealth/
│       └── SKILL.md                    # Bundled agent skill for /agy troubleshooting & SSH login
└── tests/
    └── plugin.test.ts                  # Unit test suite
```

---

## Links & Ecosystem

- **GitHub Repository:** [https://github.com/trefeon/pi-antigravity-stealth](https://github.com/trefeon/pi-antigravity-stealth)
- **GitHub Releases:** [https://github.com/trefeon/pi-antigravity-stealth/releases](https://github.com/trefeon/pi-antigravity-stealth/releases)
- **Oh My Pi (OMP):** [https://github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
- **Google Antigravity:** [https://antigravity.google](https://antigravity.google)

---

## License

MIT (c) 2026 [trefeon](https://github.com/trefeon)
