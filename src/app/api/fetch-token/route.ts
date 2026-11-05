/**
 * /api/fetch-token — Genesys Cloud Bearer Token Retrieval
 *
 * Automates authentication into Genesys Cloud via Microsoft Entra ID SSO
 * using a headless Chromium session, then extracts and returns the active
 * OAuth Bearer access token.
 *
 * Security constraints (all mandatory):
 *  - Login always begins at STRICT_LOGIN_URL (hardcoded, non-configurable).
 *  - Callers must supply x-api-key matching INTERNAL_API_KEY env var.
 *  - Only redirects to whitelisted domains are allowed.
 *  - Any request that tries to supply a custom login URL is rejected.
 */

import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only permitted authentication entry point.
 * MUST NOT be changed, exposed via config, or accepted from callers.
 */
const STRICT_LOGIN_URL =
  "https://login.mypurecloud.com/#/authenticate-adv/org/hellofresh";

/**
 * Domains the headless browser is allowed to navigate to during SSO.
 * Any redirect outside these patterns causes an error.
 */
const ALLOWED_REDIRECT_PATTERNS: RegExp[] = [
  /^https?:\/\/([a-z0-9-]+\.)*mypurecloud\.com(\/|$)/i,
  /^https?:\/\/login\.microsoftonline\.com(\/|$)/i,
  /^https?:\/\/([a-z0-9-]+\.)*microsoft\.com(\/|$)/i,
  /^https?:\/\/([a-z0-9-]+\.)*live\.com(\/|$)/i,
];

/** Default token TTL — 45 minutes in milliseconds. */
const TOKEN_TTL_MS = 45 * 60 * 1000;

/**
 * Public Chromium binary used by @sparticuz/chromium-min in Vercel/Lambda.
 * Pinned to a specific release for reproducibility.
 */
const CHROMIUM_REMOTE_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar";

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY TOKEN CACHE
// ─────────────────────────────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp (ms)
}

// Module-level cache — survives across warm invocations of the same serverless
// instance but is NOT shared between instances.
let tokenCache: CachedToken | null = null;

function getCachedToken(): string | null {
  if (!tokenCache) return null;
  if (Date.now() >= tokenCache.expiresAt) {
    tokenCache = null;
    return null;
  }
  return tokenCache.token;
}

function setCachedToken(token: string): void {
  tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
}

// ─────────────────────────────────────────────────────────────────────────────
// URL VALIDATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function isAllowedRedirectUrl(url: string): boolean {
  return ALLOWED_REDIRECT_PATTERNS.some((re) => re.test(url));
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function corsResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION GUARD
// ─────────────────────────────────────────────────────────────────────────────

function validateApiKey(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    // Guard against misconfigured deployments
    console.error("[auth] INTERNAL_API_KEY environment variable is not set.");
    return false;
  }
  return key === expected;
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER LAUNCH
// ─────────────────────────────────────────────────────────────────────────────

