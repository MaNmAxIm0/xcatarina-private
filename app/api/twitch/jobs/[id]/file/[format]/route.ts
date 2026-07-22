import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; format: string }> }) {
  if (process.env.VERCEL) return new NextResponse("Disponível apenas localmente.", { status: 403 });
  const { id, format } = await context.params;
  if (!/^[a-f0-9-]{36}$/.test(id) || !["horizontal", "vertical"].includes(format)) return new NextResponse("Pedido inválido.", { status: 400 });
  const duration = Number(new URL(request.url).searchParams.get("duration") || "30");
  if (![8, 15, 30, 45, 60, 90, 120, 300, 600].includes(duration)) return new NextResponse("Duração inválida.", { status: 400 });
  const file = path.join(process.cwd(), "outputs", `${id}-${duration}-${format}.mp4`);
  try {
    const info = await stat(file);
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="xcatarina-${duration}s-${format}-timelapse.mp4"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse("Ficheiro não encontrado.", { status: 404 });
  }
}
