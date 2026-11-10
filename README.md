# pi-antigravity-stealth

> Native Oh My Pi (OMP) & Pi extension providing stealth un-pause for Google Antigravity, 1:1 Hub client spoofing, and automatic saved credential recovery.

---

## Overview

In OMP **v18.18.4** ([PR #18622](https://github.com/can1357/oh-my-pi/pull/18622), commit `8895c0fa328`), upstream maintainers paused the built-in `google-antigravity` provider in response to Google issuing account restrictions on third-party clients with unverified signatures.

`pi-antigravity-stealth` is a standalone, update-safe plugin for OMP and Pi that:
1. **Unpauses `google-antigravity` Natively**: Uses OMP's built-in `registerProvider` escape hatch to unpause all 13 Antigravity models without editing files in `node_modules` or breaking on `omp update`.
2. **1:1 Antigravity Hub Spoofing**: Dynamically queries Google's production update manifest (`2.30.0`, CL `6386428939206656`) and sends strictly legitimate Hub request signatures with zero leaked telemetry headers.
3. **Automatic Credential Recovery**: Discovers existing saved OAuth accounts from `agent.db` (`~/.omp/agent/agent.db` and `~/.pi/agent/agent.db`) and un-pauses them so you don't have to log in again.
4. **Custom Client ID Support**: Allows isolating your Google account with private OAuth client credentials (`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`) to avoid shared-pool bans.

---

## Installation

### Method 1: Local Plugin Link (Instant)

Clone or navigate to the repository and link it to OMP:

```bash
omp plugin link .
```

Verify with:

```bash
omp plugin list
omp models google-antigravity
```

### Method 2: Global Extension Hook (Zero-Config)

Copy `scripts/antigravity-unpause-extension.ts` to your user extensions folder:

- **Windows**: `%USERPROFILE%\.omp\agent\extensions\pi-antigravity-stealth.ts`
- **Linux/macOS**: `~/.omp/agent/extensions/pi-antigravity-stealth.ts`

---

## Slash Commands

In your OMP or Pi interactive session, use the `/agy` command suite:

- `/agy status` — Inspect connection endpoint, simulated Hub version/CL, and active account count.
- `/agy accounts` — List saved Antigravity accounts found in `agent.db` with masked emails.
- `/agy restore` — Re-activate any previously disabled accounts in `agent.db`.
- `/agy login` — Authenticate a new Google account via PKCE browser flow.
- `/agy manifest` — Force a refresh check against Google's live Cloud Run update manifest.

---

## Directory Structure

```text
pi-antigravity-stealth/
├── package.json                        # Plugin manifest (dual "omp" and "pi" bindings)
├── index.ts                            # Root extension export
├── src/
│   ├── index.ts                        # Extension factory & provider registration
│   ├── auth.ts                         # PKCE OAuth flow, token refresh & project discovery
│   ├── manifest.ts                     # Live Google Hub manifest version synchronizer
│   ├── accounts.ts                     # agent.db credential discovery & recovery
│   └── constants.ts                    # Endpoints, scopes, and baseline fallbacks
├── docs/
│   ├── ARCHITECTURE.md                 # Antigravity integration map across OMP packages
│   ├── UPSTREAM_DISABLE_ANALYSIS.md    # PR #18622 autopsy and why config overrides fail
│   ├── IMPLEMENTATION_STRATEGIES.md    # Tradeoffs: plugin vs patch vs fork vs bridge
│   └── LEGIT_ANTIGRAVITY_SIGNATURE.md  # Official wire protocol, headers & reverse engineering
├── reference/                          # Harvested reference implementations & official binaries
└── scripts/
    ├── patch-omp.ts                    # Standalone Zstd rules bundle patcher
    ├── antigravity-stealth-launcher.ts # Manifest-synced wrapper launcher
    ├── agy-omp.cmd                     # Windows Command Prompt launcher
    ├── agy-omp.ps1                     # PowerShell launcher
    └── agy-omp.sh                      # Shell launcher
```

---

## License

MIT © [trefeon](https://github.com/trefeon)
