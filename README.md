# pi-antigravity-stealth

[![npm version](https://img.shields.io/npm/v/pi-antigravity-stealth.svg?color=blue)](https://www.npmjs.com/package/pi-antigravity-stealth)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![GitHub Release](https://img.shields.io/github/v/release/trefeon/pi-antigravity-stealth)](https://github.com/trefeon/pi-antigravity-stealth/releases)
[![Upstream Watcher](https://github.com/trefeon/pi-antigravity-stealth/actions/workflows/upstream-watch.yml/badge.svg)](https://github.com/trefeon/pi-antigravity-stealth/actions/workflows/upstream-watch.yml)

> Native Oh My Pi (OMP) and Pi Coding Agent extension providing stealth unpause for Google Antigravity, 1:1 Hub client spoofing, and automatic saved credential recovery.

---

## What is pi-antigravity-stealth?

In OMP **v18.18.4** ([PR #18622](https://github.com/can1357/oh-my-pi/pull/18622), commit `8895c0fa328`), upstream maintainers paused the built-in `google-antigravity` provider in response to Google issuing account restrictions on third-party clients with unverified signatures.

`pi-antigravity-stealth` is a standalone, update-safe plugin for OMP and Pi that:

1. **Unpauses `google-antigravity` Natively**: Uses OMP's built-in `registerProvider` escape hatch (`customOAuthProviders`) to unpause all 13 Antigravity models without editing files in `node_modules` or breaking on `omp update`.
2. **1:1 Antigravity Hub Spoofing**: Dynamically queries Google's production update manifest (`2.30.0`, CL `6386428939206656`) and sends strictly legitimate Hub request signatures with zero leaked telemetry headers.
3. **Automatic Credential Recovery**: Discovers existing saved OAuth accounts from `agent.db` (`~/.omp/agent/agent.db` and `~/.pi/agent/agent.db`) and unpauses them so you do not have to log in again.
4. **Custom Client ID Support**: Allows isolating your Google account with private OAuth client credentials (`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`) to avoid shared-pool bans.
5. **Continuous Upstream Automation**: Scheduled GitHub Actions monitor Google Hub manifests, CLI binaries, and upstream OMP KDL rules daily.

---

## Installation Guide

### For Oh My Pi (OMP)

Run the plugin install command directly:

```bash
omp plugin install pi-antigravity-stealth
```

Verify that the plugin is loaded and all 13 models are unlocked:

```bash
omp plugin list
omp models google-antigravity
```

### For Pi Coding Agent

Install via the Pi CLI:

```bash
pi plugin install pi-antigravity-stealth
```

Alternatively, load it directly via extension flag:

```bash
pi --extension pi-antigravity-stealth
```

### Local Development / Linking

If you cloned this repository locally:

```bash
git clone https://github.com/trefeon/pi-antigravity-stealth.git
cd pi-antigravity-stealth

# Link to OMP
omp plugin link .

# Or link to Pi
pi plugin link .
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

---

## Available Models (13 Active Models)

Once installed, all built-in Antigravity models are accessible:

| Model ID | Context Window | Max Output | Thinking Support | Multimodal (Images) |
|---|---|---|---|---|
| `google-antigravity/claude-opus-5-5` | 1,000,000 | 128,000 | low, medium, high | Yes |
| `google-antigravity/claude-opus-4-6` | 250,000 | 64,000 | minimal, low, medium, high | Yes |
| `google-antigravity/claude-sonnet-5-5` | 1,000,000 | 128,000 | low, medium, high | Yes |
| `google-antigravity/claude-sonnet-4-6` | 250,000 | 64,000 | minimal, low, medium, high | Yes |
| `google-antigravity/gemini-4-argon` | 1,000,000 | 65,536 | low, medium, high | Yes |
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

Run `/agy` inside your OMP or Pi session:

| Command | Action |
|---|---|
| `/agy status` | Shows connection endpoint, live Hub version, CL, and active account count |
| `/agy accounts` | Lists all saved Antigravity accounts in `agent.db` with masked emails |
| `/agy restore` | Clears disabled flags on existing accounts and re-activates them in the session pool |
| `/agy login` | Starts an interactive PKCE browser sign-in for a new Google account |
| `/agy manifest` | Forces an immediate refresh check against Google's live update manifest |

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
User-Agent: antigravity/hub/2.30.0 (aidev_client; os_type=windows; arch=amd64; cl=6386428939206656)
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
│   ├── index.ts                        # Extension factory and provider registration
│   ├── auth.ts                         # PKCE OAuth flow, token refresh and project discovery
│   ├── manifest.ts                     # Live Google Hub manifest version synchronizer
│   ├── accounts.ts                     # agent.db credential discovery and recovery
│   └── constants.ts                    # Endpoints, scopes, and baseline fallbacks
├── docs/
│   ├── ARCHITECTURE.md                 # Antigravity integration map across OMP packages
│   ├── UPSTREAM_DISABLE_ANALYSIS.md    # PR #18622 autopsy and why config overrides fail
│   ├── IMPLEMENTATION_STRATEGIES.md    # Tradeoffs: plugin vs patch vs fork vs bridge
│   └── LEGIT_ANTIGRAVITY_SIGNATURE.md  # Official wire protocol, headers and reverse engineering
├── scripts/
│   ├── check-upstream-drift.ts         # Automated upstream drift monitor
│   ├── antigravity-stealth-launcher.ts # Manifest-synced wrapper launcher
│   ├── antigravity-unpause-extension.ts # Zero-fork extension hook
│   ├── patch-omp.ts                    # Standalone Zstd rules bundle patcher
│   ├── agy-omp.cmd                     # Windows Command Prompt launcher
│   ├── agy-omp.ps1                     # PowerShell launcher
│   └── agy-omp.sh                      # Shell launcher
└── tests/
    └── plugin.test.ts                  # Unit test suite
```

---

## Links & Ecosystem

- **npm Package:** [https://www.npmjs.com/package/pi-antigravity-stealth](https://www.npmjs.com/package/pi-antigravity-stealth)
- **GitHub Repository:** [https://github.com/trefeon/pi-antigravity-stealth](https://github.com/trefeon/pi-antigravity-stealth)
- **GitHub Releases:** [https://github.com/trefeon/pi-antigravity-stealth/releases](https://github.com/trefeon/pi-antigravity-stealth/releases)
- **Oh My Pi (OMP):** [https://github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
- **Google Antigravity:** [https://antigravity.google](https://antigravity.google)

---

## License

MIT (c) 2026 [trefeon](https://github.com/trefeon)
