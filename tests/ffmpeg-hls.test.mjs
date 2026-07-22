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

test("accelerates a continuous HLS VOD into distinct-frame 1080p60 horizontal and vertical MP4 files", { timeout: 120_000 }, async () => {
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
    const speed = clip.clipDuration;
    const filter = `[0:v]trim=start=${clip.trimStart}:duration=${clip.clipDuration},setpts=(PTS-STARTPTS)/${speed},fps=60:round=near,split=2[wide][tall];[1:v]format=rgba,split=2[wmwide][wmtall];[wide]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x120d1c,setsar=1,format=yuv420p[widebase];[wmwide]scale=520:-1[wmw];[widebase][wmw]overlay=40:H-h-36:shortest=1,format=yuv420p[horizontal];[tall]crop='ih*9/16:ih:(iw-ow)*0.77:0',scale=1080:1920,setsar=1,format=yuv420p[tallbase];[wmtall]scale=440:-1[wmv];[tallbase][wmv]overlay=32:H-h-32:shortest=1,format=yuv420p[vertical]`;
    await ffmpegAsync(["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-fflags", "+genpts", "-i", playlist, "-loop", "1", "-i", watermark, "-filter_complex", filter, "-map", "[horizontal]", "-an", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-r", "60", "-y", horizontal, "-map", "[vertical]", "-an", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-r", "60", "-y", vertical]);
    assert.ok((await stat(horizontal)).size > 1_000);
    assert.ok((await stat(vertical)).size > 1_000);
    const inspection = spawnSync(ffmpegPath, ["-hide_banner", "-i", horizontal, "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
    assert.match(inspection.stderr, /Video: h264/);
    assert.match(inspection.stderr, /1920x1080/);
    assert.match(inspection.stderr, /60 fps/);
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
