# Genesys Cloud Auth Token Service

A production-ready Next.js microservice that automates authentication into **Genesys Cloud** (PureCloud) through **Microsoft Entra ID (Azure AD) Single Sign-On** using a headless browser session, then securely retrieves and returns the active OAuth Bearer access token as a JSON payload.

Designed for direct deployment to **Vercel** and stored on GitHub: [github.com/abdullahy14/Parallel-OAuth](https://github.com/abdullahy14/Parallel-OAuth).

---

## Key Features

1. **12-Hour Token Validity:** Tokens remain valid for **12 hours** (`TOKEN_TTL_MS = 12 * 60 * 60 * 1000`). Once the Bearer token is passed to the client, the client manages it directly.
2. **Interactive Frontend Login UI / Popup Modal:**
   - Beautiful dark-mode modal portal hosted at `/`.
   - Users can enter credentials manually.
   - Shows real-time progress stages as headless Chromium handles SSO.
   - Instant token display with copy options: **Copy Bearer Token** and **Copy Full JSON Payload**.
   - If opened in a popup window (`window.open`), automatically broadcasts the JSON payload via `window.opener.postMessage`.
3. **Headless SSO Automation:** Runs isolated Chromium instances on Vercel serverless functions using `@sparticuz/chromium-min` and `puppeteer-core`.
4. **Dual Retrieval Strategy:** Network interceptor (`Authorization: Bearer ...`) and storage scanner (`localStorage` / `sessionStorage`).
5. **Programmatic API:** Server-to-server endpoint at `/api/fetch-token` guarded by `x-api-key`.

---

## Architecture & Workflows

### Workflow 1: Manual Frontend Login (Interactive Portal)

```
User visits / ──► Types Email & Password ──► POST /api/login
                                                     │
                                                     ▼
                                        Headless Chromium SSO
                                                     │
                                                     ▼
                                         Bearer Token Extracted
                                                     │
                                        ┌────────────┴────────────┐
                                        ▼                         ▼
                              Displays Token in UI       Dispatches JSON via
                             (with 12h countdown)    window.opener.postMessage
```

#### Integrating into another Frontend as a Popup

You can open this service as a popup from any other web app:

```javascript
// 1. Open popup window
const popup = window.open(
  "https://your-deployment.vercel.app",
  "GenesysAuthPopup",
  "width=520,height=680,centerscreen=yes"
);

// 2. Listen for the token JSON
window.addEventListener("message", (event) => {
  if (event.data?.type === "GENESYS_AUTH_SUCCESS") {
    const { token, expiresAt, cachedUntil } = event.data.data;
    console.log("Received Genesys token:", token);
    console.log("Token expires at:", new Date(expiresAt));

    // Store in your client application (valid for 12 hours)
    localStorage.setItem("genesys_bearer_token", token);

    // Optional: close the popup
    popup?.close();
  }
});
```

---

### Workflow 2: Programmatic API (`/api/fetch-token`)

For backend-to-backend calls requiring an API key:

```bash
curl -X POST "https://your-deployment.vercel.app/api/fetch-token" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_INTERNAL_API_KEY" \
  -d '{
    "email": "user@hellofresh.com",
    "password": "SecretPassword"
  }'
```

#### JSON Response Format

```json
{
  "success": true,
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "source": "network-header",
  "expiresAt": 1793910000000,
  "cachedUntil": "2026-11-06T10:30:00.000Z"
}
```

---

## Security Model

| Constraint | Enforcement |
|---|---|
| **Fixed Login Entry Point** | Hardcoded to `https://login.mypurecloud.com/#/authenticate-adv/org/hellofresh`. Never configurable. |
| **Custom URL Rejection** | Any request specifying a custom URL (`loginUrl`, `url`, `targetUrl`, `authUrl`) returns `400 Bad Request`. |
| **Whitelisted SSO Domains** | Only `*.mypurecloud.com`, `login.microsoftonline.com`, `*.microsoft.com`, `*.live.com`. |
| **API Key Gate** | Programmatic `/api/fetch-token` requires valid `x-api-key`. |
| **Resource Isolation** | Chromium process guaranteed to close in `try...finally` block. |

---

## Environment Variables

Copy `.env.example` to `.env.local`:

```env
INTERNAL_API_KEY=your-random-32-char-secret-key
GENESIS_USER_EMAIL=user@hellofresh.com
GENESIS_USER_PASSWORD=YourPassword
```

*(Note: `GENESIS_USER_EMAIL` and `GENESIS_USER_PASSWORD` are optional if you provide credentials dynamically in the UI or in the POST request body).*

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Type-check
npm run type-check

# 3. Start local server
npm run dev
```

Visit `http://localhost:3000` to use the manual login portal.

---

## Vercel Deployment

1. Go to [vercel.com/new](https://vercel.com/new).
2. Import the GitHub repository: `abdullahy14/Parallel-OAuth`.
3. Set environment variable:
   - `INTERNAL_API_KEY`
4. Click **Deploy**.

`vercel.json` already specifies:
- 3008 MB RAM
- 60s max execution duration
- Zero-cache headers for `/api/*`
