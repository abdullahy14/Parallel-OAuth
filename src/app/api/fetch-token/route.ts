/**
 * /api/fetch-token — Programmatic (server-to-server) token endpoint
 *
 * Requires x-api-key header matching INTERNAL_API_KEY env var.
 * Use /api/login for browser-based access from the UI.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  fetchGenesysToken,
  getCachedToken,
  getCacheExpiry,
  clearCache,
} from "@/lib/genesys-token";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function validateApiKey(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    console.error("[auth] INTERNAL_API_KEY is not set.");
    return false;
  }
  return key === expected;
}

function corsJson(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!validateApiKey(req)) return corsJson({ error: "Unauthorized." }, 401);

  const forceRefresh = req.nextUrl.searchParams.get("forceRefresh") === "true";

  if (!forceRefresh) {
    const cached = getCachedToken();
    if (cached) {
      return corsJson({
        success: true,
        token: cached,
        source: "cache",
        expiresAt: getCacheExpiry(),
        cachedUntil: new Date(getCacheExpiry()!).toISOString(),
      }, 200);
    }
  } else {
    clearCache();
  }

  const email = process.env.GENESIS_USER_EMAIL;
  const password = process.env.GENESIS_USER_PASSWORD;

  if (!email || !password) {
    return corsJson(
      { error: "Set GENESIS_USER_EMAIL and GENESIS_USER_PASSWORD env vars for GET requests." },
      400
    );
  }

  const result = await fetchGenesysToken(email, password);
  return corsJson(result, result.success ? 200 : 500);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!validateApiKey(req)) return corsJson({ error: "Unauthorized." }, 401);

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return corsJson({ error: "Invalid JSON body." }, 400);
  }

  if (body.loginUrl || body.url || body.targetUrl || body.authUrl) {
    return corsJson({ error: "Supplying a custom login URL is not permitted." }, 400);
  }

  const email = (body.email as string) ?? process.env.GENESIS_USER_EMAIL;
  const password = (body.password as string) ?? process.env.GENESIS_USER_PASSWORD;

  if (!email || !password) {
    return corsJson({ error: "Credentials required via body or env vars." }, 400);
  }

  const result = await fetchGenesysToken(email, password);
  return corsJson(result, result.success ? 200 : 500);
}
