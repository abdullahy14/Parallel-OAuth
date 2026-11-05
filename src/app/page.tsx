"use client";

import { useState, useEffect, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "login" | "loading" | "success" | "error";

interface TokenData {
  token: string;
  expiresAt: number;
  source: string;
}

// ─── Loading stages shown while headless browser authenticates ───────────────

const STAGES = [
  { icon: "🌐", label: "Launching secure browser session" },
  { icon: "🔗", label: "Opening Genesys Cloud login page" },
  { icon: "🔐", label: "Connecting to Microsoft Entra ID SSO" },
  { icon: "✍️", label: "Submitting your credentials securely" },
  { icon: "🎟️", label: "Capturing Bearer access token" },
];

const STAGE_TIMINGS = [3000, 7000, 13000, 22000]; // ms when each stage completes

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function maskToken(token: string): string {
  if (token.length <= 24) return token;
  return token.slice(0, 20) + "••••••••••••" + token.slice(-8);
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function LoginPage() {
  const [screen, setScreen] = useState<Screen>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [currentStage, setCurrentStage] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const stageTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown timer for token expiry
  useEffect(() => {
    if (tokenData) {
      const tick = () => setTimeLeft(tokenData.expiresAt - Date.now());
      tick();
      countdownRef.current = setInterval(tick, 1000);
      return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
    }
  }, [tokenData]);

  function clearStageTimers() {
    stageTimers.current.forEach(clearTimeout);
    stageTimers.current = [];
  }

  function getJsonPayload() {
    if (!tokenData) return "";
    return JSON.stringify(
      {
        success: true,
        token: tokenData.token,
        source: tokenData.source,
        expiresAt: tokenData.expiresAt,
        cachedUntil: new Date(tokenData.expiresAt).toISOString(),
      },
      null,
      2
    );
  }

  async function handleCopy() {
    if (!tokenData) return;
    await navigator.clipboard.writeText(tokenData.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  async function handleCopyJson() {
    const payload = getJsonPayload();
    if (!payload) return;
    await navigator.clipboard.writeText(payload);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2500);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setScreen("loading");
    setCurrentStage(0);
    clearStageTimers();

    // Animate stages in approximate sync with backend progress
    STAGE_TIMINGS.forEach((delay, i) => {
      const t = setTimeout(() => setCurrentStage(i + 1), delay);
      stageTimers.current.push(t);
    });

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      clearStageTimers();

      if (data.success) {
        setCurrentStage(STAGES.length);
        const resolvedExpiresAt = data.expiresAt ?? Date.now() + 12 * 60 * 60 * 1000;
        setTokenData({
          token: data.token,
          expiresAt: resolvedExpiresAt,
          source: data.source,
        });

        // If this page was opened via window.open() as a popup from another frontend,
        // transmit the token payload back to the opener window immediately.
        if (typeof window !== "undefined" && window.opener) {
          window.opener.postMessage(
            {
              type: "GENESYS_AUTH_SUCCESS",
              data: {
                success: true,
                token: data.token,
                expiresAt: resolvedExpiresAt,
                cachedUntil: data.cachedUntil ?? new Date(resolvedExpiresAt).toISOString(),
                source: data.source,
              },
            },
            "*"
          );
        }

        setTimeout(() => setScreen("success"), 600);
      } else {
        setErrorMsg(data.error ?? "Authentication failed. Please try again.");
        setScreen("error");
      }
    } catch {
      clearStageTimers();
      setErrorMsg("Network error — could not reach the authentication service.");
      setScreen("error");
    }
  }

  function handleRetry() {
    setScreen("login");
    setErrorMsg("");
    setCurrentStage(0);
  }

  function handleNewToken() {
    setScreen("login");
    setTokenData(null);
    setShowToken(false);
    setCurrentStage(0);
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0a0f1e;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .bg {
          position: fixed; inset: 0;
          background: radial-gradient(ellipse at 20% 50%, #1a237e22 0%, transparent 60%),
                      radial-gradient(ellipse at 80% 20%, #0d47a122 0%, transparent 60%),
                      radial-gradient(ellipse at 60% 80%, #1b5e2011 0%, transparent 60%),
                      #0a0f1e;
        }

        .card {
          position: relative; z-index: 1;
          background: #0f1729;
          border: 1px solid #1e2d4a;
          border-radius: 20px;
          padding: 44px 40px;
          width: 100%;
          max-width: 460px;
          box-shadow: 0 24px 80px #00000080, 0 0 0 1px #ffffff08 inset;
          margin: 20px;
        }

        .logo-row {
          display: flex; align-items: center; gap: 12px;
          margin-bottom: 28px;
        }
        .logo-icon {
          width: 44px; height: 44px; border-radius: 12px;
          background: linear-gradient(135deg, #1565c0, #0d47a1);
          display: flex; align-items: center; justify-content: center;
          font-size: 22px;
          box-shadow: 0 4px 16px #1565c040;
        }
        .logo-text h1 { font-size: 17px; font-weight: 600; color: #e2e8f0; }
        .logo-text p  { font-size: 12px; color: #64748b; margin-top: 2px; }

        .divider { height: 1px; background: #1e2d4a; margin-bottom: 28px; }

        .form-label {
          display: block; font-size: 13px; font-weight: 500;
          color: #94a3b8; margin-bottom: 8px;
        }
        .form-input {
          width: 100%; padding: 12px 16px;
          background: #0a0f1e; border: 1px solid #1e2d4a;
          border-radius: 10px; color: #e2e8f0; font-size: 14px;
          outline: none; transition: border-color .2s, box-shadow .2s;
          margin-bottom: 18px;
        }
        .form-input:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px #3b82f620;
        }
        .form-input::placeholder { color: #334155; }

        .btn {
          width: 100%; padding: 13px;
          background: linear-gradient(135deg, #1d4ed8, #2563eb);
          color: #fff; border: none; border-radius: 10px;
          font-size: 15px; font-weight: 600; cursor: pointer;
          transition: opacity .2s, transform .1s;
          letter-spacing: .3px;
        }
        .btn:hover { opacity: .92; }
        .btn:active { transform: scale(.98); }
        .btn:disabled { opacity: .5; cursor: not-allowed; }

        .btn-ghost {
          background: transparent; border: 1px solid #1e2d4a;
          color: #64748b; font-size: 13px; padding: 10px;
          margin-top: 10px;
        }
        .btn-ghost:hover { border-color: #334155; color: #94a3b8; }

        /* Loading */
        .loading-title {
          font-size: 18px; font-weight: 600; color: #e2e8f0;
          margin-bottom: 6px; text-align: center;
        }
        .loading-sub {
          font-size: 13px; color: #64748b; text-align: center;
          margin-bottom: 32px;
        }

        .stage-list { list-style: none; }
        .stage-item {
          display: flex; align-items: center; gap: 14px;
          padding: 11px 0;
          border-bottom: 1px solid #0f1729;
          transition: all .3s;
        }
        .stage-icon-wrap {
          width: 36px; height: 36px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; font-size: 16px;
          transition: all .4s;
        }
        .stage-icon-wrap.done   { background: #14532d40; }
        .stage-icon-wrap.active { background: #1e3a5f; animation: pulse 1.4s infinite; }
        .stage-icon-wrap.idle   { background: #0a0f1e; }

        .stage-label { font-size: 14px; }
        .stage-label.done   { color: #4ade80; }
        .stage-label.active { color: #93c5fd; }
        .stage-label.idle   { color: #334155; }

        .stage-check { margin-left: auto; color: #4ade80; font-size: 16px; }

        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 #3b82f640; }
          50%       { box-shadow: 0 0 0 8px #3b82f600; }
        }

        .spinner {
          width: 18px; height: 18px;
          border: 2px solid #1e3a5f;
          border-top-color: #3b82f6;
          border-radius: 50%;
          animation: spin .8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Success */
        .success-badge {
          width: 56px; height: 56px; border-radius: 50%;
          background: #14532d40; border: 2px solid #16a34a40;
          display: flex; align-items: center; justify-content: center;
          font-size: 26px; margin: 0 auto 20px;
        }
        .success-title {
          font-size: 20px; font-weight: 700; color: #4ade80;
          text-align: center; margin-bottom: 4px;
        }
        .success-sub {
          font-size: 13px; color: #64748b; text-align: center;
          margin-bottom: 28px;
        }

        .token-box {
          background: #0a0f1e; border: 1px solid #1e2d4a;
          border-radius: 10px; padding: 14px 16px; margin-bottom: 14px;
        }
        .token-label {
          font-size: 11px; font-weight: 600; color: #475569;
          text-transform: uppercase; letter-spacing: .8px; margin-bottom: 8px;
        }
        .token-value {
          font-family: 'Courier New', monospace; font-size: 12px;
          color: #7dd3fc; word-break: break-all; line-height: 1.6;
        }

        .token-meta {
          display: flex; align-items: center; gap: 8px;
          font-size: 12px; color: #475569; margin-bottom: 20px;
          padding: 10px 14px; background: #0a0f1e;
          border: 1px solid #1e2d4a; border-radius: 8px;
        }
        .token-meta .dot { color: #22c55e; font-size: 8px; }

        .btn-copy {
          background: linear-gradient(135deg, #065f46, #047857);
          font-size: 14px; padding: 12px; margin-bottom: 0;
        }
        .btn-copy.copied { background: linear-gradient(135deg, #14532d, #15803d); }

        /* Error */
        .error-badge {
          width: 56px; height: 56px; border-radius: 50%;
          background: #450a0a40; border: 2px solid #991b1b40;
          display: flex; align-items: center; justify-content: center;
          font-size: 26px; margin: 0 auto 20px;
        }
        .error-title { font-size: 18px; font-weight: 600; color: #f87171; text-align: center; margin-bottom: 8px; }
        .error-msg   { font-size: 13px; color: #64748b; text-align: center; line-height: 1.6; margin-bottom: 24px; }

        .source-badge {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 11px; color: #475569; background: #0a0f1e;
          border: 1px solid #1e2d4a; border-radius: 20px;
          padding: 4px 10px; margin-bottom: 20px;
        }
      `}</style>

      <div className="bg" />

      <div className="card">

        {/* ── LOGO ── */}
        <div className="logo-row">
          <div className="logo-icon">☁</div>
          <div className="logo-text">
            <h1>Genesys Cloud</h1>
            <p>Token Authentication Portal</p>
          </div>
        </div>
        <div className="divider" />

        {/* ════════════════════════════════════════════════
            SCREEN: LOGIN FORM
        ════════════════════════════════════════════════ */}
        {screen === "login" && (
          <form onSubmit={handleLogin}>
            <label className="form-label">Work Email</label>
            <input
              className="form-input"
              type="email"
              placeholder="you@hellofresh.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />

            <label className="form-label">Password</label>
            <input
              className="form-input"
              type="password"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />

            <button className="btn" type="submit">
              Sign In via Microsoft SSO →
            </button>
          </form>
        )}

        {/* ════════════════════════════════════════════════
            SCREEN: LOADING / HEADLESS BROWSER PROGRESS
        ════════════════════════════════════════════════ */}
        {screen === "loading" && (
          <div>
            <p className="loading-title">Authenticating…</p>
            <p className="loading-sub">
              A secure headless browser is handling your SSO.<br />
              This takes around 15–35 seconds.
            </p>

            <ul className="stage-list">
              {STAGES.map((stage, i) => {
                const isDone   = i < currentStage;
                const isActive = i === currentStage;
                const state    = isDone ? "done" : isActive ? "active" : "idle";

                return (
                  <li key={i} className="stage-item">
                    <div className={`stage-icon-wrap ${state}`}>
                      {isActive
                        ? <div className="spinner" />
                        : <span>{stage.icon}</span>}
                    </div>
                    <span className={`stage-label ${state}`}>{stage.label}</span>
                    {isDone && <span className="stage-check">✓</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* ════════════════════════════════════════════════
            SCREEN: SUCCESS
        ════════════════════════════════════════════════ */}
        {screen === "success" && tokenData && (
          <div>
            <div className="success-badge">🎟️</div>
            <p className="success-title">Token Retrieved!</p>
            <p className="success-sub">
              Your Genesys Cloud access token is ready.
            </p>

            {/* Source badge */}
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <span className="source-badge">
                <span style={{ color: "#22c55e" }}>●</span>
                {tokenData.source === "cache" ? "Served from cache" : "Fresh login"}
              </span>
            </div>

            {/* Token display */}
            <div className="token-box">
              <p className="token-label">Bearer Access Token</p>
              <p className="token-value">
                {showToken ? tokenData.token : maskToken(tokenData.token)}
              </p>
              <button
                onClick={() => setShowToken(!showToken)}
                style={{
                  marginTop: 10, background: "none", border: "none",
                  color: "#3b82f6", cursor: "pointer", fontSize: 12,
                  padding: 0,
                }}
              >
                {showToken ? "Hide" : "Reveal full token"}
              </button>
            </div>

            {/* Expiry */}
            <div className="token-meta">
              <span className="dot">●</span>
              Active · Expires in{" "}
              <strong style={{ color: "#e2e8f0" }}>
                {timeLeft !== null ? formatCountdown(Math.max(0, timeLeft)) : "…"}
              </strong>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                className={`btn btn-copy ${copied ? "copied" : ""}`}
                onClick={handleCopy}
              >
                {copied ? "✓ Copied Token!" : "Copy Bearer Token"}
              </button>

              <button
                className={`btn ${copiedJson ? "copied" : ""}`}
                style={{
                  background: copiedJson ? "#15803d" : "#1e293b",
                  border: "1px solid #334155",
                  fontSize: 13,
                  padding: 11,
                }}
                onClick={handleCopyJson}
              >
                {copiedJson ? "✓ Copied JSON!" : "📋 Copy Full JSON Response"}
              </button>

              <button
                type="button"
                className="btn-ghost"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#60a5fa",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "4px 0",
                  textAlign: "center",
                }}
                onClick={() => setShowJson(!showJson)}
              >
                {showJson ? "▲ Hide JSON payload" : "▼ View raw JSON payload"}
              </button>

              {showJson && (
                <pre
                  style={{
                    background: "#080c18",
                    border: "1px solid #1e293b",
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 11,
                    color: "#93c5fd",
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    textAlign: "left",
                    maxHeight: 180,
                  }}
                >
                  {getJsonPayload()}
                </pre>
              )}

              <button className="btn btn-ghost" onClick={handleNewToken}>
                Sign in with different account
              </button>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════
            SCREEN: ERROR
        ════════════════════════════════════════════════ */}
        {screen === "error" && (
          <div>
            <div className="error-badge">⚠️</div>
            <p className="error-title">Authentication Failed</p>
            <p className="error-msg">{errorMsg}</p>
            <button className="btn" onClick={handleRetry}>
              Try Again
            </button>
            <button className="btn btn-ghost" onClick={handleRetry}>
              Use different credentials
            </button>
          </div>
        )}

      </div>
    </>
  );
}
