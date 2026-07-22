type FetchPlaylist = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

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
  return { mediaUrl, duration };
}
