import { NextResponse } from "next/server";
import { getCapturedTwitchSession, setCapturedTwitchSession } from "../../../lib/twitch-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cors(response: NextResponse) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function validManifest(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "usher.ttvnw.net" || url.hostname.endsWith(".ttvnw.net")) &&
      url.pathname.endsWith(".m3u8");
  } catch {
    return false;
  }
}

export function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(request: Request) {
  if (process.env.VERCEL) return cors(NextResponse.json({ error: "A captura de VOD só funciona no estúdio local." }, { status: 403 }));
  const body = await request.json().catch(() => ({})) as { manifestUrl?: string; vodId?: string };
  if (!body.manifestUrl || !validManifest(body.manifestUrl)) {
    return cors(NextResponse.json({ error: "Manifesto Twitch inválido." }, { status: 400 }));
  }
  setCapturedTwitchSession({
    manifestUrl: body.manifestUrl,
    vodId: String(body.vodId || "").replace(/\D/g, ""),
    capturedAt: Date.now(),
  });
  return cors(NextResponse.json({ ok: true }));
}

export function GET() {
  if (process.env.VERCEL) return cors(NextResponse.json({ available: false, local: false }));
  const session = getCapturedTwitchSession();
  const fresh = Boolean(session);
  return cors(NextResponse.json({
    available: fresh,
    local: true,
    vodId: fresh ? session?.vodId : "",
    capturedAt: fresh ? session?.capturedAt : null,
  }));
}

export function DELETE() {
  if (process.env.VERCEL) return cors(NextResponse.json({ error: "Disponível apenas localmente." }, { status: 403 }));
  setCapturedTwitchSession(null);
  return cors(NextResponse.json({ ok: true }));
}
