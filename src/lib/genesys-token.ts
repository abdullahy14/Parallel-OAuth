/**
 * src/lib/genesys-token.ts
 *
 * Core Genesys Cloud token retrieval logic — shared between the browser-facing
 * /api/login route and the programmatic /api/fetch-token route.
 */

import type { Browser } from "puppeteer-core";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** The only permitted authentication entry point. Hardcoded, never configurable. */
export const STRICT_LOGIN_URL =
  "https://login.mypurecloud.com/#/authenticate-adv/org/hellofresh";

/** Token TTL — 12 hours in milliseconds. */
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Public Chromium binary used by @sparticuz/chromium-min in Vercel/Lambda.
 * Pinned to a specific release for reproducibility.
 */
const CHROMIUM_REMOTE_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar";

/** Domains the headless browser is allowed to navigate to during SSO. */
const ALLOWED_REDIRECT_PATTERNS: RegExp[] = [
  /^https?:\/\/([a-z0-9-]+\.)*mypurecloud\.com(\/|$)/i,
  /^https?:\/\/login\.microsoftonline\.com(\/|$)/i,
  /^https?:\/\/([a-z0-9-]+\.)*microsoft\.com(\/|$)/i,
  /^https?:\/\/([a-z0-9-]+\.)*live\.com(\/|$)/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY TOKEN CACHE
// ─────────────────────────────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

export function getCachedToken(): string | null {
  if (!tokenCache) return null;
  if (Date.now() >= tokenCache.expiresAt) {
    tokenCache = null;
    return null;
  }
  return tokenCache.token;
}

export function setCachedToken(token: string): void {
  tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
}

export function getCacheExpiry(): number | null {
  return tokenCache ? tokenCache.expiresAt : null;
}

export function clearCache(): void {
  tokenCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

export function isAllowedRedirectUrl(url: string): boolean {
  return ALLOWED_REDIRECT_PATTERNS.some((re) => re.test(url));
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER LAUNCH
// ─────────────────────────────────────────────────────────────────────────────

export async function launchBrowser(): Promise<Browser> {
  const puppeteer = (await import("puppeteer-core")).default;
  const { resolveBrowserExecutable } = await import("./detect-browser");

  const { executablePath, args } = await resolveBrowserExecutable();

  return puppeteer.launch({
    args,
    ignoreDefaultArgs: ["--enable-automation"],
    executablePath,
    headless: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenResult {
  success: true;
  token: string;
  source: "cache" | "network-header" | "url-fragment" | "storage";
  expiresAt: number;
  cachedUntil: string;
}

export interface TokenError {
  success: false;
  error: string;
  debugStorage?: {
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  };
}

export type TokenResponse = TokenResult | TokenError;

// ─────────────────────────────────────────────────────────────────────────────
// CORE TOKEN RETRIEVAL
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchGenesysToken(
  email: string,
  password: string
): Promise<TokenResponse> {
  let capturedToken: string | null = null;
  let tokenSource: TokenResult["source"] = "network-header";

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    const BLOCKED_TYPES = new Set(["image", "media", "font", "stylesheet"]);

    // ── Method 1A: Request Authorization header interception ──────────────────
    page.on("request", (request) => {
      if (request.isInterceptResolutionHandled()) return;

      if (BLOCKED_TYPES.has(request.resourceType())) {
        request.abort();
        return;
      }

      if (!capturedToken) {
        const headers = request.headers();
        const auth = headers["authorization"] ?? headers["Authorization"];
        if (auth?.startsWith("Bearer ")) {
          const candidate = auth.slice(7).trim();
          if (candidate.length > 20) {
            capturedToken = candidate;
            tokenSource = "network-header";
            console.log("[token] Captured from Authorization request header.");
          }
        }

        const url = request.url();
        const isNav =
          request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (isNav && !isAllowedRedirectUrl(url)) {
          console.warn(`[security] Blocking navigation to: ${url}`);
          request.abort("blockedbyclient");
          return;
        }
      }

      request.continue();
    });

    // ── Method 1B: Response header inspection ─────────────────────────────────
    page.on("response", async (response) => {
      if (capturedToken) return;
      try {
        if (/mypurecloud\.com\/api\/v2\//i.test(response.url())) {
          const reqHeaders = response.request().headers();
          const auth = reqHeaders["authorization"] ?? reqHeaders["Authorization"];
          if (auth?.startsWith("Bearer ")) {
            const candidate = auth.slice(7).trim();
            if (candidate.length > 20) {
              capturedToken = candidate;
              tokenSource = "network-header";
            }
          }
        }
      } catch { /* cross-origin */ }
    });

    // ── Method 1C: OAuth URL fragment capture ─────────────────────────────────
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || capturedToken) return;
      const match = frame.url().match(/[#&]access_token=([^&]+)/i);
      if (match) {
        capturedToken = decodeURIComponent(match[1]);
        tokenSource = "url-fragment";
        console.log("[token] Captured from URL fragment.");
      }
    });

    // ── Step A: Navigate to fixed login URL ───────────────────────────────────
    console.log("[browser] Navigating to Genesys login...");
    await page.goto(STRICT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 3000));

    // ── Step A2: Click SSO button if needed ───────────────────────────────────
    if (/mypurecloud\.com/i.test(page.url()) && !capturedToken) {
      const ssoSelectors = [
        'button[data-provider-type="adv"]',
        'button[ng-click*="sso"]',
        'a[href*="microsoftonline"]',
        '[data-qa="adv-login-button"]',
        '[class*="sso"]',
        '[class*="microsoft"]',
      ];

      let clicked = false;
      for (const sel of ssoSelectors) {
        try {
          const el = await page.$(sel);
          if (el) { await el.click(); clicked = true; break; }
        } catch { /* try next */ }
      }

      if (!clicked) {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button, a")).find(
            (el) => /microsoft|single sign|sso|azure|entra/i.test((el as HTMLElement).textContent ?? "")
          ) as HTMLElement | undefined;
          btn?.click();
        });
      }

      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    }

    // ── Step B: Microsoft username ────────────────────────────────────────────
    if (!capturedToken) {
      try {
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 20_000 });
        await page.type('input[name="loginfmt"]', email, { delay: 60 });
        const nextBtn = await page.$('input[type="submit"], button[type="submit"], #idSIButton9');
        await nextBtn?.click();
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      } catch (e) {
        console.log("[browser] Username step:", (e as Error).message);
      }
    }

    // ── Step B2: Microsoft password ───────────────────────────────────────────
    if (!capturedToken) {
      try {
        await page.waitForSelector('input[name="passwd"]', { timeout: 20_000 });
        await page.type('input[name="passwd"]', password, { delay: 60 });
        const submitBtn = await page.$('input[type="submit"], button[type="submit"], #idSIButton9');
        await submitBtn?.click();
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
      } catch (e) {
        console.log("[browser] Password step:", (e as Error).message);
      }
    }

    // ── Step B3: "Stay signed in?" prompt ─────────────────────────────────────
    if (!capturedToken) {
      try {
        const yesBtn = await page.$("#idSIButton9");
        if (yesBtn) {
          await yesBtn.click();
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
        }
      } catch { /* prompt may not appear */ }
    }

    await new Promise((r) => setTimeout(r, 4000));

    // ── Method 2: Browser storage scan ───────────────────────────────────────
    let debugStorage = { localStorage: {} as Record<string, string>, sessionStorage: {} as Record<string, string> };

    if (!capturedToken) {
      const storageData = await page.evaluate(() => {
        const ls: Record<string, string> = {};
        const ss: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) ls[k] = localStorage.getItem(k) ?? "";
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k) ss[k] = sessionStorage.getItem(k) ?? "";
        }
        return { ls, ss };
      });

      debugStorage = { localStorage: storageData.ls, sessionStorage: storageData.ss };

      const TOKEN_KEYS = /access_token|token|auth_token|bearer/i;
      const allEntries = [...Object.entries(storageData.ls), ...Object.entries(storageData.ss)];

      for (const [key, value] of allEntries) {
        if (!value) continue;
        if (TOKEN_KEYS.test(key) && value.length > 20 && !value.startsWith("{")) {
          capturedToken = value;
          tokenSource = "storage";
          break;
        }
        if (value.startsWith("{") || value.startsWith("[")) {
          try {
            const findToken = (obj: unknown): string | null => {
              if (typeof obj === "object" && obj !== null) {
                for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
                  if (TOKEN_KEYS.test(k) && typeof v === "string" && v.length > 20) return v;
                  const nested = findToken(v);
                  if (nested) return nested;
                }
              }
              return null;
            };
            const found = findToken(JSON.parse(value));
            if (found) { capturedToken = found; tokenSource = "storage"; break; }
          } catch { /* not valid JSON */ }
        }
      }

      if (!capturedToken) {
        return { success: false, error: "Authentication completed but no Bearer token found.", debugStorage };
      }
    }

    // ── Success ───────────────────────────────────────────────────────────────
    setCachedToken(capturedToken);
    const expiresAt = Date.now() + TOKEN_TTL_MS;

    return {
      success: true,
      token: capturedToken,
      source: tokenSource,
      expiresAt,
      cachedUntil: new Date(expiresAt).toISOString(),
    };
  } finally {
    await browser.close();
  }
}
