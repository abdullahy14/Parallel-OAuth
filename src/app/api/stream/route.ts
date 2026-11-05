/**
 * /api/stream — Live browser session screencast (SSE) & Direct Input Actions
 *
 * Handling both GET (SSE Stream) and POST (Actions) in the same file ensures
 * they are bundled into the same Lambda function on Vercel.
 */

import { NextRequest, NextResponse } from "next/server";
import { startInteractiveSession, getCurrentSession, StreamEvent } from "@/lib/browser-session";
import { getCachedToken, getCacheExpiry } from "@/lib/genesys-token";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("checkToken") === "true") {
    const cached = getCachedToken();
    const expiry = getCacheExpiry();
    if (cached && expiry) {
      return NextResponse.json({
        success: true,
        token: cached,
        source: "cache",
        expiresAt: expiry,
        cachedUntil: new Date(expiry).toISOString(),
      });
    }
    return NextResponse.json({ error: "No cached token found" }, { status: 404 });
  }

  const mode = (req.nextUrl.searchParams.get("mode") as "screencast" | "native" | "headless") || "headless";
  const email = req.nextUrl.searchParams.get("email") || undefined;
  const password = req.nextUrl.searchParams.get("password") || undefined;

  const encoder = new TextEncoder();
  let sessionClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: StreamEvent) {
        if (sessionClosed) return;
        try {
          const payload = JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));

          if (event.type === "token") {
            sessionClosed = true;
            setTimeout(() => {
              try {
                controller.close();
              } catch {
                // ignore
              }
            }, 500);
          }
        } catch {
          // stream might be closed
        }
      }

      try {
        const session = await startInteractiveSession(
          mode,
          { email, password },
          sendEvent
        );

        req.signal.addEventListener("abort", () => {
          sessionClosed = true;
          session.close().catch(() => {});
        });
      } catch (err) {
        sendEvent({
          type: "error",
          error: (err as Error).message,
        });
        controller.close();
      }
    },
    cancel() {
      sessionClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(req: NextRequest) {
  const session = getCurrentSession();
  if (!session) {
    return NextResponse.json(
      { error: "No active browser session found on this instance." },
      { status: 404 }
    );
  }

  let body: {
    type?: "click" | "key" | "typeText" | "pressKey" | "auto-sso" | "submitPassword" | "launchApp";
    x?: number;
    y?: number;
    key?: string;
    text?: string;
    password?: string;
  } = {};

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { page, client } = session;

  try {
    // ── 1. SUBMIT PASSWORD DIRECTLY ──────────────────────────────────────────
    if (body.type === "submitPassword" && body.password) {
      const passSelector = 'input[type="password"], input[name="passwd"], #i0118, #passwordInput';
      const passEl = await page.$(passSelector);
      if (passEl) {
        await passEl.focus();
        await new Promise((r) => setTimeout(r, 200));

        // Clear existing value
        await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLInputElement;
          if (el) el.value = "";
        }, passSelector);

        await passEl.type(body.password, { delay: 40 });
        await new Promise((r) => setTimeout(r, 400));

        const submitBtn = await page.$(
          'input[type="submit"], button[type="submit"], #idSIButton9, input[value="Sign in"]'
        );
        if (submitBtn) {
          await submitBtn.click();
        } else {
          await page.keyboard.press("Enter");
        }

        return NextResponse.json({ success: true, action: "submitPassword" });
      } else {
        // Fallback to active focused element
        await page.keyboard.type(body.password, { delay: 40 });
        await page.keyboard.press("Enter");
        return NextResponse.json({ success: true, action: "submitPassword-fallback" });
      }
    }

    // ── 2. TYPE TEXT INTO ACTIVE/TARGET FIELD ─────────────────────────────────
    if (body.type === "typeText" && typeof body.text === "string") {
      const passSelector = 'input[type="password"], input[name="passwd"], #i0118, #passwordInput, input:focus';
      const targetEl = await page.$(passSelector);
      if (targetEl) {
        await targetEl.focus();
        await new Promise((r) => setTimeout(r, 200));
        await targetEl.type(body.text, { delay: 30 });
      } else {
        await page.keyboard.type(body.text, { delay: 30 });
      }
      return NextResponse.json({ success: true, action: "typeText" });
    }

    // ── 3. SINGLE KEY PRESS (Enter, Tab) ──────────────────────────────────────
    if (body.type === "pressKey" && body.key) {
      if (body.key === "Enter") {
        const submitBtn = await page.$(
          'input[type="submit"], button[type="submit"], #idSIButton9, input[value="Sign in"]'
        );
        if (submitBtn) {
          await submitBtn.click();
        } else {
          await page.keyboard.press("Enter");
        }
      } else {
        await page.keyboard.press(body.key as any);
      }
      return NextResponse.json({ success: true, action: "pressKey", key: body.key });
    }

    // ── 4. MOUSE CLICK ────────────────────────────────────────────────────────
    if (body.type === "click" && typeof body.x === "number" && typeof body.y === "number") {
      const x = Math.round(body.x);
      const y = Math.round(body.y);

      try {
        await page.mouse.click(x, y, { delay: 60 });
      } catch {
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 60));
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          buttons: 0,
        });
      }
      return NextResponse.json({ success: true, action: "click", x, y });
    }

    // ── 5. AUTO SSO BUTTON CLICK ──────────────────────────────────────────────
    if (body.type === "auto-sso") {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
        const sso = buttons.find(
          (el) =>
            /microsoft|single sign|sso|azure|entra/i.test(el.textContent ?? "") ||
            /microsoft|sso|adv/i.test(el.className)
        );
        if (sso) {
          sso.click();
          return true;
        }
        return false;
      });

      return NextResponse.json({ success: true, action: "auto-sso", clicked });
    }

    // ── 6. LAUNCH COLLABORATE / COMMUNICATE APP ────────────────────────────────
    if (body.type === "launchApp") {
      const clicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("a, button, div, [role='button']")) as HTMLElement[];
        const card = elements.find((el) => /collaborate\s*\/?\s*communicate/i.test(el.textContent || ""));
        if (card) {
          const clickable = card.closest("a, button, [role='button']") as HTMLElement || card;
          clickable.click();
          return true;
        }
        return false;
      });
      if (!clicked) {
        await page.goto("https://apps.mypurecloud.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      return NextResponse.json({ success: true, action: "launchApp", clicked });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
