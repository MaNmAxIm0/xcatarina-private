type FetchPlaylist = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
export type HlsSegment = { url: string; duration: number; start: number };

export async function resolveVodPlaylist(manifestUrl: string, fetchPlaylist: FetchPlaylist = (url) => fetch(url, { cache: "no-store" })) {
  const readPlaylist = async (url: string) => {
    const response = await fetchPlaylist(url);
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
  const lines = media.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  let timeline = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#EXTINF:([\d.]+)/);
    if (!match) continue;
    const segmentDuration = Number(match[1]);
    const next = lines.slice(index + 1).find((line) => line.trim() && !line.startsWith("#"));
    if (!next || !Number.isFinite(segmentDuration)) continue;
    const segmentUrl = new URL(next.trim(), mediaUrl);
    if (!segmentUrl.search) segmentUrl.search = new URL(mediaUrl).search;
    segments.push({ url: segmentUrl.toString(), duration: segmentDuration, start: timeline });
    timeline += segmentDuration;
  }
  if (!segments.length) throw new Error("A lista Twitch não contém segmentos de vídeo utilizáveis.");
  return { mediaUrl, duration, segments };
}

/** Keeps every segment between the first and last marker so FFmpeg accelerates
 * the actual continuous video rather than a set of distant still-like excerpts. */
export function buildClipPlaylist(segments: HlsSegment[], startAt: number, endAt: number) {
  const eligible = segments.filter((segment) => segment.start + segment.duration > startAt && segment.start < endAt);
  if (!eligible.length) throw new Error("O intervalo escolhido não contém vídeo.");

  const first = eligible[0];
  const last = eligible[eligible.length - 1];
  const selectedDuration = eligible.reduce((total, segment) => total + segment.duration, 0);
  const trimStart = Math.max(0, startAt - first.start);
  const trimEnd = Math.min(selectedDuration, endAt - first.start, last.start + last.duration - first.start);
  const clipDuration = trimEnd - trimStart;
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new Error("O intervalo escolhido é demasiado curto.");

  const target = Math.max(1, Math.ceil(Math.max(...eligible.map((segment) => segment.duration))));
  const body = eligible.flatMap((segment) => [
    `#EXTINF:${segment.duration.toFixed(6)},`,
    segment.url,
  ]);

  return {
    content: ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", ...body, "#EXT-X-ENDLIST", ""].join("\n"),
    selectedCount: eligible.length,
    trimStart,
    clipDuration,
  };
}
