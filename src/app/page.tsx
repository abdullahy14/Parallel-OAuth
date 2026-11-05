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

interface LogEntry {
  id: number;
  time: string;
  text: string;
  type: "info" | "success" | "warn" | "error" | "2fa";
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<"api" | "visual">("api");
  const [sessionActive, setSessionActive] = useState(false);
  const [statusMsg, setStatusMsg] = useState("Ready to authenticate.");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [tokenData, setTokenData] = useState<TokenPayload | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [quickText, setQuickText] = useState("");
  const [clickIndicator, setClickIndicator] = useState<ClickFeedback | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 1,
      time: new Date().toLocaleTimeString(),
      text: "API Dashboard initialized. Enter HelloFresh credentials and click 'Launch Authentication'.",
      type: "info",
    },
  ]);

  const screenContainerRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logTerminalRef = useRef<HTMLDivElement | null>(null);

  // Restore token from localStorage or backend cache on page load
  useEffect(() => {
    try {
      const saved = localStorage.getItem("genesys_captured_token");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.expiresAt > Date.now()) {
          setTokenData(parsed);
          addLog("Restored active 12-hour token from browser storage.", "success");
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
          addLog("Retrieved active cached token from backend server.", "success");
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

  // Autoscroll log terminal
  useEffect(() => {
    if (logTerminalRef.current) {
      logTerminalRef.current.scrollTop = logTerminalRef.current.scrollHeight;
    }
  }, [logs]);

  // Clean up SSE when unmounting
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  function addLog(text: string, type: "info" | "success" | "warn" | "error" | "2fa" = "info") {
    setLogs((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString(),
        text,
        type,
      },
    ]);
  }

  function startSession(tabMode?: "api" | "visual") {
    const mode = (tabMode ?? activeTab) === "visual" ? "screencast" : "headless";
    setSessionActive(true);
    setErrorMsg(null);
    setFrameSrc(null);
    setActionStatus(null);

    const initialMsg =
      mode === "headless"
        ? "Launching headless cloud session (zero video overhead)..."
        : "Launching live visual screencast...";
    setStatusMsg(initialMsg);
    addLog(initialMsg, "info");

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    let url = `/api/stream?mode=${mode}`;
    if (authEmail) url += `&email=${encodeURIComponent(authEmail)}`;
    if (authPassword) url += `&password=${encodeURIComponent(authPassword)}`;

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === "frame" && event.data) {
          setFrameSrc(`data:image/jpeg;base64,${event.data}`);
        } else if (event.type === "status") {
          setStatusMsg(event.data);

          let logType: "info" | "2fa" | "warn" = "info";
          if (/2fa|authenticator|number/i.test(event.data)) logType = "2fa";
          else if (/retry|wait/i.test(event.data)) logType = "warn";

          addLog(event.data, logType);
        } else if (event.type === "token" && event.tokenPayload) {
          setTokenData(event.tokenPayload);
          try {
            localStorage.setItem("genesys_captured_token", JSON.stringify(event.tokenPayload));
          } catch {}
          setSessionActive(false);
          addLog("✓ Bearer Token successfully captured and cached for 12 hours!", "success");
          es.close();

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
          const err = event.error ?? "Session failed.";
          setErrorMsg(err);
          addLog(`Error: ${err}`, "error");
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
            addLog("✓ Active Bearer token verified and synced!", "success");
          } else if (!tokenData) {
            setStatusMsg("Session closed.");
            addLog("Stream connection closed.", "warn");
          }
        })
        .catch(() => {
          if (!tokenData) setStatusMsg("Session closed.");
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
    setStatusMsg("Session stopped by user.");
    addLog("Session stopped by user.", "warn");
  }

  async function handleScreenClick(e: React.MouseEvent<HTMLDivElement>) {
    const container = screenContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const percentX = (e.clientX - rect.left) / rect.width;
    const percentY = (e.clientY - rect.top) / rect.height;

    const x = Math.round(percentX * 1080);
    const y = Math.round(percentY * 720);

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
        setActionStatus(`Typed text`);
        setQuickText("");
      }
    } catch {
      setActionStatus("Failed to send text");
    }
  }

  async function handleDirectSubmitPassword(pwd?: string) {
    const targetPassword = pwd || authPassword || quickText;
    if (!targetPassword) {
      setActionStatus("Please enter password above first.");
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
      setActionStatus("Looking for Microsoft SSO button...");
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "auto-sso" }),
      });
      const data = await res.json();
      if (data.clicked) {
        setActionStatus("✓ Clicked Microsoft SSO button!");
      } else {
        setActionStatus("SSO button not found yet");
      }
    } catch {
      setActionStatus("Failed to trigger Auto SSO");
    }
  }

  async function handleLaunchApp() {
    try {
      setActionStatus("Entering Collaborate / Communicate app...");
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
        padding: "30px 20px 60px 20px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e2e8f0",
        background: "#030712",
      }}
    >
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 24 }}>🔑</span>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#60a5fa" }}>
            Genesys Cloud OAuth API Dashboard
          </h1>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#94a3b8" }}>
          Headless automation engine for HelloFresh Microsoft SSO with 12-hour Bearer token extraction
        </p>
      </div>

      {/* Mode Switcher Tabs */}
      <div
        style={{
          display: "flex",
          background: "#0f172a",
          padding: 4,
          borderRadius: 10,
          border: "1px solid #1e293b",
          marginBottom: 24,
          gap: 6,
        }}
      >
        <button
          onClick={() => {
            if (sessionActive && activeTab !== "api") stopSession();
            setActiveTab("api");
          }}
          style={{
            padding: "8px 18px",
            background: activeTab === "api" ? "#2563eb" : "transparent",
            color: activeTab === "api" ? "#fff" : "#94a3b8",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>⚡</span> Headless API Dashboard (Live Logs)
        </button>

        <button
          onClick={() => {
            if (sessionActive && activeTab !== "visual") stopSession();
            setActiveTab("visual");
          }}
          style={{
            padding: "8px 18px",
            background: activeTab === "visual" ? "#2563eb" : "transparent",
            color: activeTab === "visual" ? "#fff" : "#94a3b8",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>🖥️</span> Live Visual Screencast
        </button>
      </div>

      {/* SUCCESS TOKEN STATE (Always pinned at top if available) */}
      {tokenData && (
        <div
          style={{
            width: "100%",
            maxWidth: 780,
            background: "#080c18",
            border: "1px solid #16a34a",
            borderRadius: 14,
            padding: 22,
            marginBottom: 24,
            boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 22 }}>✅</span>
              <h2 style={{ fontSize: 17, margin: 0, color: "#4ade80", fontWeight: 700 }}>
                Genesys Cloud Token Ready (12-Hour Validity)
              </h2>
            </div>
            <span
              style={{
                fontSize: 12,
                color: "#facc15",
                background: "#1c1917",
                border: "1px solid #78350f",
                padding: "3px 10px",
                borderRadius: 12,
                fontWeight: 600,
              }}
            >
              Expires in: {timeLeft !== null ? formatCountdown(Math.max(0, timeLeft)) : "12 hours"}
            </span>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}>
              <span style={{ color: "#86efac", fontWeight: 600 }}>Bearer Access Token (Click to select all):</span>
              <span style={{ color: "#64748b" }}>Source: {tokenData.source}</span>
            </div>
            <textarea
              readOnly
              value={tokenData.token}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              style={{
                width: "100%",
                height: 100,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
                color: "#67e8f9",
                background: "#020617",
                border: "1px solid #1e293b",
                borderRadius: 8,
                padding: 10,
                resize: "vertical",
                boxSizing: "border-box",
                outline: "none",
                wordBreak: "break-all",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
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
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {copied ? "✓ Copied Token!" : "📋 Copy Bearer Token"}
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
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {copiedJson ? "✓ Copied JSON!" : "📋 Copy JSON Payload"}
            </button>
          </div>

          <button
            onClick={() => setShowJson(!showJson)}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            {showJson ? "▲ Hide raw JSON details" : "▼ Inspect raw JSON details"}
          </button>

          {showJson && (
            <pre
              style={{
                background: "#020617",
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

      {/* ERROR BANNER */}
      {errorMsg && (
        <div
          style={{
            maxWidth: 780,
            width: "100%",
            background: "#450a0a",
            border: "1px solid #ef4444",
            borderRadius: 10,
            padding: 12,
            marginBottom: 20,
            fontSize: 13,
            color: "#fca5a5",
          }}
        >
          ❌ {errorMsg}
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────────────────────── */}
      {/* TAB 1: HEADLESS API DASHBOARD (LIVE LOGS, NO FRAMES)                           */}
      {/* ───────────────────────────────────────────────────────────────────────────── */}
      {activeTab === "api" && (
        <div style={{ width: "100%", maxWidth: 780, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Credentials Card */}
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: 14,
              padding: 22,
              boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
            }}
          >
            <h3 style={{ margin: "0 0 14px 0", fontSize: 15, color: "#e2e8f0", fontWeight: 600 }}>
              HelloFresh SSO Credentials
            </h3>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
                  Work Email:
                </label>
                <input
                  type="email"
                  placeholder="e.g. name@cc.hellofresh.com"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  disabled={sessionActive}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: "#020617",
                    border: "1px solid #334155",
                    borderRadius: 8,
                    color: "#e2e8f0",
                    fontSize: 13,
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
                  Password:
                </label>
                <input
                  type="password"
                  placeholder="••••••••••••"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  disabled={sessionActive}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: "#020617",
                    border: "1px solid #334155",
                    borderRadius: 8,
                    color: "#e2e8f0",
                    fontSize: 13,
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => startSession("api")}
                disabled={sessionActive}
                style={{
                  flex: 1,
                  padding: "12px 20px",
                  background: sessionActive
                    ? "#334155"
                    : "linear-gradient(135deg, #2563eb, #1d4ed8)",
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: sessionActive ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                {sessionActive ? (
                  <>
                    <span
                      style={{
                        display: "inline-block",
                        width: 14,
                        height: 14,
                        border: "2px solid #fff",
                        borderTopColor: "transparent",
                        borderRadius: "50%",
                        animation: "spin 0.8s linear infinite",
                      }}
                    />
                    <span>Executing Headless Authentication...</span>
                  </>
                ) : (
                  <>
                    <span>🚀</span>
                    <span>Launch Headless Authentication</span>
                  </>
                )}
              </button>

              {sessionActive && (
                <button
                  onClick={stopSession}
                  style={{
                    padding: "12px 20px",
                    background: "#ef4444",
                    border: "none",
                    borderRadius: 8,
                    color: "#fff",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Stop
                </button>
              )}
            </div>
          </div>

          {/* Live Execution Log Terminal */}
          <div
            style={{
              background: "#020617",
              border: "1px solid #1e293b",
              borderRadius: 14,
              overflow: "hidden",
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            }}
          >
            {/* Terminal Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 16px",
                background: "#0f172a",
                borderBottom: "1px solid #1e293b",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: sessionActive ? "#22c55e" : "#64748b",
                    boxShadow: sessionActive ? "0 0 8px #22c55e" : "none",
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase" }}>
                  Execution Logs & Telemetry
                </span>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  {sessionActive ? "Stream Active" : "Idle"}
                </span>
                <button
                  onClick={() => setLogs([])}
                  style={{
                    background: "transparent",
                    border: "1px solid #334155",
                    borderRadius: 4,
                    color: "#94a3b8",
                    fontSize: 11,
                    padding: "2px 8px",
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Terminal Body */}
            <div
              ref={logTerminalRef}
              style={{
                padding: "14px 16px",
                minHeight: 220,
                maxHeight: 320,
                overflowY: "auto",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {logs.map((log) => {
                let badgeColor = "#64748b";
                let badgeText = "INFO";
                let textColor = "#cbd5e1";

                if (log.type === "success") {
                  badgeColor = "#16a34a";
                  badgeText = "SUCCESS";
                  textColor = "#86efac";
                } else if (log.type === "2fa") {
                  badgeColor = "#eab308";
                  badgeText = "2FA-REQ";
                  textColor = "#fef08a";
                } else if (log.type === "warn") {
                  badgeColor = "#f97316";
                  badgeText = "WARN";
                  textColor = "#fed7aa";
                } else if (log.type === "error") {
                  badgeColor = "#ef4444";
                  badgeText = "ERROR";
                  textColor = "#fca5a5";
                }

                return (
                  <div key={log.id} style={{ display: "flex", gap: 10, marginBottom: 4 }}>
                    <span style={{ color: "#475569", flexShrink: 0 }}>[{log.time}]</span>
                    <span
                      style={{
                        background: `${badgeColor}22`,
                        color: badgeColor,
                        padding: "0 6px",
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 700,
                        height: 18,
                        display: "inline-flex",
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      {badgeText}
                    </span>
                    <span style={{ color: textColor, wordBreak: "break-word" }}>{log.text}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Programmatic API Quick Reference */}
          <div
            style={{
              background: "#080c18",
              border: "1px solid #1e293b",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <h4 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#38bdf8" }}>
              🌐 Direct Programmatic Access (No Frontend Needed)
            </h4>
            <p style={{ margin: "0 0 10px 0", fontSize: 12, color: "#94a3b8" }}>
              Agents or scripts can directly call the API endpoint via POST to receive the token as pure JSON:
            </p>
            <pre
              style={{
                background: "#020617",
                border: "1px solid #1e293b",
                borderRadius: 8,
                padding: 10,
                fontSize: 11,
                color: "#a5f3fc",
                overflowX: "auto",
                margin: 0,
              }}
            >
{`curl -X POST "https://parallel-auth.vercel.app/api/login" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"yourname@cc.hellofresh.com", "password":"yourPassword"}'`}
            </pre>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────────────────────── */}
      {/* TAB 2: LIVE VISUAL SCREENCAST (INTERACTIVE CANVAS STREAM)                     */}
      {/* ───────────────────────────────────────────────────────────────────────────── */}
      {activeTab === "visual" && (
        <div style={{ width: "100%", maxWidth: 1080, display: "flex", flexDirection: "column", alignItems: "center" }}>
          {!sessionActive && (
            <div
              style={{
                width: "100%",
                maxWidth: 480,
                background: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: 14,
                padding: 24,
                marginBottom: 20,
              }}
            >
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
                  Work Email:
                </label>
                <input
                  type="email"
                  placeholder="e.g. name@cc.hellofresh.com"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: "#020617",
                    border: "1px solid #334155",
                    borderRadius: 8,
                    color: "#e2e8f0",
                    fontSize: 13,
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
                  Password:
                </label>
                <input
                  type="password"
                  placeholder="••••••••••••"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: "#020617",
                    border: "1px solid #334155",
                    borderRadius: 8,
                    color: "#e2e8f0",
                    fontSize: 13,
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <button
                onClick={() => startSession("visual")}
                style={{
                  width: "100%",
                  padding: "12px 20px",
                  background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Launch Visual Screencast Session
              </button>
            </div>
          )}

          {sessionActive && (
            <div style={{ width: "100%", marginBottom: 12 }}>
              {/* Top Bar */}
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

              {/* Assistive Toolbar */}
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
                  style={{ display: "flex", gap: 6, flex: 1, minWidth: 240 }}
                >
                  <input
                    type="text"
                    placeholder="Type or paste text..."
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
                    }}
                  >
                    Type ↵
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
                  Enter ↵
                </button>
              </div>

              {/* Screencast Screen */}
              <div
                ref={screenContainerRef}
                onClick={handleScreenClick}
                style={{
                  position: "relative",
                  width: "100%",
                  background: "#020617",
                  border: "2px solid #3b82f6",
                  borderRadius: "0 0 12px 12px",
                  overflow: "hidden",
                  cursor: "crosshair",
                  userSelect: "none",
                }}
              >
                {frameSrc ? (
                  <img
                    src={frameSrc}
                    alt="Live Browser Session"
                    draggable={false}
                    style={{ display: "block", width: "100%", height: "auto", pointerEvents: "none" }}
                  />
                ) : (
                  <div style={{ padding: "120px 20px", textAlign: "center", color: "#64748b", fontSize: 14 }}>
                    ⏳ Connecting to live session screencast...
                  </div>
                )}

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
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0% { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  );
}
