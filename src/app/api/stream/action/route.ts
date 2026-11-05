/**
 * /api/stream/action — Dispatches user clicks and keystrokes into the active browser session
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/browser-session";

export async function POST(req: NextRequest) {
  const session = getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "No active browser session found." }, { status: 404 });
  }

  let body: {
    type?: "click" | "key" | "scroll";
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

  const { client } = session;

  try {
    if (body.type === "click" && typeof body.x === "number" && typeof body.y === "number") {
      const x = Math.round(body.x);
      const y = Math.round(body.y);

      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });

      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
      });

      return NextResponse.json({ success: true });
    }

    if (body.type === "key" && body.key) {
      const key = body.key;
      const text = body.text ?? (key.length === 1 ? key : undefined);

      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        text,
        unmodifiedText: text,
      });

      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
      });

      return NextResponse.json({ success: true });
    }

    if (body.type === "scroll" && typeof body.deltaY === "number") {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: body.x ?? session.width / 2,
        y: body.y ?? session.height / 2,
        deltaX: 0,
        deltaY: body.deltaY,
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
