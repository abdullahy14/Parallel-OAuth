/**
 * /api/login — Browser-facing login endpoint
 *
 * Called by the Next.js login popup UI. No API key required since this
 * endpoint is for direct browser use by the authenticated user.
 *
 * The Microsoft / Genesys Cloud side naturally rate-limits login attempts,
 * so no additional throttling is needed here.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  fetchGenesysToken,
  getCachedToken,
  getCacheExpiry,
  TOKEN_TTL_MS,
} from "@/lib/genesys-token";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { email?: string; password?: string; forceRefresh?: boolean } = {};

  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: CORS_HEADERS });
  }

  // Block any attempt to supply a custom login URL
  const raw = body as Record<string, unknown>;
  if (raw.loginUrl || raw.url || raw.targetUrl || raw.authUrl) {
    return NextResponse.json(
      { error: "Supplying a custom login URL is not permitted." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { email, password, forceRefresh } = body;

  if (!email || !password) {
    return NextResponse.json(
      { error: "email and password are required." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Return cached token unless forceRefresh is requested
  if (!forceRefresh) {
    const cached = getCachedToken();
    if (cached) {
      return NextResponse.json(
        {
          success: true,
          token: cached,
          source: "cache",
          expiresAt: getCacheExpiry(),
          cachedUntil: new Date(getCacheExpiry()!).toISOString(),
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }
  }

  const result = await fetchGenesysToken(email, password);
  return NextResponse.json(result, {
    status: result.success ? 200 : 500,
    headers: CORS_HEADERS,
  });
}