async function launchBrowser() {
  const isVercel =
    process.env.VERCEL === "1" || process.env.AWS_LAMBDA_FUNCTION_NAME != null;

  if (isVercel) {
    // Serverless path — download Chromium at runtime.
    const chromium = (await import("@sparticuz/chromium-min")).default;
    const puppeteer = (await import("puppeteer-core")).default;

    const executablePath = await chromium.executablePath(CHROMIUM_REMOTE_URL);

    return puppeteer.launch({
      args: [
        ...chromium.args,
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--single-process",
        "--no-zygote",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--safebrowsing-disable-auto-update",
        "--mute-audio",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });
  } else {
    // Local development path — fall back to a system-installed Chrome/Chromium.
    const puppeteer = (await import("puppeteer-core")).default;

    const localExecutables: string[] = [
      // macOS
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      // Linux
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      // Windows (common install paths)
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.CHROME_EXECUTABLE_PATH ?? "",
    ].filter(Boolean);

    const { existsSync } = await import("fs");
    const executablePath = localExecutables.find((p) => existsSync(p));

    if (!executablePath) {
      throw new Error(
        "No local Chrome executable found. Set CHROME_EXECUTABLE_PATH or install Google Chrome."
      );
    }

    return puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      executablePath,
      headless: true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE TOKEN-RETRIEVAL LOGIC
// ─────────────────────────────────────────────────────────────────────────────

interface TokenResult {
  success: true;
  token: string;
  source: "cache" | "network-header" | "url-fragment" | "storage";
  cachedUntil?: string;
}

interface TokenError {
  success: false;
  error: string;
  debugStorage?: {
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  };
}

type TokenResponse = TokenResult | TokenError;

async function fetchGenesysToken(
  email: string,
  password: string
): Promise<TokenResponse> {
  let capturedToken: string | null = null;
  let tokenSource: TokenResult["source"] = "network-header";

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();

    // ── Block unnecessary resource types to speed up automation ──────────────
    await page.setRequestInterception(true);
    const BLOCKED_TYPES = new Set(["image", "media", "font", "stylesheet"]);

    // ── Network observation — Method 1 ───────────────────────────────────────
    page.on("request", (request) => {
      // Puppeteer 25+ Cooperative Intercept Mode guard: bail if another handler
      // already resolved this request (prevents "Request is already handled" errors).
      if (request.isInterceptResolutionHandled()) return;

      const resourceType = request.resourceType();
      if (BLOCKED_TYPES.has(resourceType)) {
        request.abort();
        return;
      }

      // Capture Bearer token from outgoing Authorization headers
      if (!capturedToken) {
        const headers = request.headers();
        const auth = headers["authorization"] ?? headers["Authorization"];
        if (auth && auth.startsWith("Bearer ")) {
          const candidate = auth.slice(7).trim();
          if (candidate.length > 20) {
            capturedToken = candidate;
            tokenSource = "network-header";
            console.log("[token] Captured from Authorization request header.");
          }
        }

        // Reject navigation to non-whitelisted domains
        const url = request.url();
        const isNav =
          request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (isNav && !isAllowedRedirectUrl(url)) {
          console.warn(`[security] Blocking navigation to disallowed URL: ${url}`);
          request.abort("blockedbyclient");
          return;
        }
      }

      request.continue();
    });


    page.on("response", async (response) => {
      if (capturedToken) return;
      try {
        const url = response.url();
        // Check responses from Genesys API for bearer tokens in Authorization echoes
        if (/mypurecloud\.com\/api\/v2\//i.test(url)) {
          const reqHeaders = response.request().headers();
          const auth =
            reqHeaders["authorization"] ?? reqHeaders["Authorization"];
          if (auth && auth.startsWith("Bearer ")) {
            const candidate = auth.slice(7).trim();
            if (candidate.length > 20) {
              capturedToken = candidate;
              tokenSource = "network-header";
              console.log("[token] Captured from API response request header.");
            }
          }
        }
      } catch {
        // response header access can throw on cross-origin requests
      }
    });

    // Capture OAuth fragment tokens from URL redirects
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      if (capturedToken) return;

      const url = frame.url();
      const fragmentMatch = url.match(/[#&]access_token=([^&]+)/i);
      if (fragmentMatch) {
        capturedToken = decodeURIComponent(fragmentMatch[1]);
        tokenSource = "url-fragment";
        console.log("[token] Captured from URL fragment.");
      }
    });

    // ── Step A: Navigate to the fixed Genesys login URL ──────────────────────
    console.log(`[browser] Navigating to login URL...`);
    await page.goto(STRICT_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Allow SPA to hydrate and potentially auto-redirect
    await new Promise((r) => setTimeout(r, 3000));

    // If still on mypurecloud.com, look for and click the SSO button
    const currentUrl = page.url();
    if (/mypurecloud\.com/i.test(currentUrl) && !capturedToken) {
      console.log("[browser] Checking for SSO button...");
      try {
        // Try multiple SSO button selectors
        const ssoSelectors = [
          'button[data-provider-type="adv"]',
          'button[ng-click*="sso"]',
          'a[href*="microsoftonline"]',
          'button:contains("Microsoft")',
          '[class*="sso"]',
          '[class*="microsoft"]',
          '[data-qa="adv-login-button"]',
          'button[type="button"]',
        ];

        let clicked = false;
        for (const selector of ssoSelectors) {
          try {
            const el = await page.$(selector);
            if (el) {
              await el.click();
              clicked = true;
              console.log(`[browser] Clicked SSO button with selector: ${selector}`);
              break;
            }
          } catch {
            // selector not found, try next
          }
        }

        if (!clicked) {
          // Try evaluating JS to find and click it
          const jsClicked = await page.evaluate(() => {
            const buttons = Array.from(
              document.querySelectorAll("button, a")
            ) as HTMLElement[];
            const ssoBtn = buttons.find(
              (el) =>
                /microsoft|single sign|sso|azure|entra/i.test(
                  el.textContent ?? ""
                ) ||
                /microsoft|sso|adv/i.test(el.className)
            );
            if (ssoBtn) {
              ssoBtn.click();
              return true;
            }
            return false;
          });
          if (jsClicked) {
            console.log("[browser] SSO button clicked via JS evaluation.");
          }
        }

        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {
          console.log("[browser] No navigation after SSO click (may have redirected via JS).");
        });
      } catch (err) {
        console.log("[browser] SSO button handling:", (err as Error).message);
      }
    }

    // ── Step B: Microsoft Entra ID username entry ─────────────────────────────
    if (!capturedToken) {
      try {
        console.log("[browser] Waiting for Microsoft username field...");
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 20_000 });
        await page.type('input[name="loginfmt"]', email, { delay: 50 });

        // Click Next / Submit button
        const nextSelectors = [
          'input[type="submit"]',
          'button[type="submit"]',
          "#idSIButton9",
          'input[value="Next"]',
        ];
        for (const sel of nextSelectors) {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            break;
          }
        }

        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
        console.log("[browser] Username submitted.");
      } catch (err) {
        console.log("[browser] Username step:", (err as Error).message);
      }
    }

    // ── Step B: Microsoft Entra ID password entry ─────────────────────────────
    if (!capturedToken) {
      try {
        console.log("[browser] Waiting for Microsoft password field...");
        await page.waitForSelector('input[name="passwd"]', { timeout: 20_000 });
        await page.type('input[name="passwd"]', password, { delay: 50 });

        const submitSelectors = [
          'input[type="submit"]',
          'button[type="submit"]',
          "#idSIButton9",
          'input[value="Sign in"]',
        ];
        for (const sel of submitSelectors) {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            break;
          }
        }

        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        console.log("[browser] Password submitted.");
      } catch (err) {
        console.log("[browser] Password step:", (err as Error).message);
      }
    }

    // ── Step B: "Stay signed in?" prompt ─────────────────────────────────────
    if (!capturedToken) {
      try {
        const staySignedInBtn = await page.$("#idSIButton9");
        if (staySignedInBtn) {
          console.log('[browser] Handling "Stay signed in?" prompt (Yes).');
          await staySignedInBtn.click();
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
        } else {
          const noBtn = await page.$("#idBtn_Back");
          if (noBtn) {
            console.log('[browser] Handling "Stay signed in?" prompt (No).');
            await noBtn.click();
            await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
          }
        }
      } catch {
        // prompt may not appear
      }
    }

    // Allow the app to fully load after authentication
    await new Promise((r) => setTimeout(r, 4000));

    // ── Method 2: Browser storage inspection ─────────────────────────────────
    let debugStorage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> } = {
      localStorage: {},
      sessionStorage: {},
    };

    if (!capturedToken) {
      console.log("[token] Inspecting browser storage...");

      const storageData = await page.evaluate(() => {
        const ls: Record<string, string> = {};
        const ss: Record<string, string> = {};

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) ls[key] = localStorage.getItem(key) ?? "";
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) ss[key] = sessionStorage.getItem(key) ?? "";
        }

        return { ls, ss };
      });

      debugStorage = {
        localStorage: storageData.ls,
        sessionStorage: storageData.ss,
      };

      // Search for token values in all storage entries
      const TOKEN_KEYS = /access_token|token|auth_token|bearer/i;

      const allEntries = [
        ...Object.entries(storageData.ls),
        ...Object.entries(storageData.ss),
      ];

      for (const [key, value] of allEntries) {
        if (!value) continue;

        // Direct token key match
        if (TOKEN_KEYS.test(key) && value.length > 20 && !value.startsWith("{")) {
          capturedToken = value;
          tokenSource = "storage";
          console.log(`[token] Found token in storage key: ${key}`);
          break;
        }

        // JSON payload containing a token field
        if (value.startsWith("{") || value.startsWith("[")) {
          try {
            const parsed = JSON.parse(value);
            const findToken = (obj: unknown): string | null => {
              if (typeof obj === "string" && obj.length > 20) return null; // need key context
              if (typeof obj === "object" && obj !== null) {
                for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
                  if (TOKEN_KEYS.test(k) && typeof v === "string" && v.length > 20) {
                    return v;
                  }
                  const nested = findToken(v);
                  if (nested) return nested;
                }
              }
              return null;
            };
            const found = findToken(parsed);
            if (found) {
              capturedToken = found;
              tokenSource = "storage";
              console.log(`[token] Found token inside JSON value at storage key: ${key}`);
              break;
            }
          } catch {
            // not valid JSON
          }
        }
      }

      if (!capturedToken) {
        return {
          success: false,
          error:
            "Authentication completed but no Bearer token was found. " +
            "Check debugStorage for raw storage contents.",
          debugStorage,
        };
      }
    }

    // ── Success ───────────────────────────────────────────────────────────────
    setCachedToken(capturedToken);

    return {
      success: true,
      token: capturedToken,
      source: tokenSource,
      cachedUntil: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    };
  } finally {
    // Always close the browser — prevents orphaned processes in Vercel.
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST BODY INTERFACE
// ─────────────────────────────────────────────────────────────────────────────

interface RequestBody {
  email?: string;
  password?: string;
  // If a caller tries to pass any URL-like field, we reject the request.
  loginUrl?: unknown;
  url?: unknown;
  targetUrl?: unknown;
  authUrl?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

/** OPTIONS — CORS preflight */
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** GET — returns cached token or performs fresh login */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!validateApiKey(req)) {
    return corsResponse({ error: "Unauthorized: missing or invalid x-api-key" }, 401);
  }

  const forceRefresh = req.nextUrl.searchParams.get("forceRefresh") === "true";

  if (!forceRefresh) {
    const cached = getCachedToken();
    if (cached) {
      return corsResponse({
        success: true,
        token: cached,
        source: "cache",
        cachedUntil: tokenCache
          ? new Date(tokenCache.expiresAt).toISOString()
          : undefined,
      }, 200);
    }
  }

  const email = process.env.GENESIS_USER_EMAIL;
  const password = process.env.GENESIS_USER_PASSWORD;

  if (!email || !password) {
    return corsResponse(
      {
        error:
          "No credentials provided. For GET requests, set GENESIS_USER_EMAIL " +
          "and GENESIS_USER_PASSWORD environment variables.",
      },
      400
    );
  }

  const result = await fetchGenesysToken(email, password);
  return corsResponse(result, result.success ? 200 : 500);
}

