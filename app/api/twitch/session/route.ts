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
  const body = await request.json().catch(() => ({})) as { manifestUrl?: string; vodId?: string; startedAt?: string; durationSeconds?: number; combine?: boolean };
  const current = getCapturedTwitchSession();
  if (body.combine && !body.manifestUrl) {
    setCapturedTwitchSession({ ...(current || { manifestUrl: "", vodId: "", capturedAt: Date.now() }), combineLives: true });
    return cors(NextResponse.json({ ok: true, combineLives: true }));
  }
  if (!body.manifestUrl || !validManifest(body.manifestUrl)) return cors(NextResponse.json({ error: "Manifesto Twitch inválido." }, { status: 400 }));
  const vodId = String(body.vodId || "").replace(/\D/g, "");
  const metadata = { vodStartedAt: body.startedAt && !Number.isNaN(Date.parse(body.startedAt)) ? body.startedAt : undefined, vodDurationSeconds: Number.isFinite(Number(body.durationSeconds)) && Number(body.durationSeconds) > 0 ? Number(body.durationSeconds) : undefined };
  if (current?.combineLives && current.manifestUrl && current.vodId !== vodId) {
    setCapturedTwitchSession({ ...current, secondaryManifestUrl: body.manifestUrl, secondaryVodId: vodId, capturedAt: Date.now() });
  } else {
    setCapturedTwitchSession({ manifestUrl: body.manifestUrl, vodId, capturedAt: Date.now(), ...metadata, combineLives: current?.combineLives });
  }
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
    vodStartedAt: fresh ? session?.vodStartedAt || null : null,
    vodDurationSeconds: fresh ? session?.vodDurationSeconds || null : null,
    secondaryVodId: fresh ? session?.secondaryVodId || "" : "",
    combineLives: fresh ? Boolean(session?.combineLives) : false,
  }));
}

export function DELETE() {
  if (process.env.VERCEL) return cors(NextResponse.json({ error: "DisponÃ­vel apenas localmente." }, { status: 403 }));
  setCapturedTwitchSession(null);
  return cors(NextResponse.json({ ok: true }));
}

