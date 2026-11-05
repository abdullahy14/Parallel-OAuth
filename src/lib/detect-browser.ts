/**
 * src/lib/detect-browser.ts
 *
 * Automatically detects the installed Chromium-based browser on the system.
 * Prioritizes Island Enterprise Browser, Microsoft Edge, and Google Chrome.
 */

import { existsSync } from "fs";

export interface DetectResult {
  path: string;
  name: "Island" | "Edge" | "Chrome" | "Chromium" | "Custom";
}

export function detectLocalBrowser(): DetectResult {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programData = process.env.PROGRAMDATA ?? "";
  const userProfile = process.env.USERPROFILE ?? "";

  const candidates: { path: string; name: DetectResult["name"] }[] = [
    // 1. Explicit environment variable overrides
    { path: process.env.ISLAND_EXECUTABLE_PATH ?? "", name: "Island" },
    { path: process.env.EDGE_EXECUTABLE_PATH ?? "", name: "Edge" },
    { path: process.env.CHROME_EXECUTABLE_PATH ?? "", name: "Chrome" },
    { path: process.env.BROWSER_EXECUTABLE_PATH ?? "", name: "Custom" },

    // 2. Island Enterprise Browser (Windows)
    { path: "C:\\Program Files\\Island\\Application\\island.exe", name: "Island" },
    { path: "C:\\Program Files (x86)\\Island\\Application\\island.exe", name: "Island" },
    { path: "C:\\Program Files\\Island\\island.exe", name: "Island" },
    { path: "C:\\Program Files (x86)\\Island\\island.exe", name: "Island" },
    { path: "C:\\Program Files\\Island Technology Inc\\Island\\island.exe", name: "Island" },
    { path: "C:\\Program Files\\Island.io\\Island\\island.exe", name: "Island" },
    { path: `${localAppData}\\Island\\Application\\island.exe`, name: "Island" },
    { path: `${localAppData}\\Programs\\Island\\island.exe`, name: "Island" },
    { path: `${programData}\\Island\\island.exe`, name: "Island" },
    { path: `${userProfile}\\AppData\\Local\\Island\\Application\\island.exe`, name: "Island" },

    // 3. Microsoft Edge (Windows - default on all Windows systems)
    { path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", name: "Edge" },
    { path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", name: "Edge" },
    { path: `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`, name: "Edge" },

    // 4. Google Chrome (Windows)
    { path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", name: "Chrome" },
    { path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", name: "Chrome" },
    { path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`, name: "Chrome" },

    // 5. macOS
    { path: "/Applications/Island.app/Contents/MacOS/Island", name: "Island" },
    { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Edge" },
    { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Chrome" },
    { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "Chromium" },

    // 6. Linux
    { path: "/usr/bin/microsoft-edge", name: "Edge" },
    { path: "/usr/bin/microsoft-edge-stable", name: "Edge" },
    { path: "/usr/bin/google-chrome", name: "Chrome" },
    { path: "/usr/bin/google-chrome-stable", name: "Chrome" },
    { path: "/usr/bin/chromium-browser", name: "Chromium" },
    { path: "/usr/bin/chromium", name: "Chromium" },
  ];

  for (const c of candidates) {
    if (c.path && existsSync(c.path)) {
      console.log(`[browser-detector] Detected ${c.name} at: ${c.path}`);
      return c;
    }
  }

  throw new Error(
    "No supported Chromium-based browser (Island, Microsoft Edge, or Google Chrome) was found. " +
    "Please install Microsoft Edge or set CHROME_EXECUTABLE_PATH or ISLAND_EXECUTABLE_PATH."
  );
}
