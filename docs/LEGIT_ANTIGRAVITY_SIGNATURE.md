# Reverse Engineering & Wire Protocol: Legitimate Google Antigravity Signatures

This document details the exact wire protocol, request structure, client headers, and telemetry behavior reverse-engineered from:
1. **Official Google Antigravity CLI (`agy`) v1.5.4** (stripped Go ELF/PE binaries).
2. **Official Google Antigravity VS Code Extension (`google.google-antigravity`) v1.11.0**.
3. **Reference Open-Source Implementations** (`cortexkit/antigravity-auth`, `NoeFabris/opencode-antigravity-auth`, `shekohex/opencode-google-antigravity-auth`).

---

## 1. Upstream Product Architecture

Google Antigravity operates across three primary surfaces:
- **Antigravity App / Hub**: Desktop Electron application built on Chromium / V8 (`resources/app.asar`).
- **Antigravity CLI (`agy`)**: High-performance Go binary compiled from `google3/third_party/jetski/language_server/code_assist_client`. It functions both as an interactive terminal coding agent and as a background Language Server / Hub (`agy --hub`).
- **Editor Extensions**: Thin wrappers for VS Code, Visual Studio, JetBrains, Zed, Xcode, and Eclipse that spawn local `agy --hub` backend instances over ephemeral loopback HTTP ports (`http://127.0.0.1:<port>`).

All client traffic terminates at Google Cloud Code Assist (CCPA) gateways:
- **Sandbox / Daily Host (Recommended for inference & quota)**: `https://daily-cloudcode-pa.googleapis.com` (or `https://daily-cloudcode-pa.sandbox.googleapis.com`)
- **Production Host**: `https://cloudcode-pa.googleapis.com`

---

## 2. Root Cause of Account Bans & 403 Violations

In late 2026, Google initiated automated account restrictions on non-compliant clients. Analysis of network dumps and reverse-engineered clients reveals the primary triggers:

1. **Shared Public OAuth Client ID**:
   Using the default hardcoded client ID (`1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`) across thousands of unverified third-party IP addresses without matching browser or app runtime fingerprints.
2. **Conflicting / Mismatched Headers**:
   Older unofficial clients sent `X-Goog-Api-Client` and `Client-Metadata` headers alongside inference calls. Real Antigravity Hub requests send **only** the canonical `User-Agent`.
3. **Stale / Hardcoded User-Agent Versions**:
   Sending outdated version strings (e.g., `antigravity/hub/2.1.4`, `antigravity/1.15.8`, or `GeminiCLI/0.27.x`) when the backend requires active versioning >= `2.26.0`.
4. **Missing or Corrupted Project ID**:
   Consumer Gmail accounts require a bound project identifier (`cloudaicompanionProject`). When missing, the request must either probe `/v1internal:loadCodeAssist` or use the canonical fallback project ID (`rising-fact-p41fc`).

---

## 3. Legitimate Wire Signatures & Headers

### A. Inference Requests (`/v1internal:streamGenerateContent?alt=sse` and `generateContent`)

On active chat/inference sessions, the legitimate Antigravity Hub client sends:

```http
POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: text/event-stream
Accept-Encoding: gzip
User-Agent: antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104)
```

> **CRITICAL RULE**: Do **NOT** send `X-Goog-Api-Client` or `Client-Metadata` on content inference calls. The Hub backend treats their presence as an indicator of an emulated/third-party wrapper.

### B. Control Plane Requests (`/v1internal:loadCodeAssist`, `/v1internal:onboardUser`)

When performing project discovery and onboarding:

```http
POST /v1internal:loadCodeAssist HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
Authorization: Bearer <access_token>
Content-Type: application/json
User-Agent: antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104)
```

Body:
```json
{
  "metadata": {
    "ideType": "ANTIGRAVITY"
  }
}
```

Response Payload (Subscription Tier Discovery):
```json
{
  "cloudaicompanionProject": "aicode-consumers",
  "currentTier": {
    "id": "free-tier",
    "name": "Antigravity",
    "description": "Gemini-powered code suggestions and chat in multiple IDEs"
  },
  "paidTier": {
    "id": "g1-pro-tier",
    "name": "Google AI Pro",
    "upgradeSubscriptionText": "You can upgrade to a Google AI Ultra plan to receive higher rate limits."
  },
  "allowedTiers": [
    { "id": "free-tier", "name": "Antigravity", "isDefault": true },
    { "id": "standard-tier", "name": "Antigravity" }
  ]
}
```

