/**
 * src/lib/browser-session.ts
 *
 * Interactive Cloud Browser Session with Chrome DevTools Protocol (CDP) Screencast.
 * Streams live JPEG frames to the frontend while automatically driving the
 * Genesys Cloud + Microsoft Entra ID SSO workflow.
 */

import puppeteer, { Browser, Page, CDPSession } from "puppeteer-core";
import { existsSync } from "fs";
import {
  STRICT_LOGIN_URL,
  TOKEN_TTL_MS,
  setCachedToken,
} from "./genesys-token";
import { resolveBrowserExecutable } from "./detect-browser";

export interface StreamEvent {
  type: "frame" | "token" | "error" | "status";
  data?: string;
  tokenPayload?: {
    success: true;
    token: string;
    source: string;
    expiresAt: number;
    cachedUntil: string;
  };
  error?: string;
}

export interface ActiveSession {
  browser: Browser;
  page: Page;
  client: CDPSession;
  width: number;
  height: number;
  isClosed: boolean;
  onEvent?: (event: StreamEvent) => void;
  close: () => Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __genesys_browser_session: ActiveSession | null | undefined;
}

export async function startInteractiveSession(
  mode: "screencast" | "native" = "screencast",
  credentials?: { email?: string; password?: string },
  onEvent?: (event: StreamEvent) => void
): Promise<ActiveSession> {
  // If an existing session is running, close it first
  if (globalThis.__genesys_browser_session && !globalThis.__genesys_browser_session.isClosed) {
    try {
      await globalThis.__genesys_browser_session.close();
    } catch {
      // ignore
    }
    globalThis.__genesys_browser_session = null;
  }

  const { executablePath, browserName, isCloud, args: resolvedArgs, env: resolvedEnv } =
    await resolveBrowserExecutable();

  const width = 1080;
  const height = 720;
  const isHeadless = isCloud || mode === "screencast";

  onEvent?.({
    type: "status",
    data: isCloud
      ? "Initializing cloud browser session on Vercel..."
      : `Launching ${browserName} session...`,
  });

  const launchArgs = [
    ...resolvedArgs,
    `--window-size=${width},${height}`,
  ];

  const browser = await puppeteer.launch({
    executablePath,
    headless: isHeadless,
    defaultViewport: { width, height },
    args: launchArgs,
    env: resolvedEnv,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width, height });

  const client = await page.createCDPSession();

  let capturedToken: string | null = null;
  let tokenSource = "network-header";

  const session: ActiveSession = {
    browser,
    page,
    client,
    width,
    height,
    isClosed: false,
    onEvent,
    async close() {
      if (this.isClosed) return;
      this.isClosed = true;
      try {
        await browser.close();
      } catch {
        // ignore
      }
      if (globalThis.__genesys_browser_session === this) {
        globalThis.__genesys_browser_session = null;
      }
    },
  };

  globalThis.__genesys_browser_session = session;

  function onTokenFound(token: string, source: string) {
    if (capturedToken || session.isClosed) return;
    capturedToken = token;
    tokenSource = source;

    setCachedToken(token);
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const tokenPayload = {
      success: true as const,
      token,
      source,
      expiresAt,
      cachedUntil: new Date(expiresAt).toISOString(),
    };

    console.log(`[session] Token captured via ${source}!`);
    session.onEvent?.({
      type: "token",
      tokenPayload,
    });

    setTimeout(() => {
      session.close().catch(() => {});
    }, 1500);
  }

  // 1. Intercept Bearer tokens from outgoing requests
  page.on("request", (req) => {
    if (capturedToken) return;
    const auth = req.headers()["authorization"] ?? req.headers()["Authorization"];
    if (auth?.startsWith("Bearer ")) {
      const candidate = auth.slice(7).trim();
      if (candidate.length > 20) {
        onTokenFound(candidate, "network-header");
      }
    }
  });

  // 2. Intercept OAuth URL fragment tokens (#access_token=...)
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame() || capturedToken) return;
    const url = frame.url();
    const match = url.match(/[#&]access_token=([^&]+)/i);
    if (match) {
      onTokenFound(decodeURIComponent(match[1]), "url-fragment");
    }
  });

  // 3. Periodic storage inspector
  const storageInterval = setInterval(async () => {
    if (capturedToken || session.isClosed) {
      clearInterval(storageInterval);
      return;
    }
    try {
      const token = await page.evaluate(() => {
        const TOKEN_KEYS = /access_token|auth_token|token/i;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && TOKEN_KEYS.test(k)) {
            const v = localStorage.getItem(k);
            if (v && v.length > 20 && !v.startsWith("{")) return v;
          }
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && TOKEN_KEYS.test(k)) {
            const v = sessionStorage.getItem(k);
            if (v && v.length > 20 && !v.startsWith("{")) return v;
          }
        }
        return null;
      });

      if (token) {
        onTokenFound(token, "storage");
      }
    } catch {
      // frame might be navigating
    }
  }, 1500);

  browser.on("disconnected", () => {
    clearInterval(storageInterval);
    session.isClosed = true;
    if (globalThis.__genesys_browser_session === session) {
      globalThis.__genesys_browser_session = null;
    }
  });

  // Start Screencast
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: 75,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });

  client.on("Page.screencastFrame", async ({ data, sessionId }) => {
    try {
      await client.send("Page.screencastFrameAck", { sessionId });
    } catch {
      // ignore
    }

    if (!session.isClosed) {
      session.onEvent?.({
        type: "frame",
        data,
      });
    }
  });

  // ── Automated SSO & Navigation Workflow ───────────────────────────────────
  (async () => {
    try {
      session.onEvent?.({
        type: "status",
        data: "Opening Genesys Cloud login page...",
      });

      await page.goto(STRICT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 40_000 });
      await new Promise((r) => setTimeout(r, 2500));

      // Step A: Detect and automatically click the Microsoft SSO button
      if (!capturedToken) {
        session.onEvent?.({
          type: "status",
          data: "Clicking Microsoft SSO button...",
        });

        const ssoClicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
          const sso = buttons.find(
            (el) =>
              /microsoft|single sign|sso|azure|entra/i.test(el.textContent ?? "") ||
              /microsoft|sso|adv/i.test(el.className) ||
              el.getAttribute("data-provider-type") === "adv"
          );
          if (sso) {
            sso.click();
            return true;
          }
          return false;
        });

        if (ssoClicked) {
          session.onEvent?.({
            type: "status",
            data: "Redirecting to Microsoft Entra ID...",
          });
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
        }
      }

      const email = credentials?.email || process.env.GENESIS_USER_EMAIL;
      const password = credentials?.password || process.env.GENESIS_USER_PASSWORD;

      // Step B: Enter email if provided
      if (email && !capturedToken) {
        try {
          await page.waitForSelector('input[name="loginfmt"]', { timeout: 15_000 });
          session.onEvent?.({
            type: "status",
            data: `Entering email: ${email}...`,
          });
          await page.type('input[name="loginfmt"]', email, { delay: 40 });
          const nextBtn = await page.$('input[type="submit"], button[type="submit"], #idSIButton9');
          await nextBtn?.click();
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
        } catch (e) {
          console.warn("[session] Email step notice:", (e as Error).message);
        }
      }

      // Step C: Enter password if provided
      if (password && !capturedToken) {
        try {
          await page.waitForSelector('input[name="passwd"]', { timeout: 15_000 });
          session.onEvent?.({
            type: "status",
            data: "Entering password...",
          });
          await page.type('input[name="passwd"]', password, { delay: 40 });
          const submitBtn = await page.$('input[type="submit"], button[type="submit"], #idSIButton9');
          await submitBtn?.click();
          session.onEvent?.({
            type: "status",
            data: "Submitting credentials — approve 2FA on your phone if prompted...",
          });
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        } catch (e) {
          console.warn("[session] Password step notice:", (e as Error).message);
        }
      }

      // Step D: Handle "Stay signed in?" prompt
      if (!capturedToken) {
        try {
          const yesBtn = await page.$("#idSIButton9");
          if (yesBtn) {
            await yesBtn.click();
            await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
          }
        } catch {
          // ignore
        }
      }

      if (!capturedToken) {
        session.onEvent?.({
          type: "status",
          data: "Awaiting authentication completion...",
        });
      }
    } catch (err) {
      console.warn("[session] Automation flow notice:", (err as Error).message);
    }
  })();

  return session;
}

export function getCurrentSession(): ActiveSession | null {
  return globalThis.__genesys_browser_session && !globalThis.__genesys_browser_session.isClosed
    ? globalThis.__genesys_browser_session
    : null;
}
