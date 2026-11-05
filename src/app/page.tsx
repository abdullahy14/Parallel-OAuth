"use client";

import { useState, useEffect, useRef } from "react";

interface TokenPayload {
  success: true;
  token: string;
  source: string;
  expiresAt: number;
  cachedUntil: string;
}

interface ClickFeedback {
  x: number;
  y: number;
  id: number;
}

export default function Home() {
  const [sessionActive, setSessionActive] = useState(false);
  const [statusMsg, setStatusMsg] = useState("Ready to launch cloud authentication session.");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [tokenData, setTokenData] = useState<TokenPayload | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [showToken, setShowToken] = useState(true);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [quickText, setQuickText] = useState("");
  const [clickIndicator, setClickIndicator] = useState<ClickFeedback | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const screenContainerRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Restore token from localStorage or backend cache on page load
  useEffect(() => {
    try {
      const saved = localStorage.getItem("genesys_captured_token");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.expiresAt > Date.now()) {
          setTokenData(parsed);
          return;
        }
      }
    } catch {}

    fetch("/api/stream?checkToken=true")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.success && data.token) {
          setTokenData(data);
          try {
            localStorage.setItem("genesys_captured_token", JSON.stringify(data));
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

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

  function startSession(emailOverride?: string, passwordOverride?: string) {
    setSessionActive(true);
    setErrorMsg(null);
    setFrameSrc(null);
    setActionStatus(null);
    setStatusMsg("Booting cloud browser session on Vercel...");

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const emailParam = emailOverride ?? authEmail;
    const passwordParam = passwordOverride ?? authPassword;

    let url = "/api/stream?mode=screencast";
    if (emailParam) url += `&email=${encodeURIComponent(emailParam)}`;
    if (passwordParam) url += `&password=${encodeURIComponent(passwordParam)}`;

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === "frame" && event.data) {
          setFrameSrc(`data:image/jpeg;base64,${event.data}`);
        } else if (event.type === "status") {
          setStatusMsg(event.data);
        } else if (event.type === "token" && event.tokenPayload) {
          setTokenData(event.tokenPayload);
          try {
            localStorage.setItem("genesys_captured_token", JSON.stringify(event.tokenPayload));
          } catch {}
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
      fetch("/api/stream?checkToken=true")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && data.success && data.token) {
            setTokenData(data);
            try {
              localStorage.setItem("genesys_captured_token", JSON.stringify(data));
            } catch {}
            setSessionActive(false);
          } else if (!tokenData) {
            setStatusMsg("Session ended. Re-launch if authentication was not finished.");
          }
        })
        .catch(() => {
          if (!tokenData) setStatusMsg("Session ended.");
        });
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

  async function handleScreenClick(e: React.MouseEvent<HTMLDivElement>) {
    const container = screenContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const percentX = (e.clientX - rect.left) / rect.width;
    const percentY = (e.clientY - rect.top) / rect.height;

    // Fixed browser resolution configured in backend
    const x = Math.round(percentX * 1080);
    const y = Math.round(percentY * 720);

    // Show visual click ripple indicator
    setClickIndicator({ x: e.clientX - rect.left, y: e.clientY - rect.top, id: Date.now() });
    setTimeout(() => setClickIndicator(null), 600);

    try {
      setActionStatus(`Clicking at (${x}, ${y})...`);
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "click", x, y }),
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus(`Click registered at (${x}, ${y})`);
      } else {
        setActionStatus(`Notice: ${data.error ?? "Click error"}`);
      }
    } catch {
      setActionStatus("Network error sending click");
    }
  }

  async function handleSendQuickText(e: React.FormEvent) {
    e.preventDefault();
    if (!quickText) return;

    try {
      setActionStatus(`Typing text into active field...`);
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "typeText", text: quickText }),
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus(`Typed "${quickText.length > 10 ? quickText.slice(0, 10) + '...' : quickText}"`);
        setQuickText("");
      }
    } catch {
      setActionStatus("Failed to send text");
    }
  }

  async function handleDirectSubmitPassword(pwd?: string) {
    const targetPassword = pwd || authPassword || quickText;
    if (!targetPassword) {
      setActionStatus("Please enter password above or in the input box first.");
      return;
    }

    try {
      setActionStatus("Submitting password into browser session...");
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "submitPassword", password: targetPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus("✓ Password entered & submitted!");
        setQuickText("");
      } else {
        setActionStatus(`Notice: ${data.error ?? "Password submit error"}`);
      }
    } catch {
      setActionStatus("Failed to submit password");
    }
  }

  async function handleSendKey(key: string) {
    try {
      setActionStatus(`Pressing ${key}...`);
      await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "pressKey", key }),
      });
      setActionStatus(`Pressed ${key}`);
    } catch {
      setActionStatus(`Failed to press ${key}`);
    }
  }

  async function handleAutoSso() {
    try {
      setActionStatus("Looking for Microsoft / SSO button on page...");
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "auto-sso" }),
      });
      const data = await res.json();
      if (data.clicked) {
        setActionStatus("✓ Clicked Microsoft SSO button successfully!");
      } else {
        setActionStatus("SSO button not found yet (page might still be loading)");
      }
    } catch {
      setActionStatus("Failed to trigger Auto SSO");
    }
  }

  async function handleLaunchApp() {
    try {
      setActionStatus("Launching Collaborate / Communicate app...");
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "launchApp" }),
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus("✓ Launching Collaborate app...");
      } else {
        setActionStatus(`Notice: ${data.error ?? "Failed to launch app"}`);
      }
    } catch {
      setActionStatus("Network error launching app");
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
          Cloud session stream with interactive clicks and automatic 12-hour OAuth token capture
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
              border: "1px solid #16a34a",
              borderRadius: 10,
              padding: 14,
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#86efac" }}>🔑 Full Bearer Access Token:</span>
              <span style={{ fontSize: 11, color: "#94a3b8" }}>Click inside to select all</span>
            </div>
            <textarea
              readOnly
              value={tokenData.token}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              style={{
                width: "100%",
                height: 110,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
                color: "#67e8f9",
                background: "#030712",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: 10,
                resize: "vertical",
                boxSizing: "border-box",
                outline: "none",
                wordBreak: "break-all",
              }}
            />
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

      {/* PRIMARY LAUNCH CARD (When session is idle) */}
      {!sessionActive && (
        <div
          style={{
            width: "100%",
            maxWidth: 480,
            background: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: 16,
            padding: 28,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            marginBottom: 20,
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
              Work Email (Optional for auto-fill):
            </label>
            <input
              type="email"
              placeholder="e.g. name@hellofresh.com"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "#020617",
                border: "1px solid #334155",
                borderRadius: 8,
                color: "#e2e8f0",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
              Password (Optional for auto-fill):
            </label>
            <input
              type="password"
              placeholder="••••••••••••"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "#020617",
                border: "1px solid #334155",
                borderRadius: 8,
                color: "#e2e8f0",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <button
            onClick={() => startSession()}
            style={{
              width: "100%",
              padding: "14px 24px",
              background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
              border: "none",
              borderRadius: 10,
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 4px 14px rgba(37, 99, 235, 0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
            }}
          >
            <span>☁️</span> Launch Cloud Authentication Session
          </button>

          <p style={{ margin: "14px 0 0 0", fontSize: 12, color: "#64748b", textAlign: "center", lineHeight: 1.5 }}>
            Automates the Microsoft SSO entry and streams the live browser session.
            Approve on your Authenticator app if prompted.
          </p>
        </div>
      )}

      {/* ACTIVE SESSION BAR & ASSISTIVE INPUT TOOLBAR */}
      {sessionActive && (
        <div style={{ width: "100%", maxWidth: 1080, marginBottom: 12 }}>
          {/* Top Status & End Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "#1e293b",
              borderRadius: "10px 10px 0 0",
              padding: "10px 16px",
              borderBottom: "1px solid #334155",
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
              <span style={{ fontSize: 13, color: "#cbd5e1" }}>{statusMsg}</span>
              {actionStatus && (
                <span
                  style={{
                    fontSize: 11,
                    background: "#0f172a",
                    border: "1px solid #38bdf8",
                    color: "#38bdf8",
                    padding: "2px 8px",
                    borderRadius: 12,
                  }}
                >
                  {actionStatus}
                </span>
              )}
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

          {/* Assistant Action Toolbar (Quick Type / Enter / Auto-SSO) */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "#0f172a",
              padding: "8px 14px",
              border: "1px solid #334155",
              borderTop: "none",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={handleAutoSso}
              style={{
                padding: "6px 12px",
                background: "#15803d",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              🎯 Auto-Click Microsoft SSO Button
            </button>

            <button
              type="button"
              onClick={handleLaunchApp}
              style={{
                padding: "6px 12px",
                background: "#0891b2",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              🚀 Enter Collaborate App
            </button>

            <form
              onSubmit={handleSendQuickText}
              style={{ display: "flex", gap: 6, flex: 1, minWidth: 260 }}
            >
              <input
                type="text"
                placeholder="Type or paste text (email, password) to insert..."
                value={quickText}
                onChange={(e) => setQuickText(e.target.value)}
                style={{
                  flex: 1,
                  padding: "6px 12px",
                  background: "#020617",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  color: "#e2e8f0",
                  fontSize: 12,
                  outline: "none",
                }}
              />
              <button
                type="submit"
                style={{
                  padding: "6px 12px",
                  background: "#2563eb",
                  border: "none",
                  borderRadius: 6,
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Type into Field ↵
              </button>
            </form>

            <button
              type="button"
              onClick={() => handleDirectSubmitPassword()}
              style={{
                padding: "6px 12px",
                background: "#7c3aed",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              🔑 Submit Password
            </button>

            <button
              type="button"
              onClick={() => handleSendKey("Enter")}
              style={{
                padding: "6px 10px",
                background: "#334155",
                border: "none",
                borderRadius: 6,
                color: "#e2e8f0",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Send Enter ↵
            </button>

            <button
              type="button"
              onClick={() => handleSendKey("Tab")}
              style={{
                padding: "6px 10px",
                background: "#334155",
                border: "none",
                borderRadius: 6,
                color: "#e2e8f0",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Send Tab ⇥
            </button>
          </div>
        </div>
      )}

      {/* INTERACTIVE LIVE STREAM SCREEN */}
      {sessionActive && (
        <div
          ref={screenContainerRef}
          onClick={handleScreenClick}
          style={{
            position: "relative",
            width: "100%",
            maxWidth: 1080,
            background: "#020617",
            border: "2px solid #3b82f6",
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 20px 50px rgba(0,0,0,0.8)",
            cursor: "crosshair",
            userSelect: "none",
          }}
        >
          {/* Browser Address Bar Display */}
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
            <span style={{ color: "#38bdf8" }}>Click anywhere on the screen below to interact</span>
          </div>

          {/* Live Screencast Frame */}
          {frameSrc ? (
            <img
              src={frameSrc}
              alt="Live Browser Session"
              draggable={false}
              style={{
                display: "block",
                width: "100%",
                height: "auto",
                pointerEvents: "none", // Clicks pass cleanly to the parent container
              }}
            />
          ) : (
            <div
              style={{
                padding: "120px 20px",
                textAlign: "center",
                color: "#64748b",
                fontSize: 14,
              }}
            >
              ⏳ Connecting to browser session and streaming frames...
            </div>
          )}

          {/* Click Ripple Indicator */}
          {clickIndicator && (
            <div
              key={clickIndicator.id}
              style={{
                position: "absolute",
                left: clickIndicator.x - 12,
                top: clickIndicator.y - 12,
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "rgba(59, 130, 246, 0.4)",
                border: "2px solid #60a5fa",
                pointerEvents: "none",
                animation: "pulse 0.4s ease-out",
              }}
            />
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0% { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(2.2); opacity: 0; }
        }
      `}</style>
    </main>
  );
}
