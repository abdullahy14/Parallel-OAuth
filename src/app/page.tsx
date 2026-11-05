"use client";

import { useState, useEffect, useRef } from "react";

interface TokenPayload {
  success: true;
  token: string;
  source: string;
  expiresAt: number;
  cachedUntil: string;
}

export default function Home() {
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionMode, setSessionMode] = useState<"screencast" | "native">("screencast");
  const [statusMsg, setStatusMsg] = useState("Ready to launch live authentication session.");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [tokenData, setTokenData] = useState<TokenPayload | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Expiry countdown timer
  useEffect(() => {
    if (!tokenData) return;
    const updateCountdown = () => setTimeLeft(tokenData.expiresAt - Date.now());
    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [tokenData]);

  // Clean up SSE when unmounting
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  function startSession(mode: "screencast" | "native") {
    setSessionMode(mode);
    setSessionActive(true);
    setErrorMsg(null);
    setTokenData(null);
    setFrameSrc(null);
    setStatusMsg(mode === "screencast" ? "Starting live browser stream..." : "Launching Chrome window on desktop...");

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/stream?mode=${mode}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === "frame" && event.data) {
          const src = `data:image/jpeg;base64,${event.data}`;
          setFrameSrc(src);

          const canvas = canvasRef.current;
          if (canvas) {
            const ctx = canvas.getContext("2d");
            const img = new Image();
            img.onload = () => {
              canvas.width = img.width;
              canvas.height = img.height;
              ctx?.drawImage(img, 0, 0);
            };
            img.src = src;
          }
        } else if (event.type === "status") {
          setStatusMsg(event.data);
        } else if (event.type === "token" && event.tokenPayload) {
          setTokenData(event.tokenPayload);
          setSessionActive(false);
          es.close();

          // Broadcast to parent window if opened as popup
          if (typeof window !== "undefined" && window.opener) {
            window.opener.postMessage(
              {
                type: "GENESYS_AUTH_SUCCESS",
                data: event.tokenPayload,
              },
              "*"
            );
          }
        } else if (event.type === "error") {
          setErrorMsg(event.error ?? "Session failed.");
          setSessionActive(false);
          es.close();
        }
      } catch {
        // parsing error
      }
    };

    es.onerror = () => {
      if (!tokenData) {
        setStatusMsg("Connection closed.");
      }
      es.close();
    };
  }

  function stopSession() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setSessionActive(false);
    setStatusMsg("Session stopped.");
  }

  async function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    try {
      await fetch("/api/stream/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "click", x, y }),
      });
    } catch {
      // ignore
    }
  }

  async function handleCanvasKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    e.preventDefault();
    try {
      await fetch("/api/stream/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "key", key: e.key }),
      });
    } catch {
      // ignore
    }
  }

  async function handleCanvasWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    try {
      await fetch("/api/stream/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "scroll", deltaY: e.deltaY }),
      });
    } catch {
      // ignore
    }
  }

  async function handleCopyToken() {
    if (!tokenData) return;
    await navigator.clipboard.writeText(tokenData.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  async function handleCopyJson() {
    if (!tokenData) return;
    await navigator.clipboard.writeText(JSON.stringify(tokenData, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2500);
  }

  function formatCountdown(ms: number): string {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        padding: "30px 20px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e2e8f0",
      }}
    >
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 6px 0", color: "#60a5fa" }}>
          Genesys Cloud Live Authentication Portal
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: "#94a3b8" }}>
          Interactive session stream with automatic 12-hour OAuth token capture
        </p>
      </div>

      {/* SUCCESS STATE */}
      {tokenData && (
        <div
          style={{
            width: "100%",
            maxWidth: 640,
            background: "#0f172a",
            border: "1px solid #16a34a",
            borderRadius: 16,
            padding: 24,
            marginBottom: 24,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 24 }}>✅</span>
            <h2 style={{ fontSize: 18, margin: 0, color: "#4ade80" }}>
              Authentication Successful — Token Captured!
            </h2>
          </div>

          <div
            style={{
              background: "#080c18",
              border: "1px solid #1e293b",
              borderRadius: 8,
              padding: 12,
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Bearer Access Token:</div>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                color: "#7dd3fc",
                wordBreak: "break-all",
                maxHeight: 120,
                overflowY: "auto",
              }}
            >
              {showToken ? tokenData.token : `${tokenData.token.slice(0, 30)}••••••••••••••••••••••••••••••••`}
            </div>
            <button
              onClick={() => setShowToken(!showToken)}
              style={{
                background: "none",
                border: "none",
                color: "#38bdf8",
                cursor: "pointer",
                fontSize: 12,
                marginTop: 6,
                padding: 0,
              }}
            >
              {showToken ? "Hide full token" : "Reveal full token"}
            </button>
          </div>

          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16 }}>
            ⏱️ Active for <strong>12 hours</strong> · Expires in:{" "}
            <span style={{ color: "#facc15", fontWeight: "bold" }}>
              {timeLeft !== null ? formatCountdown(Math.max(0, timeLeft)) : "..."}
            </span>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <button
              onClick={handleCopyToken}
              style={{
                flex: 1,
                padding: "10px 16px",
                background: copied ? "#16a34a" : "#2563eb",
                border: "none",
                borderRadius: 8,
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {copied ? "✓ Copied Token!" : "Copy Bearer Token"}
            </button>

            <button
              onClick={handleCopyJson}
              style={{
                flex: 1,
                padding: "10px 16px",
                background: copiedJson ? "#16a34a" : "#1e293b",
                border: "1px solid #334155",
                borderRadius: 8,
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {copiedJson ? "✓ Copied JSON!" : "📋 Copy Full JSON"}
            </button>
          </div>

          <button
            onClick={() => setShowJson(!showJson)}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              fontSize: 12,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            {showJson ? "▲ Hide raw JSON payload" : "▼ Inspect raw JSON payload"}
          </button>

          {showJson && (
            <pre
              style={{
                background: "#05070e",
                border: "1px solid #1e293b",
                borderRadius: 8,
                padding: 12,
                fontSize: 11,
                color: "#93c5fd",
                overflowX: "auto",
                marginTop: 10,
              }}
            >
              {JSON.stringify(tokenData, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* ERROR STATE */}
      {errorMsg && (
        <div
          style={{
            maxWidth: 640,
            width: "100%",
            background: "#450a0a",
            border: "1px solid #ef4444",
            borderRadius: 12,
            padding: 14,
            marginBottom: 20,
            fontSize: 13,
            color: "#fca5a5",
          }}
        >
          ❌ {errorMsg}
        </div>
      )}

      {/* CONTROLS (When session is idle) */}
      {!sessionActive && (
        <div
          style={{
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
            justifyContent: "center",
            marginBottom: 20,
          }}
        >
          <button
            onClick={() => startSession("screencast")}
            style={{
              padding: "14px 24px",
              background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
              border: "none",
              borderRadius: 10,
              color: "#fff",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 4px 14px rgba(37, 99, 235, 0.4)",
            }}
          >
            📺 Open Live Stream Session (Edge / Island / Chrome / Cloud)
          </button>

          <button
            onClick={() => startSession("native")}
            style={{
              padding: "14px 24px",
              background: "#1e293b",
              border: "1px solid #334155",
              borderRadius: 10,
              color: "#e2e8f0",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🪟 Open Native Desktop Window (Edge / Island / Chrome)
          </button>
        </div>
      )}

      {/* ACTIVE SESSION BAR */}
      {sessionActive && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            maxWidth: 1080,
            background: "#1e293b",
            borderRadius: 10,
            padding: "10px 16px",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "#22c55e",
                display: "inline-block",
                boxShadow: "0 0 8px #22c55e",
              }}
            />
            <span style={{ fontSize: 13, color: "#94a3b8" }}>{statusMsg}</span>
          </div>

          <button
            onClick={stopSession}
            style={{
              padding: "6px 14px",
              background: "#ef4444",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            End Session
          </button>
        </div>
      )}

      {/* INTERACTIVE SCREENCAST CANVAS */}
      {sessionActive && sessionMode === "screencast" && (
        <div
          style={{
            position: "relative",
            width: "100%",
            maxWidth: 1080,
            background: "#020617",
            border: "2px solid #3b82f6",
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 20px 50px rgba(0,0,0,0.8)",
          }}
        >
          <div
            style={{
              background: "#0f172a",
              padding: "8px 14px",
              borderBottom: "1px solid #1e293b",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: "#64748b",
            }}
          >
            <span>🔒 https://login.mypurecloud.com/#/authenticate-adv/org/hellofresh</span>
            <span style={{ color: "#38bdf8" }}>Click canvas to focus & type credentials</span>
          </div>

          <canvas
            ref={canvasRef}
            tabIndex={0}
            onClick={handleCanvasClick}
            onKeyDown={handleCanvasKeyDown}
            onWheel={handleCanvasWheel}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              cursor: "pointer",
              outline: "none",
            }}
          />

          {!frameSrc && (
            <div
              style={{
                padding: "80px 20px",
                textAlign: "center",
                color: "#64748b",
                fontSize: 14,
              }}
            >
              ⏳ Connecting to browser session and streaming frames...
            </div>
          )}
        </div>
      )}

      {/* NATIVE MODE NOTICE */}
      {sessionActive && sessionMode === "native" && (
        <div
          style={{
            maxWidth: 640,
            width: "100%",
            background: "#0f172a",
            border: "1px solid #334155",
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 12 }}>🪟</div>
          <h3 style={{ fontSize: 16, margin: "0 0 8px 0" }}>Chrome Window Open on Your Desktop</h3>
          <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6 }}>
            A visible Chrome window has opened at the Genesys Cloud login page. Complete your Microsoft SSO sign-in there.
            <br />
            As soon as you sign in, the window will automatically close and your 12-hour token will appear right here.
          </p>
        </div>
      )}
    </main>
  );
}
