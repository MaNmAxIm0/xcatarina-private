import assert from "node:assert/strict";
import test from "node:test";
import { buildSparsePlaylist, resolveVodPlaylist } from "../app/lib/hls.ts";

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
  assert.equal(result.segments.length, 3);
  assert.deepEqual(result.segments.map(({ duration, start }) => ({ duration, start })), [
    { duration: 10, start: 0 },
    { duration: 9.5, start: 10 },
    { duration: .5, start: 19.5 },
  ]);
  assert.deepEqual(requested, [
    "https://usher.ttvnw.net/vod/123.m3u8?sig=x&token=y",
    "https://usher.ttvnw.net/vod/source/index.m3u8?sig=x&token=y",
  ]);
});

test("creates an evenly distributed sparse playlist for a long VOD", () => {
  const segments = Array.from({ length: 360 }, (_, index) => ({
    url: `https://video-edge.example/${index}.ts?auth=x`,
    duration: 10,
    start: index * 10,
  }));
  const sample = buildSparsePlaylist(segments, 0, 3600, 60);
  assert.equal(sample.totalCount, 360);
  assert.equal(sample.selectedCount, 48);
  assert.equal(sample.selectedDuration, 480);
  assert.match(sample.content, /0\.ts\?auth=x/);
  assert.match(sample.content, /359\.ts\?auth=x/);
  assert.equal((sample.content.match(/#EXTINF:/g) || []).length, 48);
});

test("rejects an expired or empty playlist", async () => {
  await assert.rejects(
    resolveVodPlaylist("https://usher.ttvnw.net/vod/123.m3u8", async () => ({ ok: false, async text() { return ""; } })),
    /expirou/,
  );
});
