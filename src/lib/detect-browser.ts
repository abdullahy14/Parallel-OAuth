/**
 * src/lib/detect-browser.ts
 *
 * Universal browser resolution for both Cloud (Vercel serverless) and Local environments.
 * Supports:
 *  - Vercel Serverless (@sparticuz/chromium-min runtime download)
 *  - Island Enterprise Browser (Windows / macOS)
 *  - Microsoft Edge (Windows / macOS / Linux)
 *  - Google Chrome (Windows / macOS / Linux)
 *  - Custom overrides via environment variables
 */

import { existsSync } from "fs";

export const CHROMIUM_REMOTE_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar";

export interface ResolvedBrowser {
  executablePath: string;
  browserName: "Island" | "Edge" | "Chrome" | "Chromium" | "Cloud-Chromium" | "Custom";
  isCloud: boolean;
  args: string[];
}

export function isCloudEnvironment(): boolean {
  return (
    process.env.VERCEL === "1" ||
    process.env.AWS_LAMBDA_FUNCTION_NAME != null ||
    process.env.NOW_REGION != null
  );
}

export async function resolveBrowserExecutable(): Promise<ResolvedBrowser> {
  // ── 1. Cloud / Vercel Serverless Path ─────────────────────────────────────
  if (isCloudEnvironment()) {
    try {
      const chromium = (await import("@sparticuz/chromium-min")).default;
      const executablePath = await chromium.executablePath(CHROMIUM_REMOTE_URL);

      return {
        executablePath,
        browserName: "Cloud-Chromium",
        isCloud: true,
        args: [
          ...chromium.args,
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--single-process",
          "--no-zygote",
          "--disable-background-networking",
          "--disable-extensions",
          "--disable-sync",
          "--mute-audio",
          "--disable-blink-features=AutomationControlled",
        ],
      };
    } catch (err) {
      console.error("[browser-resolver] Failed to load serverless chromium:", err);
      throw new Error(`Failed to initialize serverless Chromium on Vercel: ${(err as Error).message}`);
    }
  }

  // ── 2. Local Environment Path (Island, Edge, Chrome) ──────────────────────
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programData = process.env.PROGRAMDATA ?? "";
  const userProfile = process.env.USERPROFILE ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  const candidates: { path: string; name: ResolvedBrowser["browserName"] }[] = [
    // A. Explicit Environment Variables
    { path: process.env.ISLAND_EXECUTABLE_PATH ?? "", name: "Island" },
    { path: process.env.EDGE_EXECUTABLE_PATH ?? "", name: "Edge" },
    { path: process.env.CHROME_EXECUTABLE_PATH ?? "", name: "Chrome" },
    { path: process.env.BROWSER_EXECUTABLE_PATH ?? "", name: "Custom" },

    // B. Island Enterprise Browser (Windows)
    { path: `${programFiles}\\Island\\Application\\island.exe`, name: "Island" },
    { path: `${programFilesX86}\\Island\\Application\\island.exe`, name: "Island" },
    { path: `${programFiles}\\Island\\island.exe`, name: "Island" },
    { path: `${programFilesX86}\\Island\\island.exe`, name: "Island" },
    { path: `${programFiles}\\Island Technology Inc\\Island\\island.exe`, name: "Island" },
    { path: `${programFiles}\\Island.io\\Island\\island.exe`, name: "Island" },
    { path: `${localAppData}\\Island\\Application\\island.exe`, name: "Island" },
    { path: `${localAppData}\\Programs\\Island\\island.exe`, name: "Island" },
    { path: `${programData}\\Island\\island.exe`, name: "Island" },
    { path: `${userProfile}\\AppData\\Local\\Island\\Application\\island.exe`, name: "Island" },

    // C. Microsoft Edge (Windows - preinstalled on all Windows systems)
    { path: `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`, name: "Edge" },
    { path: `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`, name: "Edge" },
    { path: `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`, name: "Edge" },

    // D. Google Chrome (Windows)
    { path: `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`, name: "Chrome" },
    { path: `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`, name: "Chrome" },
    { path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`, name: "Chrome" },

    // E. macOS
    { path: "/Applications/Island.app/Contents/MacOS/Island", name: "Island" },
    { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Edge" },
    { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Chrome" },
    { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "Chromium" },

    // F. Linux
    { path: "/usr/bin/microsoft-edge", name: "Edge" },
    { path: "/usr/bin/microsoft-edge-stable", name: "Edge" },
    { path: "/usr/bin/google-chrome", name: "Chrome" },
    { path: "/usr/bin/google-chrome-stable", name: "Chrome" },
    { path: "/usr/bin/chromium-browser", name: "Chromium" },
    { path: "/usr/bin/chromium", name: "Chromium" },
  ];

  for (const c of candidates) {
    if (c.path && existsSync(c.path)) {
      console.log(`[browser-resolver] Successfully resolved ${c.name} at: ${c.path}`);
      return {
        executablePath: c.path,
        browserName: c.name,
        isCloud: false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-default-browser-check",
          "--no-first-run",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=Translate,OptimizationHints,MediaRouter",
          "--remote-debugging-port=0",
        ],
      };
    }
  }

  throw new Error(
    "No supported Chromium-based browser (Island, Microsoft Edge, or Google Chrome) was found on this system.\n" +
    "If you have Island or Edge in a custom directory, set ISLAND_EXECUTABLE_PATH or EDGE_EXECUTABLE_PATH in .env.local."
  );
}
