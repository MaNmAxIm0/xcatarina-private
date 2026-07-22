"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

type Format = "horizontal" | "vertical";
type PhotoSlot = { file: File | null; time: string; isLive: boolean; previewUrl: string };
type LocalJob = { id: string; state: "queued" | "probing" | "processing" | "complete" | "error"; progress: number; currentFormat?: Format; error?: string; outputs?: Partial<Record<Format, string>>; sample?: { selected: number; total: number } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(video: HTMLVideoElement, event: "loadedmetadata" | "seeked") {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Não foi possível ler este vídeo."));
    };
    const cleanup = () => {
      video.removeEventListener(event, done);
      video.removeEventListener("error", failed);
    };
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

export function TimelapseStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [twitchUrl, setTwitchUrl] = useState("");
  const [twitchEmbed, setTwitchEmbed] = useState("");
  const [localMode, setLocalMode] = useState(false);
  const [vodConnected, setVodConnected] = useState(false);
  const [connectedVodId, setConnectedVodId] = useState("");
  const [jobId, setJobId] = useState("");
  const [startAt, setStartAt] = useState("00:00:00");
  const [endAt, setEndAt] = useState("");
  const [format, setFormat] = useState<Format>("horizontal");
  const [category, setCategory] = useState<"arte" | "lego">("lego");
  const [focus, setFocus] = useState(77);
  const [duration, setDuration] = useState(15);
  const [photoSlots, setPhotoSlots] = useState<PhotoSlot[]>([
    { file: null, time: "00:00:00", isLive: true, previewUrl: "" },
    { file: null, time: "00:00:00", isLive: true, previewUrl: "" },
    { file: null, time: "00:00:00", isLive: true, previewUrl: "" },
  ]);
  const selectedSlots = photoSlots.filter((slot): slot is PhotoSlot & { file: File } => Boolean(slot.file));
  const photos = selectedSlots.map((slot) => slot.file);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Escolhe uma gravação para começar.");
  const [downloads, setDownloads] = useState<Partial<Record<Format, string>>>({});
  const [publishTitle, setPublishTitle] = useState("");
  const [publishDescription, setPublishDescription] = useState("");
  const [publishProgress, setPublishProgress] = useState(0);
  const [publishing, setPublishing] = useState<Format | null>(null);
  const [publishStatus, setPublishStatus] = useState("");

  useEffect(() => {
    const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    const modeTimer = window.setTimeout(() => setLocalMode(local), 0);
    if (!local) return () => window.clearTimeout(modeTimer);
    const check = async () => {
      try {
        const result = await fetch("/api/twitch/session", { cache: "no-store" }).then((response) => response.json()) as { available?: boolean; vodId?: string };
        setVodConnected(Boolean(result.available));
        setConnectedVodId(result.vodId || "");
      } catch { setVodConnected(false); }
    };
    void check();
    const timer = window.setInterval(check, 2000);
    return () => { window.clearTimeout(modeTimer); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const check = async () => {
      try {
        const job = await fetch(`/api/twitch/jobs?id=${encodeURIComponent(jobId)}`, { cache: "no-store" }).then((response) => response.json()) as LocalJob;
        if (stopped) return;
        setProgress(job.progress || 0);
        if (job.state === "probing") setStatus("A verificar a duração e o acesso à VOD…");
        if (job.state === "processing") setStatus(job.currentFormat ? `A criar a versão ${job.currentFormat === "vertical" ? "vertical 9:16" : "horizontal 16:9"}…` : `A criar simultaneamente os formatos 16:9 e 9:16${job.sample ? ` com ${job.sample.selected} de ${job.sample.total} segmentos` : ""}…`);
        if (job.state === "complete") {
          setDownloads(job.outputs || {});
          setStatus("As duas versões MP4 estão prontas para descarregar e publicar.");
          setBusy(false);
          setJobId("");
        }
        if (job.state === "error") {
          setStatus(job.error || "Não foi possível processar a VOD.");
          setBusy(false);
          setJobId("");
        }
      } catch {
        if (!stopped) setStatus("Não foi possível consultar o processamento local.");
      }
    };
    void check();
    const timer = window.setInterval(check, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [jobId]);

  useEffect(() => () => {
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
    Object.values(downloads).forEach((url) => url && URL.revokeObjectURL(url));
  }, [sourceUrl, downloads]);

  const drawFrame = (ctx: CanvasRenderingContext2D, video: HTMLVideoElement, outputFormat: Format) => {
    const canvas = ctx.canvas;
    ctx.fillStyle = "#120d1c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (outputFormat === "horizontal") {
      const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      ctx.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      return;
    }

    const sourceRatio = video.videoWidth / video.videoHeight;
    const targetRatio = canvas.width / canvas.height;
    let cropWidth = video.videoWidth;
    let cropHeight = video.videoHeight;
    if (sourceRatio > targetRatio) cropWidth = video.videoHeight * targetRatio;
    else cropHeight = video.videoWidth / targetRatio;
    const centerX = (focus / 100) * video.videoWidth;
    const cropX = Math.max(0, Math.min(video.videoWidth - cropWidth, centerX - cropWidth / 2));
    const cropY = (video.videoHeight - cropHeight) / 2;
    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  };

  const refreshPreview = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = format === "vertical" ? 720 : 1280;
    canvas.height = format === "vertical" ? 1280 : 720;
    const ctx = canvas.getContext("2d");
    if (ctx) drawFrame(ctx, video, format);
  };

  useEffect(refreshPreview, [format, focus, sourceUrl]);

  const chooseVideo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
    setSourceUrl(URL.createObjectURL(file));
    setSourceName(file.name);
    setTwitchEmbed("");
    setDownloads({});
    setStatus("Vídeo pronto. Confirma o enquadramento e gera o timelapse.");
  };

  const tryTwitch = () => {
    try {
      const url = new URL(twitchUrl.trim());
      const parts = url.pathname.split("/").filter(Boolean);
      const parent = window.location.hostname || "localhost";
      let embed = "";
      if (url.hostname.includes("twitch.tv") && parts[0] === "videos" && parts[1]) {
        embed = `https://player.twitch.tv/?video=${encodeURIComponent(parts[1])}&parent=${encodeURIComponent(parent)}&autoplay=false`;
      } else if (url.hostname.includes("twitch.tv") && parts.length >= 3 && parts[1] === "v" && parts[2]) {
        embed = `https://player.twitch.tv/?video=${encodeURIComponent(parts[2])}&parent=${encodeURIComponent(parent)}&autoplay=false`;
      } else if (url.hostname === "clips.twitch.tv" && parts[0]) {
        embed = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(parts[0])}&parent=${encodeURIComponent(parent)}&autoplay=false`;
      } else if (url.hostname.includes("twitch.tv") && parts[0]) {
        embed = `https://player.twitch.tv/?channel=${encodeURIComponent(parts[0])}&parent=${encodeURIComponent(parent)}&autoplay=false`;
      }
      if (!embed) throw new Error();
      setTwitchEmbed(embed);
      if (localMode && (parts[0] === "videos" || parts[1] === "v")) {
        window.open(url.toString(), "_blank", "noopener,noreferrer");
        setStatus("A VOD abriu na Twitch. Inicia sessão e carrega no Play; o helper liga-a automaticamente ao Studio.");
      } else {
        setStatus("Ligação Twitch reconhecida. Podes confirmar a live na pré-visualização.");
      }
    } catch {
      setStatus("Esse link não parece ser um vídeo, clipe ou canal Twitch válido.");
    }
  };

  const generateFromTwitch = async () => {
    if (!vodConnected) {
      setStatus("Instala o helper, abre a VOD na Twitch, inicia sessão e carrega no Play.");
      return;
    }
    setBusy(true);
    setProgress(0);
    setDownloads({});
    setStatus("A iniciar o processamento local da VOD…");
    try {
      const response = await fetch("/api/twitch/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration, focus, start: startAt, end: endAt }),
      });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok || !result.id) throw new Error(result.error || "Não foi possível iniciar o processamento.");
      setJobId(result.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Não foi possível iniciar o processamento.");
      setBusy(false);
    }
  };

  const setPhoto = (index: number, file: File | null) => {
    setPhotoSlots((slots) => slots.map((slot, slotIndex) => {
      if (slotIndex !== index) return slot;
      if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
      return { ...slot, file, previewUrl: file ? URL.createObjectURL(file) : "" };
    }));
  };

  const setPhotoTime = (index: number, time: string) => {
    setPhotoSlots((slots) => slots.map((slot, slotIndex) => slotIndex === index ? { ...slot, time } : slot));
  };

  const setPhotoLive = (index: number, isLive: boolean) => {
    setPhotoSlots((slots) => slots.map((slot, slotIndex) => slotIndex === index ? { ...slot, isLive } : slot));
  };

  const pastePhoto = (index: number, event: React.ClipboardEvent<HTMLDivElement>) => {
    const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
    if (file) { event.preventDefault(); setPhoto(index, file); setStatus(`Imagem ${index + 1} colada com sucesso.`); }
  };

  const drawPhoto = async (ctx: CanvasRenderingContext2D, file: File) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.src = url;
    await image.decode();
    const scale = Math.max(ctx.canvas.width / image.width, ctx.canvas.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    ctx.drawImage(image, (ctx.canvas.width - width) / 2, (ctx.canvas.height - height) / 2, width, height);
    URL.revokeObjectURL(url);
  };

  const loadPhoto = async (file: File) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.src = url;
    await image.decode();
    return { image, url };
  };

  const drawLoadedPhoto = (ctx: CanvasRenderingContext2D, image: HTMLImageElement, cropBorders: boolean) => {
    const scale = cropBorders ? Math.max(ctx.canvas.width / image.width, ctx.canvas.height / image.height) : Math.min(ctx.canvas.width / image.width, ctx.canvas.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    ctx.drawImage(image, (ctx.canvas.width - width) / 2, (ctx.canvas.height - height) / 2, width, height);
  };

  const drawTimestamp = (ctx: CanvasRenderingContext2D, time: string) => {
    if (!time.trim()) return;
    const fontSize = Math.round(ctx.canvas.width * 0.035);
    ctx.font = `800 ${fontSize}px sans-serif`;
    const padding = fontSize * 0.55;
    const width = ctx.measureText(time).width + padding * 2;
    ctx.fillStyle = "rgba(24,19,33,.82)";
    ctx.fillRect(ctx.canvas.width - width - padding, ctx.canvas.height - fontSize - padding * 2, width, fontSize + padding);
    ctx.fillStyle = "#ffd760";
    ctx.fillText(time, ctx.canvas.width - width, ctx.canvas.height - padding * 1.35);
  };

  const generate = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!canvas || (!sourceUrl && photos.length === 0)) {
      setStatus("Escolhe uma gravação ou coloca pelo menos uma imagem.");
      return;
    }
    if (sourceUrl && !video) {
      setStatus("A gravaÃ§Ã£o ainda nÃ£o estÃ¡ pronta. Aguarda o carregamento e tenta novamente.");
      return;
    }
    setBusy(true);
    setProgress(0);
    Object.values(downloads).forEach((url) => url && URL.revokeObjectURL(url));
    setDownloads({});
    setStatus("A criar o timelapse… mantém esta página aberta.");
    try {
      if (sourceUrl && video && (!video.duration || Number.isNaN(video.duration))) {
        await waitFor(video, "loadedmetadata");
      }
      const loadedPhotos = await Promise.all(photos.map(loadPhoto));
      const results: Partial<Record<Format, string>> = {};
      const formats: Format[] = ["horizontal", "vertical"];
      for (let formatIndex = 0; formatIndex < formats.length; formatIndex += 1) {
        const outputFormat = formats[formatIndex];
        setStatus(`A criar a versão ${outputFormat === "horizontal" ? "horizontal" : "vertical"}…`);
        canvas.width = outputFormat === "vertical" ? 720 : 1280;
        canvas.height = outputFormat === "vertical" ? 1280 : 720;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("O navegador não disponibilizou o editor de vídeo.");
        const stream = canvas.captureStream(24);
        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 7_000_000 });
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
        const finished = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
        recorder.start(1000);
        const frames = duration * 24;
        for (let frame = 0; frame < frames; frame += 1) {
          if (sourceUrl && video) {
            const target = Math.min(video.duration - 0.04, (frame / Math.max(1, frames - 1)) * video.duration);
            if (Math.abs(video.currentTime - target) > 0.015) { video.currentTime = target; await waitFor(video, "seeked"); }
            drawFrame(ctx, video, outputFormat);
          } else {
            const imageIndex = Math.min(loadedPhotos.length - 1, Math.floor((frame / frames) * loadedPhotos.length));
            drawLoadedPhoto(ctx, loadedPhotos[imageIndex].image, !selectedSlots[imageIndex].isLive);
            if (selectedSlots[imageIndex].isLive) drawTimestamp(ctx, selectedSlots[imageIndex].time);
          }
          if (frame % 6 === 0) setProgress(Math.round(((formatIndex + frame / frames) / formats.length) * 94));
          await sleep(1000 / 24);
        }
        if (sourceUrl && video) for (let index = 0; index < photos.length; index += 1) { await drawPhoto(ctx, photos[index]); drawTimestamp(ctx, selectedSlots[index].time); await sleep(650); }
        recorder.stop();
        await finished;
        results[outputFormat] = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      }
      setDownloads(results);
      loadedPhotos.forEach(({ url }) => URL.revokeObjectURL(url));
      setProgress(100);
      setStatus("As duas versões estão prontas para descarregar e publicar.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Não foi possível gerar o timelapse.");
    } finally {
      setBusy(false);
    }
  };

  const publishGenerated = async (outputFormat: Format) => {
    const generatedUrl = downloads[outputFormat];
    if (!generatedUrl) return;
    if (!publishTitle.trim()) { setPublishStatus("Escreve um título antes de publicar."); return; }
    setPublishing(outputFormat); setPublishProgress(0); setPublishStatus("A enviar para o site público…");
    try {
      const body = await fetch(generatedUrl).then((response) => response.blob());
      const safeTitle = publishTitle.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "timelapse";
      const extension = body.type === "video/mp4" ? "mp4" : "webm";
      const pathname = `videos/${category}/${Date.now()}-${outputFormat}-${safeTitle}.${extension}`;
      await upload(pathname, body, {
        access: "public",
        handleUploadUrl: "/api/upload",
        multipart: true,
        clientPayload: JSON.stringify({ title: publishTitle.trim(), description: publishDescription.trim(), category, duration: `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`, format: outputFormat }),
        onUploadProgress: ({ percentage }) => setPublishProgress(Math.round(percentage)),
      });
      setPublishStatus("Publicado. O vídeo vai aparecer no arquivo público dentro de instantes.");
    } catch (error) {
      setPublishStatus(error instanceof Error ? error.message : "Não foi possível publicar o vídeo.");
    } finally { setPublishing(null); }
  };

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Estúdio xCatarina">
          <span className="brand-dot">xC</span>
          <span>timelapse studio</span>
        </a>
        <span className="private-pill"><i /> Estúdio privado</span>
      </header>

      <section className="hero" id="top">
        <div>
          <span className="eyebrow">DA LIVE À PEÇA FINAL</span>
          <h1>Transforma horas<br />em <em>segundos.</em></h1>
        </div>
        <p>Importa uma live, escolhe o enquadramento e cria um timelapse pronto para partilhar — sem perder o LEGO de vista.</p>
      </section>

      <section className="workspace">
        <div className="controls">
          <div className="step-heading"><span>01</span><div><h2>Fonte da live</h2><p>Usa o link da Twitch ou a gravação original.</p></div></div>
          <div className="twitch-row">
          <input aria-label="Link da Twitch" value={twitchUrl} onChange={(event) => setTwitchUrl(event.target.value)} placeholder="https://twitch.tv/xcatarina/v/…" />
            <button type="button" className="dark-button" onClick={tryTwitch}>Tentar importar</button>
          </div>
          {localMode && <div className={vodConnected ? "vod-helper connected" : "vod-helper"}>
            <div><b>{vodConnected ? `VOD ${connectedVodId || "Twitch"} ligada` : "Importação direta de VOD"}</b><small>{vodConnected ? "A autorização da tua sessão foi recebida neste computador." : "Instala uma vez o helper Tampermonkey; depois abre a VOD, inicia sessão e carrega no Play."}</small></div>
            <a href="/xcatarina-twitch-helper.user.js" target="_blank" rel="noreferrer">Instalar helper</a>
          </div>}
          <div className="or"><span />ou<span /></div>
          <label className="dropzone">
            <input type="file" accept="video/*" onChange={chooseVideo} />
            <b>{sourceName || "Escolher gravação"}</b>
            <small>MP4, MOV ou WebM · o ficheiro fica neste dispositivo</small>
          </label>

          <div className="divider" />
          <div className="step-heading"><span>02</span><div><h2>Formato</h2><p>Exporta a live completa ou foca a mesa de LEGO.</p></div></div>
          <div className="format-grid">
            <button type="button" className={format === "horizontal" ? "format-card active" : "format-card"} onClick={() => setFormat("horizontal")}>
              <i className="ratio wide" /><b>Live completa</b><small>16:9 · horizontal</small>
            </button>
            <button type="button" className={format === "vertical" ? "format-card active" : "format-card"} onClick={() => setFormat("vertical")}>
              <i className="ratio tall" /><b>LEGO em foco</b><small>9:16 · vertical</small>
            </button>
          </div>
          <div className="content-type" role="group" aria-label="Tipo de criação">
            <span>Conteúdo</span>
            <button type="button" className={category === "arte" ? "active" : ""} onClick={() => setCategory("arte")}>Pintura / Arte</button>
            <button type="button" className={category === "lego" ? "active" : ""} onClick={() => setCategory("lego")}>LEGO</button>
          </div>
          {format === "vertical" && <label className="range-row"><span>Centro do LEGO</span><input aria-label="Posição horizontal do LEGO" type="range" min="50" max="100" value={focus} onChange={(event) => setFocus(Number(event.target.value))} /><output>{focus}%</output></label>}

          <div className="field-row duration-row">
            <label><span>Duração final</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value="8">8 segundos</option><option value="15">15 segundos</option><option value="30">30 segundos</option><option value="60">1 minuto</option><option value="90">1 minuto e 30</option><option value="120">2 minutos</option><option value="300">5 minutos</option><option value="600">10 minutos</option><option value="900">15 minutos</option><option value="1800">30 minutos</option></select></label>
          </div>
          {localMode && <div className="vod-range"><label><span>Início da VOD</span><input value={startAt} onChange={(event) => setStartAt(event.target.value)} placeholder="00:00:00" /></label><label><span>Fim (opcional)</span><input value={endAt} onChange={(event) => setEndAt(event.target.value)} placeholder="até ao fim" /></label></div>}
          <div className="photo-heading"><b>Imagens e horários</b><span>A 3.ª imagem é opcional</span></div>
          <div className="photo-slots">
            {photoSlots.map((slot, index) => <div className={slot.file ? "photo-slot filled" : "photo-slot"} key={index} tabIndex={0} onPaste={(event) => pastePhoto(index, event)}>
              <span className="photo-number">0{index + 1}</span>
              {slot.previewUrl ? <img className="photo-preview" src={slot.previewUrl} alt={`Pré-visualização da imagem ${index + 1}`} /> : <div className="photo-placeholder">Imagem {index + 1}</div>}
              <b>{slot.file?.name || "Colar ou escolher imagem"}</b>
              <small>Ctrl+V nesta caixa</small>
              <label className="file-button">Escolher ficheiro<input type="file" accept="image/*" onChange={(event) => setPhoto(index, event.target.files?.[0] || null)} /></label>
              {index === 2 && <label className="live-check"><input type="checkbox" checked={slot.isLive} onChange={(event) => setPhotoLive(index, event.target.checked)} /> Imagem da live</label>}
              <input className="time-input" aria-label={`Horário da imagem ${index + 1}`} type="text" inputMode="numeric" placeholder="HH:MM:SS" value={slot.time} onChange={(event) => setPhotoTime(index, event.target.value)} />
            </div>)}
          </div>
        </div>

        <aside className="preview-panel">
          <div className="preview-head"><span>PRÉ-VISUALIZAÇÃO</span><span>{format === "vertical" ? "9:16" : "16:9"}</span></div>
          <div className={`canvas-wrap ${format}`}>
            {!sourceUrl && <canvas ref={canvasRef} aria-label="Pré-visualização do timelapse" style={{ display: "none" }} />}
            {sourceUrl ? <canvas ref={canvasRef} aria-label="Pré-visualização do timelapse" /> : <div className="empty-preview"><span>✦</span><b>O teu timelapse aparece aqui</b><small>Escolhe uma gravação para começar</small></div>}
          </div>
          {twitchEmbed && <div className="twitch-preview"><iframe title="Pré-visualização Twitch" src={twitchEmbed} allowFullScreen /></div>}
          <video ref={videoRef} src={sourceUrl || undefined} muted playsInline preload="metadata" onLoadedData={refreshPreview} />
          <div className="status" aria-live="polite"><span>{status}</span>{busy && <b>Falta {100 - progress}%</b>}</div>
          {busy && <div className="progress"><i style={{ width: `${progress}%` }} /></div>}
          <button className="generate" type="button" disabled={busy} onClick={localMode && vodConnected && !sourceUrl && photos.length === 0 ? generateFromTwitch : generate}>{busy ? "A gerar…" : localMode && vodConnected && !sourceUrl && photos.length === 0 ? "Gerar os 2 timelapses da VOD" : "Gerar os 2 timelapses"}<span>→</span></button>
          <div className="download-grid">
            {downloads.horizontal && <a className="download" href={downloads.horizontal} download={`xcatarina-${category}-horizontal-timelapse.webm`}>Descarregar 16:9</a>}
            {downloads.vertical && <a className="download" href={downloads.vertical} download={`xcatarina-${category}-vertical-timelapse.webm`}>Descarregar 9:16</a>}
          </div>
          {(downloads.horizontal || downloads.vertical) && <div className="publish-box">
            <span>PUBLICAR NO SITE PÚBLICO</span>
            <input aria-label="Título público" placeholder="Título do vídeo" value={publishTitle} onChange={(event) => setPublishTitle(event.target.value)} />
            <textarea aria-label="Descrição pública" placeholder="Descrição curta (opcional)" rows={2} value={publishDescription} onChange={(event) => setPublishDescription(event.target.value)} />
            <div className="publish-actions">
              <button type="button" disabled={Boolean(publishing)} onClick={() => publishGenerated("horizontal")}>{publishing === "horizontal" ? `${publishProgress}%` : "Publicar 16:9"}</button>
              <button type="button" disabled={Boolean(publishing)} onClick={() => publishGenerated("vertical")}>{publishing === "vertical" ? `${publishProgress}%` : "Publicar 9:16"}</button>
            </div>
            <output>{publishStatus}</output>
          </div>}
        </aside>
      </section>

      <footer><span>feito para <b>xCatarina</b></span><span>rosa · azul-bebé · amarelo</span></footer>
    </main>
  );
}
