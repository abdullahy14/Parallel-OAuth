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

  const { executablePath, args, env } = await resolveBrowserExecutable();

  return puppeteer.launch({
    args,
    env,
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
  source: "cache" | "network-header" | "url-fragment" | "storage" | (string & {});
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
  const cached = getCachedToken();
  const expiry = getCacheExpiry();
  if (cached && expiry) {
    return {
      success: true,
      token: cached,
      source: "cache",
      expiresAt: expiry,
      cachedUntil: new Date(expiry).toISOString(),
    };
  }

  const { startInteractiveSession } = await import("./browser-session");

  return new Promise<TokenResponse>((resolve) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({
          success: false,
          error: "Session timed out before token could be captured.",
        });
      }
    }, 55_000);

    startInteractiveSession(
      "headless",
      { email, password },
      (event) => {
        if (settled) return;
        if (event.type === "token" && event.tokenPayload) {
          settled = true;
          clearTimeout(timeout);
          resolve(event.tokenPayload);
        } else if (event.type === "error") {
          settled = true;
          clearTimeout(timeout);
          resolve({
            success: false,
            error: event.error ?? "Authentication failed",
          });
        }
      }
    ).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          success: false,
          error: (err as Error).message,
        });
      }
    });
  });
}
