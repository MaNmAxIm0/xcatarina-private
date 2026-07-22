import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import { buildSparsePlaylist, resolveVodPlaylist } from "../app/lib/hls.ts";

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

test("processes a sparse HLS VOD into horizontal and vertical MP4 files in one pass", { timeout: 30_000 }, async () => {
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
    ffmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=6", "-c:v", "libx264", "-g", "12", "-hls_time", "1", "-hls_segment_filename", path.join(directory, "segment-%02d.ts"), "-y", path.join(directory, "media.m3u8")]);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const mediaUrl = `http://127.0.0.1:${address.port}/media.m3u8?auth=test`;
    const vod = await resolveVodPlaylist(mediaUrl);
    const sparse = buildSparsePlaylist(vod.segments, 0, vod.duration, 2, 2);
    assert.ok(sparse.selectedCount < sparse.totalCount);
    const playlist = path.join(directory, "sample.m3u8");
    await writeFile(playlist, sparse.content, "utf8");
    const horizontal = path.join(directory, "horizontal.mp4");
    const vertical = path.join(directory, "vertical.mp4");
    const speed = sparse.selectedDuration / 2;
    const filter = `[0:v]setpts=PTS/${speed},fps=12,split=2[wide][tall];[wide]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p[horizontal];[tall]crop='ih*9/16:ih:min(max(0,iw*0.77-ow/2),iw-ow):0',scale=360:640,format=yuv420p[vertical]`;
    await ffmpegAsync(["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-fflags", "+genpts", "-i", playlist, "-filter_complex", filter, "-map", "[horizontal]", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-y", horizontal, "-map", "[vertical]", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-y", vertical]);
    assert.ok((await stat(horizontal)).size > 1_000);
    assert.ok((await stat(vertical)).size > 1_000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
