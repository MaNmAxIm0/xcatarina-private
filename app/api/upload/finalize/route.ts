import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VideoMetadata = {
  title: string;
  description: string;
  category: "arte" | "lego";
  duration: string;
  format: "horizontal" | "vertical";
  publicationId: string;
};

function requesterIp(request: Request) {
  return (request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
}

function authorizeIp(request: Request) {
  const current = requesterIp(request);
  const allowed = (process.env.ALLOWED_IPS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!process.env.VERCEL && ["127.0.0.1", "::1", ""].includes(current)) return true;
  return allowed.includes(current);
}

export async function POST(request: Request) {
  if (!authorizeIp(request)) return NextResponse.json({ error: "Este IP não tem permissão para publicar." }, { status: 403 });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "Falta BLOB_READ_WRITE_TOKEN no estúdio. Usa o token do mesmo Blob store do site público." }, { status: 503 });
  }

  try {
    const body = await request.json() as { blob?: { url?: string; pathname?: string }; metadata?: VideoMetadata };
    const url = new URL(body.blob?.url || "");
    const pathname = body.blob?.pathname || "";
    const metadata = body.metadata;
    if (!url.hostname.endsWith(".public.blob.vercel-storage.com")) throw new Error("Endereço Blob inválido.");
    if (!/^videos\/(arte|lego)\/[a-zA-Z0-9-]+\.(webm|mp4)$/.test(pathname)) throw new Error("Nome de vídeo inválido.");
    if (!metadata?.title || !["arte", "lego"].includes(metadata.category) || !["horizontal", "vertical"].includes(metadata.format) || !/^[a-f0-9-]{36}$/i.test(metadata.publicationId || "")) {
      throw new Error("Metadados inválidos.");
    }
    if (!pathname.startsWith(`videos/${metadata.category}/`)) throw new Error("A categoria não corresponde ao vídeo.");

    const record = { ...metadata, videoUrl: url.toString(), pathname, createdAt: new Date().toISOString(), featured: 0 };
    await put(`metadata/${encodeURIComponent(pathname)}.json`, JSON.stringify(record), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      allowOverwrite: true,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível finalizar a publicação." }, { status: 400 });
  }
}
