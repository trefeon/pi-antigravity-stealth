# OMP Antigravity Architecture Deep Dive

This document maps the complete technical implementation of `google-antigravity` within Oh My Pi (OMP), based on code audit of `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-ai`, and `@oh-my-pi/pi-coding-agent`.

---

## 1. Monorepo Distribution

Antigravity support is divided across three layers:

```
┌────────────────────────────────────────────────────────┐
│              @oh-my-pi/pi-coding-agent                 │
│  - Session orchestrator, CLI dispatcher, TUI           │
│  - Storage: ~/.omp/agent/agent.db (SQLite)             │
│  - Runtime Rules Bundle: dist/rules.json-*.zst         │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│                    @oh-my-pi/pi-ai                     │
│  - Provider OAuth registry (registerOAuthProvider)     │
│  - Request stream dispatch (streamDispatch)            │
│  - Error guards (ProviderDisabledError, MissingApiKey) │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│                  @oh-my-pi/pi-catalog                  │
│  - Model taxonomy, variant collapse families           │
│  - KDL rules: rules/auth/google-antigravity.kdl        │
│  - Provider wire descriptor: rules/providers/...       │
└────────────────────────────────────────────────────────┘
```

---

## 2. Authentication & Credential Storage

### OAuth Specification (`rules/auth/google-antigravity.kdl`)
* **Authorize URL**: `https://accounts.google.com/o/oauth2/v2/auth`
* **Token URL**: `https://oauth2.googleapis.com/token`
* **Callback**: Loopback HTTP server on `http://127.0.0.1:51121/oauth-callback`
* **Scopes**:
  - `https://www.googleapis.com/auth/cloud-platform`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/userinfo.profile`
  - `https://www.googleapis.com/auth/cclog`
  - `https://www.googleapis.com/auth/experimentsandconfigs`
  - `https://www.googleapis.com/auth/aicode`
* **Client Credentials**: Base64-obfuscated public Google OAuth client ID/secret.
* **Exchange & Refresh Hooks**:
  - `google-antigravity-project`: Invokes Google Cloud Resource Manager API to discover the linked GCP project ID (`projectId`). Without a resolved `projectId`, Cloud Code Assist API requests reject with `400/403`.

### Persistence in `~/.omp/agent/agent.db`
Credentials live in SQLite table `auth_credentials`:
```sql
CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,          -- 'google-antigravity'
    credential_type TEXT NOT NULL,   -- 'oauth'
    identity_key TEXT,               -- 'email:user@domain.com'
    data TEXT NOT NULL,              -- JSON { access_token, refresh_token, expires_at, projectId }
    disabled_cause TEXT              -- NULL for active, 'deleted by user' when removed
);
```

---

## 3. Wire Protocol & Upstream Endpoints

### Base URLs
* **Production**: `https://daily-cloudcode-pa.googleapis.com`
* **Sandbox**: `https://daily-cloudcode-pa.sandbox.googleapis.com`
Configurable via OMP setting `providers.antigravityEndpoint` (`auto` | `production` | `sandbox`).

### Request Headers & Fingerprinting
* `User-Agent`: `antigravity/hub/<version>` (e.g. `antigravity/hub/2.1.4`)
* `x-goog-api-client`: Identifies client transport.
* `Authorization`: `Bearer <access_token>`
* GCP project header targeting the discovered `projectId`.

### Claude on Google Envelope
Cloud Code Assist exposes Claude models (`claude-sonnet-5-5`, `claude-opus-4-6`, etc.) wrapped in Google's Protobuf/JSON schema:
* `supports-function-part-id`: `#true`
* `cca-legacy-parameters-schema`: `#true`
* `antigravity-claude-tool-mode`: `#true`
* `drop-unsigned-thinking`: `#true`

---

## 4. Model Catalog & Variant Collapse

Antigravity exposes specialized wire SKUs (e.g. `-low`, `-medium`, `-high`, `-tiered`). OMP collapses these into unified user-facing model identifiers using KDL collapse rules:

| User Model ID | Thinking Route | Target Wire IDs |
|---|---|---|
| `gemini-3.8-flash` | minimal / low / medium / high | `gemini-3.8-flash-low`, `medium`, `high`, `tiered` |
| `gemini-4-argon` | low / medium / high | `gemini-4-argon-low`, `medium`, `high` |
| `claude-sonnet-5-5` | low / medium / high | `claude-sonnet-5-5-low`, `medium`, `high` |
| `claude-opus-4-6` | budget (minimal to high) | `claude-opus-4-6-thinking`, `claude-opus-4-6` |
| `gpt-oss-120b` | budget | `gpt-oss-120b-medium` |

---

## 5. Usage & Quota Tracking

Antigravity quotas are polled from Cloud Code Assist quota endpoints and structured into:
1. **Gemini Weekly Bucket**: Resets on a 7-day rolling window.
2. **Gemini 5-Hour Burst**: Rolling window for burst concurrency.
3. **Claude & GPT Shared Weekly**: Separate quota bucket governing non-Gemini models.
4. **Gemini 4 Argon Weekly**: Dedicated weekly bucket on supported accounts.
Probed and visualized via `omp usage`.
