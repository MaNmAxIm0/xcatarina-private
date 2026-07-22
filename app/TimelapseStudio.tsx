"use client";
/* eslint-disable @next/next/no-img-element -- previews use local blob URLs that next/image cannot optimize */

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

type Format = "horizontal" | "vertical";
type PhotoSlot = { file: File | null; time: string; isLive: boolean; previewUrl: string };
type LocalJob = { id: string; state: "queued" | "probing" | "processing" | "complete" | "error"; progress: number; currentFormat?: Format; error?: string; outputs?: Partial<Record<Format, string>>; segmentCount?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timeToSeconds(value: string) {
  if (!value.trim()) return null;
  const parts = value.trim().split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length > 1 && parts.slice(1).some((part) => part >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

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
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [category, setCategory] = useState<"arte" | "lego">("lego");
  const [focus, setFocus] = useState(77);
  const [duration, setDuration] = useState(15);
  const [photoSlots, setPhotoSlots] = useState<PhotoSlot[]>([
    { file: null, time: "", isLive: true, previewUrl: "" },
    { file: null, time: "", isLive: true, previewUrl: "" },
    { file: null, time: "", isLive: true, previewUrl: "" },
  ]);
  const selectedSlots = photoSlots.filter((slot): slot is PhotoSlot & { file: File } => Boolean(slot.file));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Escolhe uma gravação para começar.");
  const [downloads, setDownloads] = useState<Partial<Record<Format, string>>>({});
  const [publicationId, setPublicationId] = useState("");
  const [publishTitle, setPublishTitle] = useState("");
  const [publishDescription, setPublishDescription] = useState("");
  const [publishProgress, setPublishProgress] = useState(0);
  const [publishing, setPublishing] = useState<"both" | null>(null);
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
        if (job.state === "processing") setStatus(job.currentFormat ? `A criar a versão ${job.currentFormat === "vertical" ? "vertical 9:16" : "horizontal 16:9"}…` : `A acelerar o intervalo completo em 1080p60${job.segmentCount ? ` (${job.segmentCount} segmentos contínuos)` : ""}…`);
        if (job.state === "complete") {
          setDownloads(job.outputs || {});
          setPublicationId(crypto.randomUUID());
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

  const verticalCrop = useCallback((width: number, height: number) => {
    const targetRatio = 9 / 16;
    let cropWidth = width;
    let cropHeight = height;
    if (width / height > targetRatio) cropWidth = height * targetRatio;
    else cropHeight = width / targetRatio;
    return {
      x: (width - cropWidth) * (focus / 100),
      y: (height - cropHeight) / 2,
      width: cropWidth,
      height: cropHeight,
    };
  }, [focus]);

  const drawWatermark = useCallback((ctx: CanvasRenderingContext2D) => {
    const canvas = ctx.canvas;
    const width = Math.round(canvas.width * (canvas.width > canvas.height ? .285 : .43));
    const height = Math.round(width / 5);
    const x = Math.round(canvas.width * .022);
    const y = canvas.height - height - Math.round(canvas.height * .027);
    const padding = height * .15;
    const icon = height - padding * 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, height * .22);
    ctx.fillStyle = "rgba(18,13,28,.72)";
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x + padding, y + padding, icon, icon, icon * .18);
    ctx.fillStyle = "#9146ff";
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + padding + icon * .32, y + padding + icon * .25, icon * .12, icon * .34);
    ctx.fillRect(x + padding + icon * .58, y + padding + icon * .25, icon * .12, icon * .34);
    ctx.beginPath();
    ctx.moveTo(x + padding + icon * .25, y + padding + icon * .68);
    ctx.lineTo(x + padding + icon * .25, y + padding + icon * .82);
    ctx.lineTo(x + padding + icon * .4, y + padding + icon * .68);
    ctx.closePath();
    ctx.fill();
    const textX = x + padding * 2 + icon;
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${Math.round(height * .34)}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText("xCatarina", textX, y + height * .4);
    ctx.fillStyle = "#f6a9ca";
    ctx.font = `600 ${Math.round(height * .19)}px sans-serif`;
    ctx.fillText("twitch.tv/xcatarina", textX, y + height * .69);
    ctx.restore();
  }, []);

  const drawFrame = useCallback((ctx: CanvasRenderingContext2D, video: HTMLVideoElement, outputFormat: Format) => {
    const canvas = ctx.canvas;
    ctx.fillStyle = "#120d1c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (outputFormat === "horizontal") {
      const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      ctx.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    } else {
      const crop = verticalCrop(video.videoWidth, video.videoHeight);
      ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    }
    drawWatermark(ctx);
  }, [drawWatermark, verticalCrop]);

  const drawPreview = useCallback((ctx: CanvasRenderingContext2D, video: HTMLVideoElement) => {
    const canvas = ctx.canvas;
    ctx.fillStyle = "#120d1c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const x = (canvas.width - width) / 2;
    const y = (canvas.height - height) / 2;
    ctx.drawImage(video, x, y, width, height);
    const crop = verticalCrop(video.videoWidth, video.videoHeight);
    const guide = { x: x + crop.x * scale, y: y + crop.y * scale, width: crop.width * scale, height: crop.height * scale };
    ctx.fillStyle = "rgba(10,7,14,.58)";
    ctx.fillRect(x, y, Math.max(0, guide.x - x), height);
    ctx.fillRect(guide.x + guide.width, y, Math.max(0, x + width - guide.x - guide.width), height);
    ctx.fillRect(guide.x, y, guide.width, Math.max(0, guide.y - y));
    ctx.fillRect(guide.x, guide.y + guide.height, guide.width, Math.max(0, y + height - guide.y - guide.height));
    ctx.strokeStyle = "#f6a9ca";
    ctx.lineWidth = 4;
    ctx.strokeRect(guide.x + 2, guide.y + 2, guide.width - 4, guide.height - 4);
    ctx.fillStyle = "#f6a9ca";
    ctx.font = "800 18px sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText("RECORTE 9:16", guide.x + 12, guide.y + 12);
    drawWatermark(ctx);
  }, [drawWatermark, verticalCrop]);

  const refreshPreview = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (ctx) drawPreview(ctx, video);
  }, [drawPreview]);

  const moveCropGuide = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const video = videoRef.current;
    const canvas = event.currentTarget;
    if (!video?.videoWidth) return;
    const bounds = canvas.getBoundingClientRect();
    const canvasX = (event.clientX - bounds.left) * (canvas.width / bounds.width);
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const renderedX = (canvas.width - video.videoWidth * scale) / 2;
    const sourceX = Math.max(0, Math.min(video.videoWidth, (canvasX - renderedX) / scale));
    const crop = verticalCrop(video.videoWidth, video.videoHeight);
    const available = video.videoWidth - crop.width;
    setFocus(available > 0 ? Math.round(Math.max(0, Math.min(100, ((sourceX - crop.width / 2) / available) * 100))) : 50);
  };

  const moveTwitchCropGuide = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect() || event.currentTarget.getBoundingClientRect();
    const cropRatio = (9 / 16) / (16 / 9);
    const pointerRatio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setFocus(Math.round(Math.max(0, Math.min(100, ((pointerRatio - cropRatio / 2) / (1 - cropRatio)) * 100))));
  };

  useEffect(() => { refreshPreview(); }, [refreshPreview, sourceUrl]);

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

  const resolvedMarkerRange = () => {
    const liveMarkers = selectedSlots.filter((slot) => slot.isLive && timeToSeconds(slot.time) !== null);
    return {
      start: startAt.trim() || liveMarkers[0]?.time || "00:00:00",
      end: endAt.trim() || (liveMarkers.length > 1 ? liveMarkers[liveMarkers.length - 1].time : ""),
    };
  };

  const generateFromTwitch = async () => {
    if (!vodConnected) {
      setStatus("Instala o helper, abre a VOD na Twitch, inicia sessão e carrega no Play.");
      return;
    }
    const range = resolvedMarkerRange();
    const startSeconds = timeToSeconds(range.start);
    const endSeconds = range.end ? timeToSeconds(range.end) : null;
    if (startSeconds === null || (range.end && endSeconds === null)) {
      setStatus("Usa horários válidos no formato HH:MM:SS.");
      return;
    }
    if (endSeconds !== null && endSeconds <= startSeconds) {
      setStatus("O fim do intervalo deve ser posterior ao início.");
      return;
    }
    setBusy(true);
    setProgress(0);
    setDownloads({});
    setPublicationId("");
    setStatus(`A iniciar o vídeo acelerado entre ${range.start}${range.end ? ` e ${range.end}` : " e o fim da VOD"}…`);
    try {
      const response = await fetch("/api/twitch/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration, focus, start: range.start, end: range.end }),
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

  const ensureMp4 = async (recorded: Blob) => {
    if (!localMode && recorded.type.startsWith("video/mp4")) return recorded;
    if (!localMode) throw new Error("Abre o estúdio em localhost para converter a gravação para MP4 H.264 1080p60.");
    setStatus("A converter a versão para MP4 H.264…");
    const response = await fetch("/api/timelapse/convert", {
      method: "POST",
      headers: { "Content-Type": recorded.type || "video/webm" },
      body: recorded,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error || "Não foi possível converter a gravação para MP4. Abre o estúdio em localhost e tenta novamente.");
    }
    return response.blob();
  };

  const generate = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !sourceUrl) {
      setStatus("As imagens são marcadores de referência. Escolhe uma VOD ou gravação para criar um timelapse real.");
      return;
    }
    if (!video) {
      setStatus("A gravação ainda não está pronta. Aguarda o carregamento e tenta novamente.");
      return;
    }
    setBusy(true);
    setProgress(0);
    Object.values(downloads).forEach((url) => url && URL.revokeObjectURL(url));
    setDownloads({});
    setPublicationId("");
    setStatus("A acelerar o vídeo real… mantém esta página aberta.");
    try {
      if (!video.duration || Number.isNaN(video.duration)) {
        await waitFor(video, "loadedmetadata");
      }
      const range = resolvedMarkerRange();
      if (timeToSeconds(range.start) === null || (range.end && timeToSeconds(range.end) === null)) {
        throw new Error("Usa horários válidos no formato HH:MM:SS.");
      }
      const clipStart = Math.max(0, Math.min(video.duration - .04, timeToSeconds(range.start) ?? 0));
      const requestedEnd = timeToSeconds(range.end);
      const clipEnd = requestedEnd === null ? video.duration : Math.max(0, Math.min(video.duration, requestedEnd));
      if (clipEnd <= clipStart) throw new Error("O fim do intervalo deve ser posterior ao início.");
      if (clipEnd - clipStart < duration) throw new Error("A duração final tem de ser igual ou inferior ao intervalo escolhido para haver aceleração real.");
      const results: Partial<Record<Format, string>> = {};
      const formats: Format[] = ["horizontal", "vertical"];
      for (let formatIndex = 0; formatIndex < formats.length; formatIndex += 1) {
        const outputFormat = formats[formatIndex];
        setStatus(`A criar a versão ${outputFormat === "horizontal" ? "horizontal 1080p60" : "vertical 1080p60"}…`);
        canvas.width = outputFormat === "vertical" ? 1080 : 1920;
        canvas.height = outputFormat === "vertical" ? 1920 : 1080;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("O navegador não disponibilizou o editor de vídeo.");
        const stream = canvas.captureStream(60);
        const mimeType = ["video/mp4;codecs=avc1.64002a", "video/mp4;codecs=avc1.42e01e", "video/mp4", "video/webm;codecs=vp9", "video/webm"]
          .find((candidate) => MediaRecorder.isTypeSupported(candidate));
        if (!mimeType) throw new Error("Este navegador não consegue gravar o timelapse. Usa uma versão recente do Chrome.");
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: outputFormat === "horizontal" ? 16_000_000 : 14_000_000 });
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
        const finished = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
        recorder.start(1000);
        const frames = duration * 60;
        for (let frame = 0; frame < frames; frame += 1) {
          const target = Math.min(clipEnd - .01, clipStart + (frame / Math.max(1, frames - 1)) * (clipEnd - clipStart));
          if (Math.abs(video.currentTime - target) > .008) { video.currentTime = target; await waitFor(video, "seeked"); }
          drawFrame(ctx, video, outputFormat);
          if (frame % 10 === 0) setProgress(Math.round(((formatIndex + frame / frames) / formats.length) * 90));
          await sleep(1000 / 60);
        }
        recorder.stop();
        await finished;
        const mp4 = await ensureMp4(new Blob(chunks, { type: mimeType }));
        results[outputFormat] = URL.createObjectURL(mp4);
      }
      setDownloads(results);
      setPublicationId(crypto.randomUUID());
      setProgress(100);
      setStatus("As duas versões MP4 1080p60 estão prontas para descarregar e publicar.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Não foi possível gerar o timelapse.");
    } finally {
      setBusy(false);
      window.setTimeout(refreshPreview, 0);
    }
  };

  const uploadGenerated = async (outputFormat: Format, sharedPublicationId: string, progressStart = 0, progressSpan = 100) => {
    const generatedUrl = downloads[outputFormat];
    if (!generatedUrl) throw new Error(`Falta a versão ${outputFormat === "horizontal" ? "16:9" : "9:16"}.`);
    const body = await fetch(generatedUrl).then((response) => response.blob());
    if (!body.type.startsWith("video/mp4")) throw new Error("A versão gerada não está em MP4. Gera novamente no estúdio local.");
    const safeTitle = publishTitle.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "timelapse";
    const pathname = `videos/${category}/${Date.now()}-${outputFormat}-${safeTitle}.mp4`;
    const metadata = {
      title: publishTitle.trim(),
      description: publishDescription.trim(),
      category,
      duration: `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`,
      format: outputFormat,
      publicationId: sharedPublicationId,
    };
    const blob = await upload(pathname, body, {
      access: "public",
      handleUploadUrl: "/api/upload",
      multipart: true,
      clientPayload: JSON.stringify(metadata),
      onUploadProgress: ({ percentage }) => setPublishProgress(Math.round(progressStart + percentage * (progressSpan / 100))),
    });
    return { blob, metadata };
  };

  const finalizeUpload = async ({ blob, metadata }: Awaited<ReturnType<typeof uploadGenerated>>) => {
    const finalized = await fetch("/api/upload/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob: { url: blob.url, pathname: blob.pathname }, metadata }),
    });
    if (!finalized.ok) {
      const result = await finalized.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error || "O vídeo foi enviado, mas não foi possível adicioná-lo ao arquivo público.");
    }
  };

  const publishBoth = async () => {
    if (!publishTitle.trim()) { setPublishStatus("Escreve um título antes de publicar."); return; }
    if (!downloads.horizontal || !downloads.vertical) { setPublishStatus("Gera primeiro os dois formatos."); return; }
    const sharedPublicationId = publicationId || crypto.randomUUID();
    if (!publicationId) setPublicationId(sharedPublicationId);
    setPublishing("both"); setPublishProgress(0); setPublishStatus("A publicar os dois formatos como um só vídeo…");
    try {
      const horizontal = await uploadGenerated("horizontal", sharedPublicationId, 0, 50);
      const vertical = await uploadGenerated("vertical", sharedPublicationId, 50, 50);
      await Promise.all([finalizeUpload(horizontal), finalizeUpload(vertical)]);
      setPublishProgress(100);
      setPublishStatus("Publicado: o 16:9 é o vídeo principal e o 9:16 fica disponível como formato alternativo.");
    } catch (error) {
      setPublishStatus(error instanceof Error ? error.message : "Não foi possível publicar os dois formatos.");
    } finally { setPublishing(null); }
  };

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Estúdio xCatarina">
          <span className="brand-dot">xC</span>
          <span>timelapse studio</span>
        </a>
        <span className="private-pill">Estúdio privado</span>
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
          <div className="step-heading"><span>02</span><div><h2>Enquadramento</h2><p>São sempre gerados dois MP4 1080p60: live 16:9 e recorte vertical 9:16.</p></div></div>
          <div className="output-pair" aria-label="Formatos gerados">
            <span><i className="ratio wide" /><b>Live completa</b><small>1920 × 1080 · 60 fps</small></span>
            <span><i className="ratio tall" /><b>LEGO em foco</b><small>1080 × 1920 · 60 fps</small></span>
          </div>
          <div className="content-type" role="group" aria-label="Tipo de criação">
            <span>Conteúdo</span>
            <button type="button" className={category === "arte" ? "active" : ""} onClick={() => setCategory("arte")}>Pintura / Arte</button>
            <button type="button" className={category === "lego" ? "active" : ""} onClick={() => setCategory("lego")}>LEGO</button>
          </div>
          <label className="range-row"><span>Posição do recorte LEGO</span><input aria-label="Posição horizontal do recorte LEGO" type="range" min="0" max="100" value={focus} onChange={(event) => setFocus(Number(event.target.value))} /><output>{focus}%</output></label>

          <div className="field-row duration-row">
            <label><span>Duração final</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value="8">8 segundos</option><option value="15">15 segundos</option><option value="30">30 segundos</option><option value="60">1 minuto</option><option value="90">1 minuto e 30</option><option value="120">2 minutos</option><option value="300">5 minutos</option><option value="600">10 minutos</option><option value="900">15 minutos</option><option value="1800">30 minutos</option></select></label>
          </div>
          <div className="vod-range"><label><span>Início do vídeo (opcional)</span><input value={startAt} onChange={(event) => setStartAt(event.target.value)} placeholder="usar 1.º marcador ou 00:00:00" /></label><label><span>Fim do vídeo (opcional)</span><input value={endAt} onChange={(event) => setEndAt(event.target.value)} placeholder="usar último marcador ou até ao fim" /></label></div>
          <div className="photo-heading"><b>Marcadores visuais</b><span>O horário nunca aparece no vídeo</span></div>
          <p className="photo-help">São apenas referências: a primeira imagem da live define o início e a última define o fim quando os campos acima estão vazios. Não formam um slideshow nem são acrescentadas ao timelapse.</p>
          <div className="photo-slots">
            {photoSlots.map((slot, index) => <div className={slot.file ? "photo-slot filled" : "photo-slot"} key={index} tabIndex={0} onPaste={(event) => pastePhoto(index, event)}>
              <span className="photo-number">0{index + 1}</span>
              {slot.previewUrl ? <img className="photo-preview" src={slot.previewUrl} alt={`Pré-visualização da imagem ${index + 1}`} /> : <div className="photo-placeholder">Imagem {index + 1}</div>}
              <b>{slot.file?.name || "Colar ou escolher imagem"}</b>
              <small>Ctrl+V nesta caixa</small>
              <label className="file-button">Escolher ficheiro<input type="file" accept="image/*" onChange={(event) => setPhoto(index, event.target.files?.[0] || null)} /></label>
              {index === 2 && <label className="live-check"><input type="checkbox" checked={slot.isLive} onChange={(event) => setPhotoLive(index, event.target.checked)} /> Imagem da live</label>}
              {slot.isLive ? <input className="time-input" aria-label={`Momento da imagem ${index + 1} na live`} type="text" inputMode="numeric" placeholder="HH:MM:SS" value={slot.time} onChange={(event) => setPhotoTime(index, event.target.value)} /> : <small className="reference-only">Imagem final de referência · fica fora do vídeo</small>}
            </div>)}
          </div>
        </div>

        <aside className="preview-panel">
          <div className="preview-head"><span>PRÉ-VISUALIZAÇÃO DOS 2 FORMATOS</span><span>16:9 + 9:16</span></div>
          <div className="canvas-wrap horizontal">
            {sourceUrl ? <canvas ref={canvasRef} aria-label="Live 16:9 com limites do recorte vertical 9:16" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); moveCropGuide(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveCropGuide(event); }} /> : twitchEmbed ? <div className="twitch-preview"><iframe title="Pré-visualização Twitch" src={twitchEmbed} allowFullScreen /><div className="crop-shade left" style={{ width: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100}%` }} /><div className="crop-guide" style={{ left: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100}%`, width: `${(9 / 16) / (16 / 9) * 100}%` }}><span>RECORTE 9:16</span></div><div className="crop-shade right" style={{ left: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100 + (9 / 16) / (16 / 9) * 100}%` }} /><div className="crop-interaction" style={{ left: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100}%`, width: `${(9 / 16) / (16 / 9) * 100}%` }} role="slider" aria-label="Posição do recorte vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={focus} tabIndex={0} title="Arrasta para mover o recorte 9:16" onKeyDown={(event) => { if (event.key === "ArrowLeft") setFocus((value) => Math.max(0, value - 1)); if (event.key === "ArrowRight") setFocus((value) => Math.min(100, value + 1)); }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); moveTwitchCropGuide(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTwitchCropGuide(event); }} /></div> : <div className="empty-preview"><span>✦</span><b>O teu timelapse aparece aqui</b><small>Escolhe uma VOD ou gravação para começar</small></div>}
          </div>
          <video ref={videoRef} src={sourceUrl || undefined} muted playsInline preload="metadata" onLoadedData={refreshPreview} />
          <div className="status" aria-live="polite"><span>{status}</span>{busy && <b>Falta {100 - progress}%</b>}</div>
          {busy && <div className="progress"><i style={{ width: `${progress}%` }} /></div>}
          <button className="generate" type="button" disabled={busy} onClick={localMode && vodConnected && !sourceUrl ? generateFromTwitch : generate}>{busy ? "A gerar os MP4 1080p60…" : localMode && vodConnected && !sourceUrl ? "Gerar os 2 MP4 da VOD" : sourceUrl ? "Gerar os 2 MP4 da gravação" : "Escolhe uma VOD ou gravação"}<span>→</span></button>
          <div className="download-grid">
            {downloads.horizontal && <a className="download" href={downloads.horizontal} download={`xcatarina-${category}-horizontal-1080p60-timelapse.mp4`}>Descarregar 16:9 MP4</a>}
            {downloads.vertical && <a className="download" href={downloads.vertical} download={`xcatarina-${category}-vertical-1080p60-timelapse.mp4`}>Descarregar 9:16 MP4</a>}
          </div>
          {(downloads.horizontal || downloads.vertical) && <div className="publish-box">
            <span>PUBLICAR NO SITE PÚBLICO</span>
            <input aria-label="Título público" placeholder="Título do vídeo" value={publishTitle} onChange={(event) => setPublishTitle(event.target.value)} />
            <textarea aria-label="Descrição pública" placeholder="Descrição curta (opcional)" rows={2} value={publishDescription} onChange={(event) => setPublishDescription(event.target.value)} />
            <div className="publish-actions">
              <button className="publish-both" type="button" disabled={Boolean(publishing)} onClick={publishBoth}>{publishing === "both" ? `A publicar · ${publishProgress}%` : "Publicar os 2 formatos juntos"}</button>
            </div>
            <output>{publishStatus}</output>
          </div>}
        </aside>
      </section>

      <footer><span>feito para <b>xCatarina</b></span><span>rosa · azul-bebé · amarelo</span></footer>
    </main>
  );
}
