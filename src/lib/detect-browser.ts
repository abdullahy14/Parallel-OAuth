/**
 * src/lib/detect-browser.ts
 *
 * Universal browser resolution for Cloud (Vercel serverless) and Local environments.
 * Solves the missing libnss3.so error on AWS Lambda / Vercel by ensuring:
 *  1. AWS_EXECUTION_ENV is configured for Node 20 / AL2023.
 *  2. al2023.tar.br and al2.tar.br shared libraries (libnss3, libnspr4) are inflated.
 *  3. LD_LIBRARY_PATH is explicitly populated and passed to the child process environment.
 */

import { existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

export const CHROMIUM_REMOTE_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar";

export interface ResolvedBrowser {
  executablePath: string;
  browserName: string;
  isCloud: boolean;
  args: string[];
  env: Record<string, string>;
}

export function isCloudEnvironment(): boolean {
  return (
    process.env.VERCEL === "1" ||
    process.env.AWS_LAMBDA_FUNCTION_NAME != null ||
    process.env.NOW_REGION != null ||
    process.env.NODE_ENV === "production"
  );
}

// Pre-set AWS environment variables so @sparticuz/chromium-min recognizes the runtime
if (isCloudEnvironment()) {
  if (!process.env.AWS_EXECUTION_ENV) {
    process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs20.x";
  }
  if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
    process.env.AWS_LAMBDA_JS_RUNTIME = "nodejs20.x";
  }
  if (!process.env.FONTCONFIG_PATH) {
    process.env.FONTCONFIG_PATH = "/tmp/fonts";
  }
}

export async function resolveBrowserExecutable(): Promise<ResolvedBrowser> {
  const isCloud = isCloudEnvironment();

  // ── 1. Cloud / Vercel Serverless Path ─────────────────────────────────────
  if (isCloud) {
    try {
      // Force lambda environment variables before loading chromium module
      process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs20.x";
      process.env.AWS_LAMBDA_JS_RUNTIME = "nodejs20.x";

      const chromium = (await import("@sparticuz/chromium-min")).default;
      chromium.setGraphicsMode = true;
      chromium.setHeadlessMode = true;

      const executablePath = await chromium.executablePath(CHROMIUM_REMOTE_URL);
      const tmp = tmpdir();

      // Ensure al2023.tar.br / al2.tar.br are inflated if present in /tmp/chromium-pack
      const packDir = path.join(tmp, "chromium-pack");
      const al2023Tar = path.join(packDir, "al2023.tar.br");
      const al2Tar = path.join(packDir, "al2.tar.br");

      try {
        const lambdafs = (await import("@sparticuz/chromium-min/build/lambdafs")).default;
        if (existsSync(al2023Tar)) {
          await lambdafs.inflate(al2023Tar);
        }
        if (existsSync(al2Tar)) {
          await lambdafs.inflate(al2Tar);
        }
      } catch (err) {
        console.warn("[browser-resolver] lambdafs manual inflate notice:", err);
      }

      // Configure LD_LIBRARY_PATH so dynamic linker finds libnss3.so, libnspr4.so, etc.
      const libDirs = [
        path.join(tmp, "al2023", "lib"),
        path.join(tmp, "al2", "lib"),
        path.join(tmp, "al2023"),
        path.join(tmp, "al2"),
        path.join(tmp, "chromium-pack"),
        tmp,
      ];

      const currentLd = process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(":") : [];
      const mergedLd = [...new Set([...libDirs, ...currentLd])].join(":");
      process.env.LD_LIBRARY_PATH = mergedLd;

      console.log(`[browser-resolver] Cloud Chromium executable ready at: ${executablePath}`);
      console.log(`[browser-resolver] LD_LIBRARY_PATH set to: ${mergedLd}`);

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        LD_LIBRARY_PATH: mergedLd,
        FONTCONFIG_PATH: "/tmp/fonts",
        HOME: "/tmp",
      };

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
        env,
      };
    } catch (err) {
      console.error("[browser-resolver] Failed to load Cloud Chromium:", err);
      throw new Error(`Failed to initialize Cloud Chromium on Vercel: ${(err as Error).message}`);
    }
  }

  // ── 2. Local Fallback (Island, Edge, Chrome) ──────────────────────────────
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programData = process.env.PROGRAMDATA ?? "";
  const userProfile = process.env.USERPROFILE ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  const candidates = [
    { path: process.env.ISLAND_EXECUTABLE_PATH ?? "", name: "Island" },
    { path: process.env.EDGE_EXECUTABLE_PATH ?? "", name: "Edge" },
    { path: process.env.CHROME_EXECUTABLE_PATH ?? "", name: "Chrome" },
    { path: process.env.BROWSER_EXECUTABLE_PATH ?? "", name: "Custom" },
    { path: `${programFiles}\\Island\\Application\\island.exe`, name: "Island" },
    { path: `${programFilesX86}\\Island\\Application\\island.exe`, name: "Island" },
    { path: `${programFiles}\\Island\\island.exe`, name: "Island" },
    { path: `${programFilesX86}\\Island\\island.exe`, name: "Island" },
    { path: `${localAppData}\\Island\\Application\\island.exe`, name: "Island" },
    { path: `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`, name: "Edge" },
    { path: `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`, name: "Edge" },
    { path: `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`, name: "Edge" },
    { path: `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`, name: "Chrome" },
    { path: `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`, name: "Chrome" },
    { path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`, name: "Chrome" },
    { path: "/usr/bin/microsoft-edge", name: "Edge" },
    { path: "/usr/bin/google-chrome", name: "Chrome" },
    { path: "/usr/bin/chromium-browser", name: "Chromium" },
    { path: "/usr/bin/chromium", name: "Chromium" },
  ];

  for (const c of candidates) {
    if (c.path && existsSync(c.path)) {
      console.log(`[browser-resolver] Successfully resolved local ${c.name} at: ${c.path}`);
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
        env: { ...(process.env as Record<string, string>) },
      };
    }
  }

  throw new Error("No browser executable found.");
}
