import assert from "node:assert/strict";
import test from "node:test";
import { resolveVodPlaylist } from "../app/lib/hls.ts";

test("selects the highest-bandwidth HLS rendition and sums its segments", async () => {
  const requested = [];
  const playlists = new Map([
    ["https://usher.ttvnw.net/vod/123.m3u8?sig=x&token=y", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6000000\nsource/index.m3u8"],
    ["https://usher.ttvnw.net/vod/source/index.m3u8?sig=x&token=y", "#EXTM3U\n#EXTINF:10.0,\na.ts\n#EXTINF:9.5,\nb.ts\n#EXTINF:0.5,\nc.ts\n#EXT-X-ENDLIST"],
  ]);
  const fetchPlaylist = async (url) => {
    requested.push(url);
    const body = playlists.get(url);
    return { ok: Boolean(body), async text() { return body || ""; } };
  };
  const result = await resolveVodPlaylist("https://usher.ttvnw.net/vod/123.m3u8?sig=x&token=y", fetchPlaylist);
  assert.equal(result.mediaUrl, "https://usher.ttvnw.net/vod/source/index.m3u8?sig=x&token=y");
  assert.equal(result.duration, 20);
  assert.deepEqual(requested, [
    "https://usher.ttvnw.net/vod/123.m3u8?sig=x&token=y",
    "https://usher.ttvnw.net/vod/source/index.m3u8?sig=x&token=y",
  ]);
});

test("rejects an expired or empty playlist", async () => {
  await assert.rejects(
    resolveVodPlaylist("https://usher.ttvnw.net/vod/123.m3u8", async () => ({ ok: false, async text() { return ""; } })),
    /expirou/,
  );
});
