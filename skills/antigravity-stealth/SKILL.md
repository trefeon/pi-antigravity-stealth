---
name: antigravity-stealth
description: Diagnose and manage Google Antigravity OAuth, Argon quota isolation, account tiers, headless SSH login, and GitHub Release updates in OMP and Pi.
---

# Google Antigravity Stealth Operations

Use this skill when managing or troubleshooting the `google-antigravity` provider with `pi-antigravity-stealth`.

## Slash Commands (`/agy`)

- `/agy status` — Active plugin version, install kind, Hub User-Agent/CL, OAuth mode, and account count.
- `/agy accounts` — List saved accounts in `agent.db` with IDs, masked emails, project IDs, and expiration/disabled state.
- `/agy check [--no-quarantine]` — Probe live inference health across saved accounts and automatically quarantine accounts banned with 403 Terms of Service violations.
- `/agy usage [email|id]` — Query live quota percentages and reset windows grouped by **Gemini**, **Gemini 4 Argon**, and **Claude & GPT (shared)**.
- `/agy tier [email|id]` — Probe subscription tier (`Free Tier`, `Google AI Plus`, `Google AI Pro`, `Google AI Ultra`).
- `/agy doctor` — Print sanitized host, runtime, `omp-builtin`, `agent.db`, Hub manifest, and updater diagnostics.
- `/agy login [--paste]` — Authenticate a Google account via browser PKCE or paste the callback URL on headless SSH hosts.
- `/agy remove <email|id> [--hard]` / `/agy restore` — Soft-disable, delete, or re-activate accounts in `agent.db`.
- `/agy manifest` — Refresh live Google Hub version and changelist.
- `/agy patch` — Re-apply Argon quota isolation and capacity meter patches to the local OMP install.
- `/agy update` — Check GitHub Releases (no npm, zero API quota), self-update script/git installs in place, and verify OMP patches.

## Common Issues & Fixes

1. **Headless / SSH Login (`127.0.0.1:51121`):**
   - Forward the callback port when connecting over SSH: `ssh -L 51121:127.0.0.1:51121 <host>`, or run `/agy login --paste` and paste the redirected `http://127.0.0.1:51121/oauth-callback?code=...` URL from your local browser.
2. **Standalone Binary / Missing Built-in Client Credentials:**
   - Compiled single-file `omp` binaries do not expose `@oh-my-pi/pi-ai` on disk. Set `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` (or place them in `~/.omp/antigravity.env`) before running `/agy login`.
3. **Argon Exhaustion Blocking Other Gemini Models:**
   - The plugin separates `gemini-argon-*` buckets into the `argon` counter at runtime so `gemini-4-argon` depletion never blocks `gemini-3.8-flash`, `gemini-4-hydrogen`, or `gemini-3.1-pro`.
   - On Bun global OMP installs, the plugin auto-patches `cli.js` and `rules.json-*.zst` via `src/omp-patch.ts` after `omp update` (or manually via `/agy patch` / `bun run patch`) to isolate Argon in `quotaTiers`, split `omp usage` capacity meters, and keep strict `accountAccess` enabled for Pro-only models (e.g. `claude-sonnet-5-5`). Set `PI_ANTIGRAVITY_SKIP_AUTO_PATCH=1` to opt out.
4. **Updater Control:**
   - Set `PI_ANTIGRAVITY_SKIP_UPDATE_CHECK=1` to disable automatic 6-hour GitHub Release checks.
   - Developer checkouts containing `.git` are never overwritten automatically.
5. **403 Terms of Service Violation ("This service has been disabled in this account"):**
   - Occurs when an account is banned/restricted by Google enforcement for Cloud Code Assist. Metadata endpoints (`loadCodeAssist`) may still return 200 while inference (`streamGenerateContent`) fails with 403.
   - Run `/agy check` to test inference health across all saved accounts and auto-quarantine banned accounts with `disabled_cause = '403: Terms of Service violation'`.
   - Quarantining the banned account prevents OMP from selecting it and crashing during requests or model fallback (e.g. `gemini-4-hydrogen` -> `gemini-3.8-flash`).
   - Pro/Ultra-only models like `gemini-4-hydrogen` require at least one active Google AI Pro/Ultra account; if all remaining active accounts are Free/Plus, requests fall back to available models.
