# Genesys Cloud Auth Token Service

A production-ready, standalone **Next.js 14** microservice that automates authentication into **Genesys Cloud** (PureCloud) through **Microsoft Entra ID (Azure AD) Single Sign-On** using a headless browser session, then securely retrieves and returns the active OAuth Bearer access token.

Designed for direct deployment to **Vercel** with zero structural changes.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Security Model](#security-model)
3. [Local Development Setup](#local-development-setup)
4. [Environment Variables](#environment-variables)
5. [API Reference](#api-reference)
6. [GitHub Repository Setup](#github-repository-setup)
7. [Vercel Deployment](#vercel-deployment)
8. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
Caller ──► POST /api/fetch-token ──► Token Cache (45 min TTL)
                │                           │ HIT → return token
                │                           │ MISS ↓
                └──► Headless Chromium ──► login.mypurecloud.com
                                      ──► login.microsoftonline.com (Entra ID)
                                      ──► Network interception / storage scan
                                      ──► Bearer token extracted & cached
```

### Token capture strategy (both run simultaneously)

| Method | Mechanism |
|--------|-----------|
| **Network observation** | `page.on("request")` intercepts `Authorization: Bearer …` headers sent to `*.mypurecloud.com` |
| **URL fragment capture** | `page.on("framenavigated")` watches for `#access_token=…` in redirect URLs |
| **Storage inspection** | After login, `localStorage` / `sessionStorage` are searched for token values |

---

## Security Model

| Constraint | Enforcement |
|---|---|
| Fixed login URL | `STRICT_LOGIN_URL` is hardcoded; never read from config, env, or request |
| Custom URL rejection | Any request body containing `loginUrl`, `url`, `targetUrl`, or `authUrl` returns `400` |
| Allowed redirect domains | Only `*.mypurecloud.com`, `login.microsoftonline.com`, `*.microsoft.com`, `*.live.com` |
| API key gate | Every request must carry `x-api-key` matching `INTERNAL_API_KEY` |
| Resource isolation | Chromium process is always closed in a `finally` block |

---

## Local Development Setup

### Prerequisites

- Node.js ≥ 18.17.0
- Google Chrome installed (the local fallback)
- npm / yarn / pnpm

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/<your-org>/genesys-auth-token-service.git
cd genesys-auth-token-service

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env.local
# Edit .env.local and fill in all three values (see Environment Variables below)

# 4. Start the development server
npm run dev
```

The service will be available at `http://localhost:3000`.

> **Note for Windows users:** Chrome is typically found at  
> `C:\Program Files\Google\Chrome\Application\chrome.exe`  
> This path is included in the automatic search list, so no extra config is needed.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INTERNAL_API_KEY` | ✅ | Secret key callers must supply via `x-api-key` header. Generate with: `openssl rand -hex 32` |
| `GENESIS_USER_EMAIL` | ✅ | Genesys Cloud / Entra ID account email address |
| `GENESIS_USER_PASSWORD` | ✅ | Corresponding password |

**`.env.local` (never commit this file):**
```env
INTERNAL_API_KEY=your-secret-key-here
GENESIS_USER_EMAIL=user@yourorg.com
GENESIS_USER_PASSWORD=YourSecurePassword
```

---

## API Reference

### Endpoint

```
/api/fetch-token
```

### Authentication

All requests require the header:

```http
x-api-key: <INTERNAL_API_KEY>
```

Missing or incorrect key → `401 Unauthorized`.

---

### `GET /api/fetch-token`

Returns the cached token (if valid) or performs a fresh login using environment-variable credentials.

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `forceRefresh` | `boolean` | Set to `true` to bypass cache and force a fresh login |

#### Examples

**Retrieve cached token:**
```bash
curl -X GET "https://your-deployment.vercel.app/api/fetch-token" \
  -H "x-api-key: your-secret-key"
```

**Force a fresh token:**
```bash
curl -X GET "https://your-deployment.vercel.app/api/fetch-token?forceRefresh=true" \
  -H "x-api-key: your-secret-key"
```

**JavaScript (fetch):**
```javascript
const res = await fetch("https://your-deployment.vercel.app/api/fetch-token", {
  method: "GET",
  headers: { "x-api-key": "your-secret-key" },
});
const data = await res.json();
console.log(data.token); // Bearer token string
```

---

### `POST /api/fetch-token`

Accepts optional credentials in the request body, falling back to environment variables.

#### Request Body (optional)

```json
{
  "email": "user@yourorg.com",
  "password": "YourSecurePassword"
}
```

#### Example

```bash
curl -X POST "https://your-deployment.vercel.app/api/fetch-token" \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"email":"user@yourorg.com","password":"YourSecurePassword"}'
```

#### Rejected body (returns 400)

```json
{ "loginUrl": "https://evil.com" }
```

---

### Success Response `200`

```json
{
  "success": true,
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "source": "network-header",
  "cachedUntil": "2025-01-01T12:45:00.000Z"
}
```

| Field | Description |
|-------|-------------|
| `token` | The Bearer access token string |
| `source` | Where the token was captured: `cache`, `network-header`, `url-fragment`, or `storage` |
| `cachedUntil` | ISO timestamp when the cached token expires |

### Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Missing/invalid credentials or disallowed request field |
| `401` | Missing or invalid `x-api-key` |
| `500` | Authentication succeeded but token not found — check `debugStorage` |

**Debug response (500):**
```json
{
  "success": false,
  "error": "Authentication completed but no Bearer token was found.",
  "debugStorage": {
    "localStorage": { "key": "value", "..." : "..." },
    "sessionStorage": {}
  }
}
```

---

## GitHub Repository Setup

```bash
# In the project directory:
git init
git add .
git commit -m "feat: initial production-ready Genesys auth token service"

# Create repository on GitHub, then:
git remote add origin https://github.com/<your-org>/genesys-auth-token-service.git
git branch -M main
git push -u origin main
```

> ⚠️ Ensure `.env.local` is in `.gitignore` (it is by default). Never push real credentials.

---

## Vercel Deployment

### Method 1: Vercel Dashboard (Recommended)

1. Push your repository to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new).
3. Import the GitHub repository.
4. Set the **Framework Preset** to `Next.js`.
5. Under **Environment Variables**, add:
   - `INTERNAL_API_KEY`
   - `GENESIS_USER_EMAIL`
   - `GENESIS_USER_PASSWORD`
6. Click **Deploy**.

### Method 2: Vercel CLI

```bash
npm install -g vercel

# First deployment
vercel

# Production deployment
vercel --prod
```

Set environment variables via CLI:
```bash
vercel env add INTERNAL_API_KEY production
vercel env add GENESIS_USER_EMAIL production
vercel env add GENESIS_USER_PASSWORD production
```

### Vercel Function Configuration

The `vercel.json` already configures the token endpoint with:
- **Memory:** 3008 MB
- **Max Duration:** 60 seconds

These settings are required because headless Chromium is memory-intensive.

---

## Troubleshooting

### `No local Chrome executable found`

Install Google Chrome, or set the path explicitly in `.env.local`:
```env
CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome
```

### Token not found — `debugStorage` is empty

The SSO flow may have changed. Check:
1. The Genesys login page still redirects via `STRICT_LOGIN_URL`.
2. Entra ID login selectors (`input[name="loginfmt"]`, `input[name="passwd"]`) still match.
3. Consider increasing timeouts in `route.ts` if authentication is slow.

### `401 Unauthorized`

Verify the `x-api-key` header value matches `INTERNAL_API_KEY` exactly (no trailing spaces, correct casing).

### Vercel timeout / out of memory

- Chromium download (`CHROMIUM_REMOTE_URL`) may be slow on first cold start. The 60-second function timeout accommodates this.
- If still timing out, consider pinning to a faster CDN mirror for the Chromium binary.

### CORS errors from browser

The service returns `Access-Control-Allow-Origin: *`. If your security policy requires a specific origin, modify `CORS_HEADERS` in `route.ts`.

### Chromium version mismatch

If `puppeteer-core` and `@sparticuz/chromium-min` versions diverge, Chromium may refuse to launch. Keep them in sync:

| puppeteer-core | @sparticuz/chromium-min |
|---|---|
| 22.x | 123.x |

---

## License

MIT