Google Antigravity Tier Hierarchy:
- **Google AI Ultra** (`g1-ultra-tier`): Highest daily and burst request quotas.
- **Google AI Pro** (`g1-pro-tier`): Extended request limits with Claude Opus/Sonnet and Gemini 4 Argon access.
- **Google AI Plus** (`g1-plus-tier`): Starter paid subscription with standard base quotas.
- **Free Tier** (`free-tier`): Default personal quota allocation.

Onboard User (when `currentTier` is absent):
```http
POST /v1internal:onboardUser HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
Authorization: Bearer <access_token>
Content-Type: application/json
User-Agent: antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104) google-api-nodejs-client/10.3.0
X-Goog-Api-Client: gl-node/22.21.1
```

Body:
```json
{
  "tier": "free-tier",
  "metadata": {
    "ide_type": "ANTIGRAVITY",
    "platform": "WINDOWS",
    "plugin_type": "GEMINI"
  }
}
```

### C. Quota & Model Listing (`/v1internal:retrieveUserQuotaSummary`, `/v1internal:fetchAvailableModels`)

```http
POST /v1internal:retrieveUserQuotaSummary HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
Authorization: Bearer <access_token>
Content-Type: application/json
User-Agent: antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104)
```

Body:
```json
{
  "project": "<projectId>"
}
```

---

## 4. Request Payload Envelope

Antigravity uses Google's unified envelope format wrapping Gemini contents:

```json
{
  "project": "<projectId>",
  "model": "<modelId>",
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [
          { "text": "Hello world" }
        ]
      }
    ],
    "generationConfig": {
      "temperature": 0.2,
      "maxOutputTokens": 8192
    },
    "sessionId": "<sessionId>",
    "systemInstruction": {
      "parts": [
        { "text": "You are a helpful coding assistant." }
      ]
    },
    "tools": [
      {
        "functionDeclarations": [
          {
            "name": "read_file",
            "description": "Read file contents",
            "parameters": {
              "type": "OBJECT",
              "properties": {
                "path": { "type": "STRING" }
              },
              "required": ["path"]
            }
          }
        ]
      }
    ]
  },
  "userAgent": "antigravity",
  "requestId": "agent-<timestamp>-<random>"
}
```

For Claude models (`claude-sonnet-5-5-high`, `claude-opus-5-5-medium`, `claude-opus-4-6-thinking`), add the beta header:
`anthropic-beta: interleaved-thinking-2025-05-14`

---

## 5. Dynamic Release & Manifest Synchronization

Antigravity Hub publishes its latest release version via an electron-builder YAML manifest:
```
https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml
```

Headers to query the manifest:
```http
User-Agent: electron-builder
Cache-Control: no-cache
```

Known verified versions & changelists:
| Hub Version | Changelist (`cl`) | Minimum Required |
|---|---|---|
| `2.23.0` | `998057262` | ❌ Deprecated |
| `2.24.0` | `1000335682` | ⚠️ Transitioning |
| `2.26.0` | `1005016104` | ✅ Active Baseline |
| `2.30.0` | `6386428939206656` | ✅ Latest Production |

---

## 6. OMP Configuration & Environment Levers

Oh My Pi (`@oh-my-pi/pi-coding-agent`) already possesses native hooks for these parameters via environment variables:

| Environment Variable | Default | Recommended Stealth Setting | Purpose |
|---|---|---|---|
| `PI_AI_ANTIGRAVITY_VERSION` | `"2.26.0"` | `"2.30.0"` or manifest-resolved | Hub version |
| `PI_AI_ANTIGRAVITY_CL` | `"1005016104"` | `"6386428939206656"` | Internal Google Changelist |
| `PI_AI_ANTIGRAVITY_OS` | `process.platform` | `"windows"` (or native host) | Reported OS type |
| `PI_AI_ANTIGRAVITY_ARCH` | `process.arch` | `"amd64"` | Reported architecture |
| `ANTIGRAVITY_CLIENT_ID` | Default public | *Custom GCP OAuth Client ID* | Isolates account from shared bans |
| `ANTIGRAVITY_CLIENT_SECRET` | Default public | *Custom GCP OAuth Secret* | Paired secret |
| `providers.antigravityEndpoint` | `auto` | `production` (maps to daily host) | Target endpoint strategy |
