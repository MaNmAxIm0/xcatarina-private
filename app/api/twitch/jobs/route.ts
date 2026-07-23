import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { getCapturedTwitchSession } from "../../../lib/twitch-session";
import { buildClipPlaylist, resolveVodPlaylist } from "../../../lib/hls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Format = "horizontal" | "vertical";
const DURATION_VARIANTS = [8, 15, 30, 45, 60, 90] as const;
const STUDIO_DURATIONS = [8, 15, 30, 45, 60, 90, 120, 300, 600] as const;
type VariantOutputs = Record<string, Partial<Record<Format, string>>>;
type Job = {
  id: string;
  state: "queued" | "probing" | "processing" | "complete" | "error";
  progress: number;
  currentFormat?: Format;
  error?: string;
  outputs?: Partial<Record<Format, string>>;
  segmentCount?: number;
  duration?: number;
  startAt?: number;
  endAt?: number;
  baseJobId?: string;
  baseDuration?: number;
  variants?: VariantOutputs;
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
      const output: string = data.toString();
      stderr = (stderr + output).slice(-8000);
      output.split(/\r?\n/).forEach((line) => onLine?.(line));
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

async function renderOutputs(job: Job, baseInput: string, watermark: string, targetDuration: number, focusRatio: number, progressStart: number, outroImage?: string) {
  const horizontalOutput = path.join(outputDir, `${job.id}-${targetDuration}-horizontal.mp4`);
  const verticalOutput = path.join(outputDir, `${job.id}-${targetDuration}-vertical.mp4`);

  job.currentFormat = "horizontal";
  job.progress = progressStart + 3;
  await save(job);
  const outroDuration = targetDuration < 60 ? 2 : 3;
  const mainDuration = targetDuration - outroDuration;
  const inputArgs = ["-hide_banner", "-loglevel", "error", "-stats", "-i", baseInput, "-loop", "1", "-i", watermark];
  if (outroImage) inputArgs.push("-loop", "1", "-i", outroImage);
  const horizontalFilter = outroImage
    ? `[0:v]setpts=(PTS-STARTPTS)/${targetDuration / mainDuration},trim=duration=${mainDuration},fps=60,format=yuv420p[main];[2:v]split=2[bgsrc][fgsrc];[bgsrc]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:2,setsar=1[bg];[fgsrc]scale=1720:900:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=0:d=0.35:alpha=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,trim=duration=${outroDuration},setpts=PTS-STARTPTS,fps=60,format=yuv420p[still];[main][still]concat=n=2:v=1:a=0[joined];[1:v]scale=520:-1[wm];[joined][wm]overlay=40:H-h-36:shortest=1,format=yuv420p[out]`
    : "[1:v]scale=520:-1[wm];[0:v][wm]overlay=40:H-h-36:shortest=1,format=yuv420p[out]";
  await run(ffmpegBinary, [
    ...inputArgs,
    "-filter_complex", horizontalFilter,
    "-map", "[out]", "-an", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-r", "60", "-movflags", "+faststart", "-y", horizontalOutput,
  ]);
  job.variants = { ...(job.variants || {}), [String(targetDuration)]: { horizontal: `/api/twitch/jobs/${job.id}/file/horizontal?duration=${targetDuration}` } };
  job.outputs = { ...(job.outputs || {}), horizontal: job.variants[String(targetDuration)].horizontal };
  await save(job);

  job.currentFormat = "vertical";
  job.progress = progressStart + 7;
  await save(job);
  const verticalFilter = outroImage
    ? `[0:v]crop='trunc(ih*9/16/2)*2:ih:(iw-ow)*${focusRatio}:0',scale=1080:1920,setsar=1,setpts=(PTS-STARTPTS)/${targetDuration / mainDuration},trim=duration=${mainDuration},fps=60,format=yuv420p[main];[2:v]split=2[bgsrc][fgsrc];[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:2,setsar=1[bg];[fgsrc]scale=960:1600:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=0:d=0.35:alpha=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,trim=duration=${outroDuration},setpts=PTS-STARTPTS,fps=60,format=yuv420p[still];[main][still]concat=n=2:v=1:a=0[joined];[1:v]scale=620:-1[wm];[joined][wm]overlay=32:H-h-32:shortest=1,format=yuv420p[out]`
    : `[0:v]crop='trunc(ih*9/16/2)*2:ih:(iw-ow)*${focusRatio}:0',scale=1080:1920,setsar=1,format=yuv420p[base];[1:v]scale=620:-1[wm];[base][wm]overlay=32:H-h-32:shortest=1,format=yuv420p[out]`;
  await run(ffmpegBinary, [
    ...inputArgs,
    "-filter_complex", verticalFilter,
    "-map", "[out]", "-an", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-r", "60", "-movflags", "+faststart", "-y", verticalOutput,
  ]);
}

async function processJob(job: Job, manifestUrl: string, targetDuration: number, focus: number, startAt: number, endAt: number, reuseJobId?: string, outroImage?: string, secondaryManifestUrl?: string) {
  try {
    job.state = "probing";
    job.progress = 1;
    await save(job);
    const focusRatio = Math.min(1, Math.max(0, focus / 100));
    await mkdir(outputDir, { recursive: true });
    const clipPlaylist = path.join(workDir, `${job.id}-clip.m3u8`);
    const watermark = path.join(workDir, `${job.id}-watermark.png`);
    const baseOutput = path.join(outputDir, `${job.id}-horizontal-base.mp4`);
    await createWatermark(watermark);

    job.state = "processing";
    job.currentFormat = "horizontal";
    job.progress = 2;
    await save(job);
    let args: string[];
    if (reuseJobId) {
      const sourceJob = JSON.parse(await readFile(path.join(workDir, `${reuseJobId}.json`), "utf8")) as Job;
      const baseJobId = sourceJob.baseJobId || sourceJob.id;
      const baseDuration = sourceJob.baseDuration || sourceJob.duration || 0;
      const sourceBase = path.join(outputDir, `${baseJobId}-horizontal-base.mp4`);
      if (sourceJob.state !== "complete" || !baseDuration || targetDuration > baseDuration) {
        throw new Error("Só é possível reutilizar um timelapse concluído para uma duração igual ou menor.");
      }
      if ((sourceJob.startAt || 0) !== startAt || (sourceJob.endAt || 0) !== endAt) {
        throw new Error("Para mudar o início ou o fim é necessário voltar a processar a VOD.");
      }
      const speed = baseDuration / targetDuration;
      job.baseJobId = baseJobId;
      job.baseDuration = baseDuration;
      job.segmentCount = sourceJob.segmentCount;
      if (targetDuration === baseDuration) {
        await copyFile(sourceBase, baseOutput);
        args = [];
      } else {
        args = ["-hide_banner", "-loglevel", "error", "-stats", "-i", sourceBase, "-vf", `setpts=(PTS-STARTPTS)/${speed},fps=60:round=near,format=yuv420p`, "-an", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-r", "60", "-movflags", "+faststart", "-y", baseOutput];
      }
    } else {
      const firstPlaylist = await resolveVodPlaylist(manifestUrl);
      let fullDuration = firstPlaylist.duration;
      let segments = firstPlaylist.segments;
      if (secondaryManifestUrl) {
        const secondPlaylist = await resolveVodPlaylist(secondaryManifestUrl);
        segments = segments.concat(secondPlaylist.segments.map((segment) => ({ ...segment, start: segment.start + fullDuration })));
        fullDuration += secondPlaylist.duration;
      }
      const clipStart = Math.min(Math.max(0, startAt), Math.max(0, fullDuration - 1));
      const clipEnd = endAt > clipStart ? Math.min(endAt, fullDuration) : fullDuration;
      const clip = buildClipPlaylist(segments, clipStart, clipEnd);
      job.segmentCount = clip.selectedCount;
      await save(job);
      if (clip.clipDuration < targetDuration) throw new Error("A duração final tem de ser igual ou inferior ao intervalo escolhido.");
      const speed = clip.clipDuration / targetDuration;
      job.baseJobId = job.id;
      job.baseDuration = targetDuration;
      await writeFile(clipPlaylist, clip.content, "utf8");
      const baseFilter = `trim=start=${clip.trimStart.toFixed(6)}:duration=${clip.clipDuration.toFixed(6)},setpts=(PTS-STARTPTS)/${speed},fps=60:round=near,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x120d1c,setsar=1,format=yuv420p`;
      args = ["-hide_banner", "-loglevel", "error", "-stats", "-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-fflags", "+genpts", "-i", clipPlaylist, "-vf", baseFilter, "-an", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-r", "60", "-movflags", "+faststart", "-y", baseOutput];
    }

    let lastSaved = 0;
    if (args.length) await run(ffmpegBinary, args, (line) => {
      const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return;
      const rendered = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      const percent = Math.min(30, Math.floor((rendered / targetDuration) * 30));
      if (percent > lastSaved) {
        lastSaved = percent;
        job.progress = 2 + percent;
        void save(job);
      }
    });
    const requestedStudioDuration = STUDIO_DURATIONS.includes(job.duration as typeof STUDIO_DURATIONS[number]) ? job.duration || 30 : 30;
    const durations = requestedStudioDuration > 90 ? [...DURATION_VARIANTS, requestedStudioDuration] : [...DURATION_VARIANTS];
    const variants: VariantOutputs = {};
    for (let index = 0; index < durations.length; index += 1) {
      const variantDuration = durations[index];
      const variantBase = variantDuration === targetDuration ? baseOutput : path.join(workDir, `${job.id}-${variantDuration}-base.mp4`);
      const progressStart = Math.floor(32 + index * (66 / durations.length));
      if (variantDuration !== targetDuration) {
        job.currentFormat = "horizontal";
        job.progress = progressStart;
        await save(job);
        const speed = targetDuration / variantDuration;
        await run(ffmpegBinary, ["-hide_banner", "-loglevel", "error", "-i", baseOutput, "-vf", `setpts=(PTS-STARTPTS)/${speed},fps=60:round=near,format=yuv420p`, "-an", "-t", String(variantDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-r", "60", "-movflags", "+faststart", "-y", variantBase]);
      }
      await renderOutputs(job, variantBase, watermark, variantDuration, focusRatio, progressStart, outroImage);
      variants[String(variantDuration)] = {
        horizontal: `/api/twitch/jobs/${job.id}/file/horizontal?duration=${variantDuration}`,
        vertical: `/api/twitch/jobs/${job.id}/file/vertical?duration=${variantDuration}`,
      };
      if (variantBase !== baseOutput) await rm(variantBase, { force: true });
    }
    job.variants = variants;
    job.outputs = variants["30"];
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
      rm(path.join(workDir, `${job.id}-outro.png`), { force: true }),
    ]);
  }
}

export async function POST(request: Request) {
  if (process.env.VERCEL) return NextResponse.json({ error: "A importação de VOD só está disponível no estúdio local." }, { status: 403 });
  let body: { duration?: number; focus?: number; start?: string; end?: string; reuseJobId?: string } = {};
  let outroFile: File | null = null;
  if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await request.formData();
    body = { duration: Number(form.get("duration")), focus: Number(form.get("focus")), start: String(form.get("start") || ""), end: String(form.get("end") || ""), reuseJobId: String(form.get("reuseJobId") || "") };
    const candidate = form.get("outroImage");
    if (candidate instanceof File && candidate.size) outroFile = candidate;
  } else {
    body = await request.json().catch(() => ({})) as typeof body;
  }
  const requestedDuration = STUDIO_DURATIONS.includes(Number(body.duration) as typeof STUDIO_DURATIONS[number]) ? Number(body.duration) : 30;
  const targetDuration = Math.max(90, requestedDuration);
  const requestedFocus = Number(body.focus);
  const focus = Number.isFinite(requestedFocus) ? requestedFocus : 77;
  const startAt = seconds(body.start);
  const endAt = seconds(body.end);
  const reuseJobId = /^[a-f0-9-]{36}$/.test(body.reuseJobId || "") ? body.reuseJobId : undefined;
  const session = getCapturedTwitchSession();
  if (!session && !reuseJobId) return NextResponse.json({ error: "Abre a VOD na Twitch com o helper ativo para autorizar o acesso." }, { status: 409 });
  const job: Job = { id: randomUUID(), state: "queued", progress: 0, outputs: {}, duration: requestedDuration, startAt, endAt };
  await save(job);
  let outroImage: string | undefined;
  if (outroFile) {
    if (outroFile.size > 20 * 1024 * 1024 || !outroFile.type.startsWith("image/")) return NextResponse.json({ error: "A terceira imagem tem de ser uma imagem até 20 MB." }, { status: 400 });
    outroImage = path.join(workDir, `${job.id}-outro.png`);
    await sharp(Buffer.from(await outroFile.arrayBuffer())).rotate().png().toFile(outroImage);
  }
  void processJob(job, session?.manifestUrl || "", targetDuration, focus, startAt, endAt, reuseJobId, outroImage, session?.secondaryManifestUrl || "");
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

export async function DELETE(request: Request) {
  if (process.env.VERCEL) return NextResponse.json({ error: "Disponível apenas localmente." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { ids?: string[]; all?: boolean };
  const ids = new Set((body.ids || []).filter((id) => /^[a-f0-9-]{36}$/.test(id)));
  for (const id of [...ids]) {
    try {
      const job = JSON.parse(await readFile(path.join(workDir, `${id}.json`), "utf8")) as Job;
      if (job.baseJobId && /^[a-f0-9-]{36}$/.test(job.baseJobId)) ids.add(job.baseJobId);
    } catch { /* O registo pode já ter sido removido. */ }
  }
  const removeMatches = async (directory: string) => {
    const names = await readdir(directory).catch(() => [] as string[]);
    const matches = body.all ? names : names.filter((name) => [...ids].some((id) => name === `${id}.json` || name.startsWith(`${id}-`)));
    await Promise.all(matches.map((name) => rm(path.join(directory, name), { force: true })));
    return matches.length;
  };
  const removed = (await removeMatches(workDir)) + (await removeMatches(outputDir));
  return NextResponse.json({ ok: true, removed });
}





