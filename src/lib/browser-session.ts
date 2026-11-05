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

  // Helper to attach interceptors to any page (including popups/new tabs)
  function attachPageListeners(p: Page) {
    p.on("request", (req) => {
      if (capturedToken) return;
      const auth = req.headers()["authorization"] ?? req.headers()["Authorization"];
      if (auth?.startsWith("Bearer ")) {
        const candidate = auth.slice(7).trim();
        if (candidate.length > 20) {
          onTokenFound(candidate, "network-header");
        }
      }
    });

    p.on("framenavigated", (frame) => {
      if (capturedToken) return;
      const url = frame.url();
      const match = url.match(/[#&]access_token=([^&]+)/i);
      if (match) {
        onTokenFound(decodeURIComponent(match[1]), "url-fragment");
      }
    });
  }

  // Attach to initial page
  attachPageListeners(page);

  // Attach to any new tab or popup opened by the browser
  browser.on("targetcreated", async (target) => {
    if (capturedToken) return;
    try {
      const newPage = await target.page();
      if (!newPage) return;
      attachPageListeners(newPage);
    } catch {
      // ignore
    }
  });

  // 3. Periodic storage inspector (inspects all open pages and cookies)
  const storageInterval = setInterval(async () => {
    if (capturedToken || session.isClosed) {
      clearInterval(storageInterval);
      return;
    }
    try {
      const pages = await browser.pages();
      for (const p of pages) {
        if (capturedToken) break;

        const url = p.url();
        const match = url.match(/[#&]access_token=([^&]+)/i);
        if (match) {
          onTokenFound(decodeURIComponent(match[1]), "url-fragment");
          break;
        }

        const token = await p.evaluate(() => {
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
        }).catch(() => null);

        if (token) {
          onTokenFound(token, "storage");
          break;
        }
      }

      if (!capturedToken) {
        const cookies = await page.cookies();
        for (const c of cookies) {
          if (/inin.*auth.*token|access_token/i.test(c.name) && c.value.length > 25) {
            if (!c.value.startsWith("{") && !c.value.includes("%7B")) {
              onTokenFound(c.value, `cookie:${c.name}`);
              break;
            }
          }
        }
      }
    } catch {
      // frame might be navigating
    }
  }, 1000);

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
          const emailSelector = 'input[name="loginfmt"], #i0116';
          await page.waitForSelector(emailSelector, { visible: true, timeout: 20_000 });
          session.onEvent?.({
            type: "status",
            data: `Entering email: ${email}...`,
          });
          const emailInput = await page.$(emailSelector);
          if (emailInput) {
            await emailInput.focus();
            await page.evaluate((sel) => {
              const el = document.querySelector(sel) as HTMLInputElement;
              if (el) {
                el.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, emailSelector);
            await emailInput.type(email, { delay: 40 });
            await new Promise((r) => setTimeout(r, 400));
            const nextBtn = await page.$('input[type="submit"], button[type="submit"], #idSIButton9');
            if (nextBtn) {
              await nextBtn.click();
            } else {
              await page.keyboard.press("Enter");
            }
          }
        } catch (e) {
          console.warn("[session] Email step notice:", (e as Error).message);
        }
      }

      // Step C: Enter password if provided
      if (password && !capturedToken) {
        try {
          session.onEvent?.({
            type: "status",
            data: "Waiting for password field to appear...",
          });

          const passSelector = 'input[type="password"], input[name="passwd"], #i0118, #passwordInput';

          // 1. Wait until password input is mounted, visible, and has positive layout dimensions
          await page.waitForFunction((sel) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              rect.width > 0 &&
              rect.height > 0
            );
          }, { timeout: 25_000 }, passSelector);

          // 2. Wait for Microsoft slide transition (.slide-in-next) and Knockout.js model bindings to settle
          await new Promise((r) => setTimeout(r, 1200));

          const passEl = await page.$(passSelector);
          if (passEl) {
            session.onEvent?.({
              type: "status",
              data: "Entering password...",
            });

            await passEl.focus();
            await passEl.click();
            await new Promise((r) => setTimeout(r, 300));

            // Clear any autofill or existing content
            await page.evaluate((sel) => {
              const el = document.querySelector(sel) as HTMLInputElement;
              if (el) {
                el.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, passSelector);
            await new Promise((r) => setTimeout(r, 200));

            // Type with realistic delay
            await passEl.type(password, { delay: 50 });
            await new Promise((r) => setTimeout(r, 300));

            // Force Knockout observable / React state to accept the value and events
            await page.evaluate((sel, pwd) => {
              const el = document.querySelector(sel) as HTMLInputElement;
              if (el) {
                if (!el.value || el.value.length === 0) {
                  el.value = pwd;
                }
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
              }
            }, passSelector, password);

            await new Promise((r) => setTimeout(r, 400));

            // Click Sign in or press Enter
            const submitBtn = await page.$(
              'input[type="submit"], button[type="submit"], #idSIButton9, input[value="Sign in"]'
            );
            if (submitBtn) {
              await submitBtn.click();
            } else {
              await page.keyboard.press("Enter");
            }

            session.onEvent?.({
              type: "status",
              data: "Credentials submitted — checking verification / 2FA...",
            });

            // 3. Retry guard: Check after 1.8 seconds if "Please enter your password" appears
            await new Promise((r) => setTimeout(r, 1800));
            const hasError = await page.evaluate(() => {
              const text = document.body.innerText || "";
              return /please enter your password/i.test(text);
            });

            if (hasError && !capturedToken) {
              session.onEvent?.({
                type: "status",
                data: "Retrying password submission...",
              });
              await page.evaluate((sel, pwd) => {
                const el = document.querySelector(sel) as HTMLInputElement;
                if (el) {
                  el.focus();
                  el.value = pwd;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                }
                const btn = document.querySelector('input[type="submit"], button[type="submit"], #idSIButton9') as HTMLElement;
                if (btn) btn.click();
              }, passSelector, password);
            }
          }
        } catch (e) {
          console.warn("[session] Password step notice:", (e as Error).message);
        }
      }

      // Step D: Watch for 2FA, KMSI (Stay signed in), or redirect back to Genesys
      const postAuthStartTime = Date.now();
      while (!capturedToken && !session.isClosed && (Date.now() - postAuthStartTime < 55_000)) {
        try {
          const pageState = await page.evaluate(() => {
            const text = document.body.innerText || "";
            const url = window.location.href;

            const isKmsi = /stay signed in/i.test(text) || /kmsi/i.test(url);
            const signEl = document.querySelector(
              "#idRichContext_DisplaySign, .display-sign-in-number, [data-test-id='number-matching']"
            );
            const numberMatch = signEl?.textContent?.trim() || null;
            const isPush2fa = /approve a request|check your|open your authenticator/i.test(text);

            return { isKmsi, numberMatch, isPush2fa, url };
          });

          if (pageState.isKmsi) {
            session.onEvent?.({
              type: "status",
              data: "Accepting 'Stay signed in'...",
            });
            const yesBtn = await page.$('#idSIButton9, input[value="Yes"]');
            if (yesBtn) {
              await yesBtn.click();
              await new Promise((r) => setTimeout(r, 2000));
            }
          } else if (pageState.numberMatch) {
            session.onEvent?.({
              type: "status",
              data: `Approve 2FA on phone: Enter number "${pageState.numberMatch}" in Authenticator app!`,
            });
          } else if (pageState.isPush2fa) {
            session.onEvent?.({
              type: "status",
              data: "Approve the sign-in notification on your Microsoft Authenticator app...",
            });
          } else if (pageState.url.includes("purecloud.com")) {
            session.onEvent?.({
              type: "status",
              data: "Returned to Genesys Cloud — capturing Bearer access token...",
            });

            // 1. Inspect cookies for auth tokens
            try {
              const cookies = await page.cookies();
              for (const c of cookies) {
                if (/inin.*auth.*token|access_token|auth_token|inin-session/i.test(c.name) && c.value.length > 25) {
                  if (!c.value.startsWith("{") && !c.value.includes("%7B")) {
                    onTokenFound(c.value, `cookie:${c.name}`);
                    break;
                  }
                }
              }
            } catch {
              // ignore
            }

            // 2. Click Collaborate / Communicate or navigate directly to Collaborate app
            if (!capturedToken) {
              const clickedApp = await page.evaluate(() => {
                document.querySelectorAll("a").forEach((a) => a.removeAttribute("target"));
                window.open = function(url?: string | URL) {
                  if (url) window.location.href = url.toString();
                  return window;
                };

                const elements = Array.from(document.querySelectorAll("a, button, div, span, [role='button']")) as HTMLElement[];
                const card = elements.find((el) => {
                  const text = (el.textContent || "").trim();
                  return /collaborate\s*\/?\s*communicate/i.test(text);
                });
                if (card) {
                  const clickable = card.closest("a, button, [role='button']") as HTMLElement || card;
                  clickable.click();
                  return true;
                }
                return false;
              }).catch(() => false);

              if (clickedApp) {
                session.onEvent?.({
                  type: "status",
                  data: "Launching Collaborate app to extract OAuth Bearer token...",
                });
                await new Promise((r) => setTimeout(r, 1500));
              }

              // Direct navigation fallback: navigate straight to Collaborate directory
              if (!capturedToken && page.url().includes("login.mypurecloud.com")) {
                session.onEvent?.({
                  type: "status",
                  data: "Navigating to Collaborate app to retrieve OAuth token...",
                });
                await page.goto("https://apps.mypurecloud.com/directory/#/", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
                await new Promise((r) => setTimeout(r, 1500));
              }
            }
          }
        } catch {
          // page may be navigating
        }

        await new Promise((r) => setTimeout(r, 1500));
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
