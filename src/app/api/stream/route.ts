/**
 * /api/stream — Live browser session screencast (SSE)
 *
 * Opens a local browser session and streams live video frames to the frontend
 * so the user can see and interact with Microsoft SSO directly.
 */

import { NextRequest } from "next/server";
import { startInteractiveSession, StreamEvent } from "@/lib/browser-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const mode = (req.nextUrl.searchParams.get("mode") as "screencast" | "native") || "screencast";

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
        const session = await startInteractiveSession(mode, sendEvent);

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
