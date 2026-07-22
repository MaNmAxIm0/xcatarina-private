import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { getCapturedTwitchSession } from "../../../lib/twitch-session";
import { buildClipPlaylist, resolveVodPlaylist } from "../../../lib/hls";

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
  segmentCount?: number;
};

const root = process.cwd();
const workDir = path.join(root, "work");
const outputDir = path.join(root, "outputs");
const ffmpegBinary = path.join(/* turbopackIgnore: true */ root, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

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

async function createWatermark(file: string) {
  const svg = `
    <svg width="520" height="104" viewBox="0 0 520 104" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="520" height="104" rx="24" fill="#120d1c" fill-opacity="0.72"/>
      <g transform="translate(22 16) scale(3)">
        <path fill="#9146ff" d="M4.265 0 0 4.266v15.469h5.333V24L9.6 19.735h3.2l7.465-7.465V0h-16zm14.4 11.467-3.2 3.2h-3.2l-2.8 2.8v-2.8h-3.6V2.135h12.8v9.332z"/>
        <path fill="#fff" d="M13.865 5.334h2.133v6.4h-2.133v-6.4zm-5.866 0h2.133v6.4H7.999v-6.4z"/>
      </g>
      <text x="112" y="50" fill="#fff" font-family="Arial, sans-serif" font-size="31" font-weight="700">xCatarina</text>
      <text x="112" y="78" fill="#f6a9ca" font-family="Arial, sans-serif" font-size="19" font-weight="600">twitch.tv/xcatarina</text>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function processJob(job: Job, manifestUrl: string, targetDuration: number, focus: number, startAt: number, endAt: number) {
  try {
    job.state = "probing";
    job.progress = 1;
    await save(job);
    const { duration: fullDuration, segments } = await resolveVodPlaylist(manifestUrl);
    const clipStart = Math.min(Math.max(0, startAt), Math.max(0, fullDuration - 1));
    const clipEnd = endAt > clipStart ? Math.min(endAt, fullDuration) : fullDuration;
    const clip = buildClipPlaylist(segments, clipStart, clipEnd);
    job.segmentCount = clip.selectedCount;
    await save(job);
    if (clip.clipDuration < targetDuration) throw new Error("A duração final tem de ser igual ou inferior ao intervalo escolhido.");
    const speed = clip.clipDuration / targetDuration;
    const focusRatio = Math.min(1, Math.max(0, focus / 100));
    await mkdir(outputDir, { recursive: true });
    const clipPlaylist = path.join(workDir, `${job.id}-clip.m3u8`);
    const watermark = path.join(workDir, `${job.id}-watermark.png`);
    await Promise.all([
      writeFile(clipPlaylist, clip.content, "utf8"),
      createWatermark(watermark),
    ]);

    job.state = "processing";
    job.currentFormat = undefined;
    job.progress = 2;
    await save(job);
    const horizontalOutput = path.join(outputDir, `${job.id}-horizontal.mp4`);
    const verticalOutput = path.join(outputDir, `${job.id}-vertical.mp4`);
    const filter = `[0:v]trim=start=${clip.trimStart.toFixed(6)}:duration=${clip.clipDuration.toFixed(6)},setpts=(PTS-STARTPTS)/${speed},fps=60:round=near,split=2[wide][tall];[1:v]format=rgba,split=2[wmwide][wmtall];[wide]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x120d1c,setsar=1,format=yuv420p[widebase];[wmwide]scale=520:-1[wmw];[widebase][wmw]overlay=40:H-h-36:shortest=1,format=yuv420p[horizontal];[tall]crop='ih*9/16:ih:(iw-ow)*${focusRatio}:0',scale=1080:1920,setsar=1,format=yuv420p[tallbase];[wmtall]scale=440:-1[wmv];[tallbase][wmv]overlay=32:H-h-32:shortest=1,format=yuv420p[vertical]`;
    let lastSaved = 0;
    const args = ["-hide_banner", "-loglevel", "error", "-stats", "-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-fflags", "+genpts", "-i", clipPlaylist, "-loop", "1", "-i", watermark];
    args.push(
      "-filter_complex", filter,
      "-map", "[horizontal]", "-an", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-r", "60", "-movflags", "+faststart", "-y", horizontalOutput,
      "-map", "[vertical]", "-an", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-r", "60", "-movflags", "+faststart", "-y", verticalOutput,
    );
    await run(ffmpegBinary, args, (line) => {
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
  } finally {
    await Promise.all([
      rm(path.join(workDir, `${job.id}-clip.m3u8`), { force: true }),
      rm(path.join(workDir, `${job.id}-watermark.png`), { force: true }),
    ]);
  }
}

export async function POST(request: Request) {
  if (process.env.VERCEL) return NextResponse.json({ error: "A importação de VOD só está disponível no estúdio local." }, { status: 403 });
  const session = getCapturedTwitchSession();
  if (!session) return NextResponse.json({ error: "Abre a VOD na Twitch com o helper ativo para autorizar o acesso." }, { status: 409 });
  const body = await request.json().catch(() => ({})) as { duration?: number; focus?: number; start?: string; end?: string };
  const targetDuration = Math.min(1800, Math.max(5, Number(body.duration) || 15));
  const requestedFocus = Number(body.focus);
  const focus = Number.isFinite(requestedFocus) ? requestedFocus : 77;
  const job: Job = { id: randomUUID(), state: "queued", progress: 0, outputs: {} };
  await save(job);
  void processJob(job, session.manifestUrl, targetDuration, focus, seconds(body.start), seconds(body.end));
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