/** POST — accepts optional credentials in body, falls back to env vars */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!validateApiKey(req)) {
    return corsResponse({ error: "Unauthorized: missing or invalid x-api-key" }, 401);
  }

  let body: RequestBody = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as RequestBody;
  } catch {
    return corsResponse({ error: "Invalid JSON in request body." }, 400);
  }

  // ── Security: reject any attempt to supply a custom login URL ───────────────
  if (
    body.loginUrl !== undefined ||
    body.url !== undefined ||
    body.targetUrl !== undefined ||
    body.authUrl !== undefined
  ) {
    return corsResponse(
      {
        error:
          "Validation error: supplying a custom login URL is not permitted. " +
          "The service always authenticates via the fixed internal entry point.",
      },
      400
    );
  }

  const email = body.email ?? process.env.GENESIS_USER_EMAIL;
  const password = body.password ?? process.env.GENESIS_USER_PASSWORD;

  if (!email || !password) {
    return corsResponse(
      {
        error:
          'Credentials required. Supply {"email":"...","password":"..."} in the ' +
          "request body or set GENESIS_USER_EMAIL and GENESIS_USER_PASSWORD environment variables.",
      },
      400
    );
  }

  const result = await fetchGenesysToken(email, password);
  return corsResponse(result, result.success ? 200 : 500);
}
