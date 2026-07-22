import { put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

type VideoMetadata = { title: string; description: string; category: "arte" | "lego"; duration: string; format: "horizontal" | "vertical"; publicationId: string };

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
  const body = (await request.json()) as HandleUploadBody;
  try {
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!authorizeIp(request)) throw new Error("Este IP não tem permissão para publicar.");
        if (!/^videos\/(arte|lego)\/[a-zA-Z0-9-]+\.(webm|mp4)$/.test(pathname)) throw new Error("Nome de vídeo inválido.");
        const metadata = JSON.parse(clientPayload || "{}") as VideoMetadata;
        if (!metadata.title || !["arte", "lego"].includes(metadata.category) || !/^[a-f0-9-]{36}$/i.test(metadata.publicationId || "")) throw new Error("Metadados inválidos.");
        return { allowedContentTypes: ["video/webm", "video/mp4"], addRandomSuffix: true, tokenPayload: JSON.stringify(metadata) };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const metadata = JSON.parse(tokenPayload || "{}") as VideoMetadata;
        const record = { ...metadata, videoUrl: blob.url, pathname: blob.pathname, createdAt: new Date().toISOString(), featured: 0 };
        await put(`metadata/${encodeURIComponent(blob.pathname)}.json`, JSON.stringify(record), { access: "public", addRandomSuffix: false, contentType: "application/json", allowOverwrite: true });
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload recusado." }, { status: 400 });
  }
}
