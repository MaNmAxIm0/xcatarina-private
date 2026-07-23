import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NextResponse } from "next/server";
import { publicR2Url, r2Config } from "../../lib/r2";
import { getCapturedTwitchSession } from "../../lib/twitch-session";

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
  if (process.env.VERCEL) return NextResponse.json({ error: "A publicaÃ§Ã£o dos ficheiros locais sÃ³ funciona no Studio local." }, { status: 403 });
  if (!authorizeIp(request)) return NextResponse.json({ error: "Este IP nÃ£o tem permissÃ£o para publicar." }, { status: 403 });
  try {
    const body = await request.json() as { jobId?: string; publicationId?: string; title?: string; description?: string; category?: "arte" | "lego"; publishedAt?: string };
    if (!/^[a-f0-9-]{36}$/.test(body.jobId || "") || !/^[a-f0-9-]{36}$/.test(body.publicationId || "") || !body.title?.trim() || !["arte", "lego"].includes(body.category || "")) throw new Error("Pedido de publicaÃ§Ã£o invÃ¡lido.");
    const { client, bucket, publicUrl } = r2Config();
    const safeTitle = body.title.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "timelapse";
    const manualDate = body.publishedAt?.trim();
    let createdAt: string;
    if (manualDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(manualDate)) throw new Error("A data do timelapse Ã© invÃ¡lida.");
      const parsed = new Date(`${manualDate}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) throw new Error("A data do timelapse Ã© invÃ¡lida.");
      createdAt = parsed.toISOString();
    } else {
      const session = getCapturedTwitchSession();
      const started = session?.vodStartedAt ? Date.parse(session.vodStartedAt) : NaN;
      const durationSeconds = session?.vodDurationSeconds || 0;
      createdAt = Number.isFinite(started) && durationSeconds > 0 ? new Date(started + durationSeconds * 1000).toISOString() : new Date().toISOString();
    }
    const records = [];
    let completed = 0;
    for (const durationSeconds of DURATIONS) {
      for (const format of ["horizontal", "vertical"] as const) {
        const file = path.join(process.cwd(), "outputs", `${body.jobId}-${durationSeconds}-${format}.mp4`);
        const info = await stat(file);
        const key = `videos/${body.category}/${body.publicationId}/${durationSeconds}s-${format}-${safeTitle}.mp4`;
        await new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: info.size, ContentType: "video/mp4", CacheControl: "public, max-age=31536000, immutable" }, partSize: 8 * 1024 * 1024, queueSize: 2 }).done();
        records.push({ publicationId: body.publicationId, title: body.title.trim(), description: body.description?.trim() || "", category: body.category, duration: `${String(Math.floor(durationSeconds / 60)).padStart(2, "0")}:${String(durationSeconds % 60).padStart(2, "0")}`, durationSeconds, format, videoUrl: publicR2Url(publicUrl, key), pathname: key, createdAt, featured: 0 });
        completed += 1;
      }
    }
    const metadataKey = `metadata/${body.publicationId}.json`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: metadataKey, Body: JSON.stringify(records), ContentType: "application/json", CacheControl: "no-cache" }));
    return NextResponse.json({ ok: true, completed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NÃ£o foi possÃ­vel publicar no Cloudflare R2." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!authorizeIp(request)) return NextResponse.json({ error: "Este IP não tem permissão para editar." }, { status: 403 });
  try {
    const body = await request.json() as { publicationId?: string; publishedAt?: string; title?: string };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.publishedAt || "") || (!body.publicationId && !body.title?.trim())) throw new Error("Indica uma publicação e uma data válidas.");
    const date = new Date(`${body.publishedAt}T12:00:00`);
    if (Number.isNaN(date.getTime())) throw new Error("A data do timelapse é inválida.");
    const { client, bucket } = r2Config();
    let key = body.publicationId && /^[a-f0-9-]{36}$/.test(body.publicationId) ? `metadata/${body.publicationId}.json` : "";
    let records: Array<Record<string, unknown>> = [];
    const readRecords = async (candidate: string) => {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: candidate }));
      const raw = object.Body && "transformToString" in object.Body ? await object.Body.transformToString() : "";
      return JSON.parse(raw) as Array<Record<string, unknown>>;
    };
    if (key) {
      try { records = await readRecords(key); } catch { records = []; }
    }
    if (!records.length && body.title?.trim()) {
      let continuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "metadata/", ContinuationToken: continuationToken }));
        for (const item of page.Contents || []) {
          if (!item.Key) continue;
          try {
            const candidate = await readRecords(item.Key);
            if (candidate[0]?.title === body.title.trim()) { key = item.Key; records = candidate; break; }
          } catch { /* ignore unrelated metadata */ }
        }
        if (records.length) break;
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
    }
    if (!records.length || !key) throw new Error("Publicação não encontrada. Publica primeiro este vídeo ou confirma o título.");
    for (const record of records) record.createdAt = date.toISOString();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(records), ContentType: "application/json", CacheControl: "no-cache" }));
    return NextResponse.json({ ok: true, createdAt: date.toISOString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível editar a data." }, { status: 400 });
  }
}
