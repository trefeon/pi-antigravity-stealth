---
name: antigravity-stealth
description: Diagnose and manage Google Antigravity OAuth, Argon quota isolation, account tiers, headless SSH login, and GitHub Release updates in OMP and Pi.
---

# Google Antigravity Stealth Operations

Use this skill when managing or troubleshooting the `google-antigravity` provider with `pi-antigravity-stealth`.

## Slash Commands (`/agy`)

- `/agy status` — Active plugin version, install kind, Hub User-Agent/CL, OAuth mode, and account count.
- `/agy accounts` — List saved accounts in `agent.db` with IDs, masked emails, project IDs, and expiration/disabled state.
- `/agy usage [email|id]` — Query live quota percentages and reset windows grouped by **Gemini**, **Gemini 4 Argon**, and **Claude & GPT (shared)**.
- `/agy tier [email|id]` — Probe subscription tier (`Free Tier`, `Google AI Plus`, `Google AI Pro`, `Google AI Ultra`).
- `/agy doctor` — Print sanitized host, runtime, `omp-builtin`, `agent.db`, Hub manifest, and updater diagnostics.
- `/agy login [--paste]` — Authenticate a Google account via browser PKCE or paste the callback URL on headless SSH hosts.
- `/agy remove <email|id> [--hard]` / `/agy restore` — Soft-disable, delete, or re-activate accounts in `agent.db`.
- `/agy manifest` — Refresh live Google Hub version and changelist.
- `/agy update` — Check GitHub Releases (no npm, zero API quota) and self-update script/git installs in place.

## Common Issues & Fixes

1. **Headless / SSH Login (`127.0.0.1:51121`):**
   - Forward the callback port when connecting over SSH: `ssh -L 51121:127.0.0.1:51121 <host>`, or run `/agy login --paste` and paste the redirected `http://127.0.0.1:51121/oauth-callback?code=...` URL from your local browser.
2. **Standalone Binary / Missing Built-in Client Credentials:**
   - Compiled single-file `omp` binaries do not expose `@oh-my-pi/pi-ai` on disk. Set `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` (or place them in `~/.omp/antigravity.env`) before running `/agy login`.
3. **Argon Exhaustion Blocking Other Gemini Models:**
   - The plugin separates `gemini-argon-*` buckets into the `argon` counter at runtime so `gemini-4-argon` depletion never blocks `gemini-3.8-flash` or `gemini-3.1-pro`.
   - For Bun global OMP installs, `bun run patch` (`scripts/patch-omp.ts`) also isolates Argon in `cli.js` and keeps strict `accountAccess` enabled for Pro-only models (e.g. `claude-sonnet-5-5`).
4. **Updater Control:**
   - Set `PI_ANTIGRAVITY_SKIP_UPDATE_CHECK=1` to disable automatic 6-hour GitHub Release checks.
   - Developer checkouts containing `.git` are never overwritten automatically.
