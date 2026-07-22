import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ffmpegBinary = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

function runFfmpeg(input: string, output: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary, [
      "-hide_banner", "-loglevel", "error", "-i", input,
      "-map", "0:v:0", "-an", "-vf", "setpts=N/(60*TB),fps=60:round=near", "-c:v", "libx264", "-preset", "fast",
      "-crf", "20", "-pix_fmt", "yuv420p", "-r", "60", "-movflags", "+faststart", "-y", output,
    ], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-8000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `A conversão terminou com o código ${code}.`)));
  });
}

export async function POST(request: Request) {
  if (process.env.VERCEL) return NextResponse.json({ error: "A conversão MP4 está disponível no estúdio local." }, { status: 403 });
  if (!request.body) return NextResponse.json({ error: "Não foi recebido nenhum vídeo." }, { status: 400 });

  const directory = path.join(/* turbopackIgnore: true */ process.cwd(), "work");
  const id = randomUUID();
  const input = path.join(directory, `${id}.webm`);
  const output = path.join(directory, `${id}.mp4`);
  await mkdir(directory, { recursive: true });

  try {
    await pipeline(Readable.fromWeb(request.body as never), createWriteStream(input));
    await runFfmpeg(input, output);
    await rm(input, { force: true });
    const info = await stat(output);
    const file = createReadStream(output);
    const cleanup = () => { void rm(output, { force: true }); };
    file.once("close", cleanup);
    file.once("error", cleanup);
    return new NextResponse(Readable.toWeb(file) as ReadableStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(info.size),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível converter o vídeo para MP4." }, { status: 500 });
  }
}
