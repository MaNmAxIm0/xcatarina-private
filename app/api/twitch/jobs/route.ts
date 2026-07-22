import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import { NextResponse } from "next/server";
import { getCapturedTwitchSession } from "../../../lib/twitch-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Format = "horizontal" | "vertical";
type Job = {
  id: string;
  state: "queued" | "probing" | "processing" | "complete" | "error";
  progress: number;
  currentFormat?: Format;
  error?: string;
  outputs?: Partial<Record<Format, string>>;
};

const root = process.cwd();
const workDir = path.join(root, "work");
const outputDir = path.join(root, "outputs");

async function save(job: Job) {
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, `${job.id}.json`), JSON.stringify(job), "utf8");
}

function run(binary: string, args: string[], onLine?: (line: string) => void) {
  return new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => {
      const text: string = data.toString();
      stderr = (stderr + text).slice(-8000);
      text.split(/\r?\n/).forEach((line) => onLine?.(line));
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout }) : reject(new Error(stderr || `O processo terminou com o código ${code}.`)));
  });
}

function seconds(value: string | undefined) {
  if (!value?.trim()) return 0;
  const parts = value.trim().split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function resolveVodPlaylist(manifestUrl: string) {
  const readPlaylist = async (url: string) => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("A autorização temporária da Twitch expirou. Reproduz novamente a VOD para a renovar.");
    return response.text();
  };
  const master = await readPlaylist(manifestUrl);
  let mediaUrl = manifestUrl;
  let media = master;
  if (master.includes("#EXT-X-STREAM-INF")) {
    const lines = master.split(/\r?\n/);
    const variants: { bandwidth: number; url: string }[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith("#EXT-X-STREAM-INF")) continue;
      const next = lines.slice(index + 1).find((line) => line.trim() && !line.startsWith("#"));
      if (!next) continue;
      const candidate = new URL(next.trim(), manifestUrl);
      if (!candidate.search) candidate.search = new URL(manifestUrl).search;
      variants.push({ bandwidth: Number(lines[index].match(/BANDWIDTH=(\d+)/)?.[1] || 0), url: candidate.toString() });
    }
    const best = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!best) throw new Error("A Twitch não devolveu uma qualidade de vídeo utilizável.");
    mediaUrl = best.url;
    media = await readPlaylist(mediaUrl);
  }
  const durations = [...media.matchAll(/#EXTINF:([\d.]+)/g)].map((match) => Number(match[1]));
  const duration = durations.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Não foi possível determinar a duração da VOD.");
  return { mediaUrl, duration };
}

async function processJob(job: Job, manifestUrl: string, targetDuration: number, focus: number, startAt: number, endAt: number) {
  try {
    job.state = "probing";
    job.progress = 1;
    await save(job);
    const { mediaUrl, duration: fullDuration } = await resolveVodPlaylist(manifestUrl);
    const clipStart = Math.min(Math.max(0, startAt), Math.max(0, fullDuration - 1));
    const clipEnd = endAt > clipStart ? Math.min(endAt, fullDuration) : fullDuration;
    const sourceDuration = clipEnd - clipStart;
    const speed = sourceDuration / targetDuration;
    const focusRatio = Math.min(1, Math.max(.5, focus / 100));
    await mkdir(outputDir, { recursive: true });

    job.state = "processing";
    job.currentFormat = undefined;
    job.progress = 2;
    await save(job);
    const horizontalOutput = path.join(outputDir, `${job.id}-horizontal.mp4`);
    const verticalOutput = path.join(outputDir, `${job.id}-vertical.mp4`);
    const filter = `[0:v]setpts=PTS/${speed},fps=24,split=2[wide][tall];[wide]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x120d1c,format=yuv420p[horizontal];[tall]crop='ih*9/16:ih:min(max(0,iw*${focusRatio}-ow/2),iw-ow):0',scale=720:1280,format=yuv420p[vertical]`;
    let lastSaved = 0;
    const args = ["-hide_banner", "-loglevel", "error", "-stats", "-ss", String(clipStart), "-i", mediaUrl];
    if (clipEnd < fullDuration) args.push("-t", String(sourceDuration));
    args.push(
      "-filter_complex", filter,
      "-map", "[horizontal]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-movflags", "+faststart", "-y", horizontalOutput,
      "-map", "[vertical]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-movflags", "+faststart", "-y", verticalOutput,
    );
    await run(ffmpegPath || "ffmpeg", args, (line) => {
      const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return;
      const rendered = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      const percent = Math.min(97, Math.floor((rendered / targetDuration) * 97));
      if (percent > lastSaved) {
        lastSaved = percent;
        job.progress = 2 + percent;
        void save(job);
      }
    });
    job.outputs = {
      horizontal: `/api/twitch/jobs/${job.id}/file/horizontal`,
      vertical: `/api/twitch/jobs/${job.id}/file/vertical`,
    };
    await save(job);
    job.state = "complete";
    job.currentFormat = undefined;
    job.progress = 100;
    await save(job);
  } catch (error) {
    job.state = "error";
    job.error = error instanceof Error ? error.message : "Não foi possível processar a VOD.";
    await save(job);
  }
}

export async function POST(request: Request) {
  if (process.env.VERCEL) return NextResponse.json({ error: "A importação de VOD só está disponível no estúdio local." }, { status: 403 });
  const session = getCapturedTwitchSession();
  if (!session) return NextResponse.json({ error: "Abre a VOD na Twitch com o helper ativo para autorizar o acesso." }, { status: 409 });
  const body = await request.json().catch(() => ({})) as { duration?: number; focus?: number; start?: string; end?: string };
  const targetDuration = Math.min(1800, Math.max(5, Number(body.duration) || 15));
  const job: Job = { id: randomUUID(), state: "queued", progress: 0, outputs: {} };
  await save(job);
  void processJob(job, session.manifestUrl, targetDuration, Number(body.focus) || 77, seconds(body.start), seconds(body.end));
  return NextResponse.json({ id: job.id });
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ error: "Tarefa inválida." }, { status: 400 });
  try {
    const job = JSON.parse(await readFile(path.join(workDir, `${id}.json`), "utf8")) as Job;
    return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Tarefa não encontrada." }, { status: 404 });
  }
}
