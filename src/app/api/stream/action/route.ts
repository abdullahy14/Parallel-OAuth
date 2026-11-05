/**
 * /api/stream/action — Dispatches user clicks, keystrokes, and helper actions
 * into the active browser session.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/browser-session";

export async function POST(req: NextRequest) {
  const session = getCurrentSession();
  if (!session) {
    return NextResponse.json(
      { error: "No active browser session found on this instance." },
      { status: 404 }
    );
  }

  let body: {
    type?: "click" | "key" | "typeText" | "pressKey" | "scroll" | "auto-sso";
    x?: number;
    y?: number;
    key?: string;
    text?: string;
    deltaY?: number;
  } = {};

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { client, page } = session;

  try {
    // ── 1. MOUSE CLICK ────────────────────────────────────────────────────────
    if (body.type === "click" && typeof body.x === "number" && typeof body.y === "number") {
      const x = Math.round(body.x);
      const y = Math.round(body.y);

      try {
        // High-level Puppeteer click (handles move, down, delay, up, and focus)
        await page.mouse.click(x, y, { delay: 60 });
      } catch {
        // Fallback: direct CDP mouse event dispatch
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
        });

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

    // ── 2. FULL TEXT TYPING (Email / Password) ───────────────────────────────
    if (body.type === "typeText" && typeof body.text === "string") {
      await page.keyboard.type(body.text, { delay: 30 });
      return NextResponse.json({ success: true, action: "typeText" });
    }

    // ── 3. SINGLE KEY PRESS (Enter, Tab, Backspace) ──────────────────────────
    if (body.type === "pressKey" && body.key) {
      await page.keyboard.press(body.key as any);
      return NextResponse.json({ success: true, action: "pressKey", key: body.key });
    }

    // ── 4. AUTO-CLICK SSO BUTTON HELPER ──────────────────────────────────────
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

    // ── 5. INDIVIDUAL KEY EVENT (Keystroke forwarding) ───────────────────────
    if (body.type === "key" && body.key) {
      const key = body.key;
      const text = body.text ?? (key.length === 1 ? key : undefined);

      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        text,
        unmodifiedText: text,
      });

      if (text) {
        await client.send("Input.dispatchKeyEvent", {
          type: "char",
          text,
          unmodifiedText: text,
          key,
        });
      }

      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
      });

      return NextResponse.json({ success: true, action: "key", key });
    }

    // ── 6. SCROLL ────────────────────────────────────────────────────────────
    if (body.type === "scroll" && typeof body.deltaY === "number") {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: body.x ?? session.width / 2,
        y: body.y ?? session.height / 2,
        deltaX: 0,
        deltaY: body.deltaY,
      });

      return NextResponse.json({ success: true, action: "scroll" });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
