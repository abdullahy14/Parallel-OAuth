/**
 * src/lib/browser-session.ts
 *
 * Interactive Browser Session with Chrome DevTools Protocol (CDP) Screencast.
 * Streams live JPEG frames from the browser session and accepts user mouse/keyboard input.
 *
 * Automatically monitors network and storage for the Genesys Cloud Bearer token.
 */

import puppeteer, { Browser, Page, CDPSession } from "puppeteer-core";
import { existsSync } from "fs";
import {
  STRICT_LOGIN_URL,
  TOKEN_TTL_MS,
  setCachedToken,
} from "./genesys-token";

export interface StreamEvent {
  type: "frame" | "token" | "error" | "status";
  data?: string; // base64 JPEG for frame, or status message
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

import { resolveBrowserExecutable } from "./detect-browser";

let currentSession: ActiveSession | null = null;

export async function startInteractiveSession(
  mode: "screencast" | "native" = "screencast",
  onEvent?: (event: StreamEvent) => void
): Promise<ActiveSession> {
  // If an existing session is running, close it first
  if (currentSession && !currentSession.isClosed) {
    try {
      await currentSession.close();
    } catch {
      // ignore
    }
    currentSession = null;
  }

  const { executablePath, browserName, isCloud, args: resolvedArgs, env: resolvedEnv } =
    await resolveBrowserExecutable();

  const width = 1080;
  const height = 720;
  // Cloud (Vercel/Lambda) does not have a display, so it must always run headless
  const isHeadless = isCloud || mode === "screencast";

  onEvent?.({
    type: "status",
    data: isCloud
      ? "Initializing cloud browser session on Vercel..."
      : `Launching ${browserName} (${mode === "screencast" ? "embedded stream" : "native window"})...`,
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
      if (currentSession === this) {
        currentSession = null;
      }
    },
  };

  currentSession = session;

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

    // Automatically close browser after brief delay so user sees success
    setTimeout(() => {
      session.close().catch(() => {});
    }, 1500);
  }

  // 1. Intercept Bearer tokens from outgoing requests to PureCloud
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

  // 3. Periodic storage inspector (every 2 seconds)
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
  }, 2000);

  browser.on("disconnected", () => {
    clearInterval(storageInterval);
    session.isClosed = true;
    if (currentSession === session) {
      currentSession = null;
    }
  });

  // Start Screencast if requested
  if (mode === "screencast") {
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
        // session might have ended
      }

      if (!session.isClosed) {
        session.onEvent?.({
          type: "frame",
          data,
        });
      }
    });
  }

  // Navigate to Genesys Cloud fixed login entry point
  session.onEvent?.({
    type: "status",
    data: "Navigating to Genesys Cloud...",
  });

  page.goto(STRICT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => {
    console.warn("[session] Page navigation notice:", (e as Error).message);
  });

  return session;
}

export function getCurrentSession(): ActiveSession | null {
  return currentSession && !currentSession.isClosed ? currentSession : null;
}
