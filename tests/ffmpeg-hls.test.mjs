import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { buildClipPlaylist, resolveVodPlaylist } from "../app/lib/hls.ts";

function ffmpeg(args) {
  const result = spawnSync(ffmpegPath, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function ffmpegAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `FFmpeg terminou com ${code}.`)));
  });
}

test("creates a clean 1080p60 horizontal base, derives both formats, and reuses the base when shortening", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xcatarina-hls-"));
  const server = createServer(async (request, response) => {
    try {
      const name = path.basename(new URL(request.url || "/", "http://localhost").pathname);
      const body = await readFile(path.join(directory, name));
      response.writeHead(200, { "Content-Type": name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  try {
    ffmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-hls_time", "1", "-hls_segment_filename", path.join(directory, "segment-%02d.ts"), "-y", path.join(directory, "media.m3u8")]);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const mediaUrl = `http://127.0.0.1:${address.port}/media.m3u8?auth=test`;
    const vod = await resolveVodPlaylist(mediaUrl);
    const clip = buildClipPlaylist(vod.segments, 0, vod.duration);
    assert.equal(clip.selectedCount, vod.segments.length);
    const playlist = path.join(directory, "clip.m3u8");
    await writeFile(playlist, clip.content, "utf8");
    const watermark = path.join(directory, "watermark.png");
    await sharp(Buffer.from('<svg width="520" height="104" xmlns="http://www.w3.org/2000/svg"><rect width="520" height="104" rx="24" fill="#120d1c" fill-opacity=".72"/><circle cx="52" cy="52" r="32" fill="#9146ff"/><text x="100" y="65" fill="white" font-size="38">xCatarina</text></svg>')).png().toFile(watermark);
    const horizontal = path.join(directory, "horizontal.mp4");
    const vertical = path.join(directory, "vertical.mp4");
    const base = path.join(directory, "horizontal-base.mp4");
    const shortened = path.join(directory, "horizontal-base-shortened.mp4");
    const ending = path.join(directory, "ending.png");
    const withOutro = path.join(directory, "horizontal-with-outro.mp4");
    const speed = clip.clipDuration;
    const baseFilter = `trim=start=${clip.trimStart}:duration=${clip.clipDuration},setpts=(PTS-STARTPTS)/${speed},fps=60:round=near,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x120d1c,setsar=1,format=yuv420p`;
    await ffmpegAsync(["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-fflags", "+genpts", "-i", playlist, "-vf", baseFilter, "-an", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-r", "60", "-y", base]);
    await ffmpegAsync(["-hide_banner", "-loglevel", "error", "-i", base, "-loop", "1", "-i", watermark, "-filter_complex", "[1:v]scale=520:-1[wm];[0:v][wm]overlay=40:H-h-36:shortest=1,format=yuv420p[out]", "-map", "[out]", "-an", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-r", "60", "-y", horizontal]);
    const verticalFilter = "[0:v]crop='trunc(ih*9/16/2)*2:ih:(iw-ow)*0.77:0',scale=1080:1920,setsar=1,format=yuv420p[base];[1:v]scale=620:-1[wm];[base][wm]overlay=32:H-h-32:shortest=1,format=yuv420p[out]";
    await ffmpegAsync(["-hide_banner", "-loglevel", "error", "-i", base, "-loop", "1", "-i", watermark, "-filter_complex", verticalFilter, "-map", "[out]", "-an", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-r", "60", "-y", vertical]);
    await ffmpegAsync(["-hide_banner", "-loglevel", "error", "-i", base, "-vf", "setpts=(PTS-STARTPTS)/2,fps=60:round=near,format=yuv420p", "-an", "-t", "0.5", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-r", "60", "-y", shortened]);
    await sharp({ create: { width: 600, height: 800, channels: 3, background: "#f6a9ca" } }).png().toFile(ending);
    const outroFilter = "[0:v]setpts=(PTS-STARTPTS)/1.333333333,trim=duration=0.75,fps=60,format=yuv420p[main];[2:v]split=2[bgsrc][fgsrc];[bgsrc]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:2,setsar=1[bg];[fgsrc]scale=1720:900:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=0:d=0.1:alpha=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,trim=duration=0.25,setpts=PTS-STARTPTS,fps=60,format=yuv420p[still];[main][still]concat=n=2:v=1:a=0[joined];[1:v]scale=520:-1[wm];[joined][wm]overlay=40:H-h-36:shortest=1,format=yuv420p[out]";
    await ffmpegAsync(["-hide_banner", "-loglevel", "error", "-i", base, "-loop", "1", "-i", watermark, "-loop", "1", "-i", ending, "-filter_complex", outroFilter, "-map", "[out]", "-an", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-r", "60", "-y", withOutro]);
    assert.ok((await stat(base)).size > 1_000);
    assert.ok((await stat(horizontal)).size > 1_000);
    assert.ok((await stat(vertical)).size > 1_000);
    assert.ok((await stat(shortened)).size > 1_000);
    assert.ok((await stat(withOutro)).size > 1_000);
    const inspection = spawnSync(ffmpegPath, ["-hide_banner", "-i", horizontal, "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
    assert.match(inspection.stderr, /Video: h264/);
    assert.match(inspection.stderr, /1920x1080/);
    assert.match(inspection.stderr, /60 fps/);
    const verticalInspection = spawnSync(ffmpegPath, ["-hide_banner", "-i", vertical, "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
    assert.match(verticalInspection.stderr, /1080x1920/);
    const hashes = spawnSync(ffmpegPath, ["-v", "error", "-i", horizontal, "-map", "0:v:0", "-f", "framemd5", "-"], { encoding: "utf8", windowsHide: true });
    assert.equal(hashes.status, 0, hashes.stderr);
    const frameHashes = hashes.stdout.split(/\r?\n/).filter((line) => /^0,/.test(line)).map((line) => line.split(",").at(-1)?.trim());
    assert.ok(frameHashes.length >= 58 && frameHashes.length <= 62, `Esperava cerca de 60 frames, recebi ${frameHashes.length}.`);
    assert.ok(new Set(frameHashes).size >= 58, "Os frames 60 fps devem representar momentos distintos.");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
