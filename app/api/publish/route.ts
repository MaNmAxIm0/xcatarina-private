import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { publicR2Url, r2Config } from "../../lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const DURATIONS = [8, 15, 30, 45, 60, 90] as const;

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
  if (process.env.VERCEL) return NextResponse.json({ error: "A publicação dos ficheiros locais só funciona no Studio local." }, { status: 403 });
  if (!authorizeIp(request)) return NextResponse.json({ error: "Este IP não tem permissão para publicar." }, { status: 403 });
  try {
    const body = await request.json() as { jobId?: string; publicationId?: string; title?: string; description?: string; category?: "arte" | "lego" };
    if (!/^[a-f0-9-]{36}$/.test(body.jobId || "") || !/^[a-f0-9-]{36}$/.test(body.publicationId || "") || !body.title?.trim() || !["arte", "lego"].includes(body.category || "")) throw new Error("Pedido de publicação inválido.");
    const { client, bucket, publicUrl } = r2Config();
    const safeTitle = body.title.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "timelapse";
    const createdAt = new Date().toISOString();
    const records = [];
    let completed = 0;
    for (const durationSeconds of DURATIONS) {
      for (const format of ["horizontal", "vertical"] as const) {
        const file = path.join(process.cwd(), "outputs", `${body.jobId}-${durationSeconds}-${format}.mp4`);
        const info = await stat(file);
        const key = `videos/${body.category}/${body.publicationId}/${durationSeconds}s-${format}-${safeTitle}.mp4`;
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: info.size, ContentType: "video/mp4", CacheControl: "public, max-age=31536000, immutable" }));
        records.push({ publicationId: body.publicationId, title: body.title.trim(), description: body.description?.trim() || "", category: body.category, duration: `${String(Math.floor(durationSeconds / 60)).padStart(2, "0")}:${String(durationSeconds % 60).padStart(2, "0")}`, durationSeconds, format, videoUrl: publicR2Url(publicUrl, key), pathname: key, createdAt, featured: 0 });
        completed += 1;
      }
    }
    const metadataKey = `metadata/${body.publicationId}.json`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: metadataKey, Body: JSON.stringify(records), ContentType: "application/json", CacheControl: "no-cache" }));
    return NextResponse.json({ ok: true, completed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível publicar no Cloudflare R2." }, { status: 400 });
  }
}
