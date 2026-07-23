"use client";
/* eslint-disable @next/next/no-img-element -- previews use local blob URLs that next/image cannot optimize */

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

type Format = "horizontal" | "vertical";
const DURATION_VARIANTS = [8, 15, 30, 45, 60, 90] as const;
type VariantDownloads = Record<string, Partial<Record<Format, string>>>;
type PhotoSlot = { file: File | null; time: string; isLive: boolean; previewUrl: string };
type LocalJob = { id: string; state: "queued" | "probing" | "processing" | "complete" | "error"; progress: number; currentFormat?: Format; error?: string; outputs?: Partial<Record<Format, string>>; variants?: VariantDownloads; segmentCount?: number; duration?: number; baseDuration?: number; startAt?: number; endAt?: number };
type ReusableJob = { id: string; duration: number; startAt: number; endAt: number };
type LocalBase = { url: string; duration: number; startAt: number; endAt: number; sourceUrl: string };

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
      reject(new Error("NÃ£o foi possÃ­vel ler este vÃ­deo."));
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
  const [sourceInputKey, setSourceInputKey] = useState(0);
  const [sourceUrl, setSourceUrl] = useState("");
  const [twitchUrl, setTwitchUrl] = useState("");
  const [twitchEmbed, setTwitchEmbed] = useState("");
  const [localMode, setLocalMode] = useState(false);
  const [vodConnected, setVodConnected] = useState(false);
  const [connectedVodId, setConnectedVodId] = useState("");
  const [jobId, setJobId] = useState("");
  const [reusableJob, setReusableJob] = useState<ReusableJob | null>(null);
  const localBaseRef = useRef<LocalBase | null>(null);
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [category, setCategory] = useState<"arte" | "lego">("lego");
  const [focus, setFocus] = useState(77);
  const [duration, setDuration] = useState(30);
  const [photoSlots, setPhotoSlots] = useState<PhotoSlot[]>([
    { file: null, time: "", isLive: true, previewUrl: "" },
    { file: null, time: "", isLive: true, previewUrl: "" },
    { file: null, time: "", isLive: true, previewUrl: "" },
  ]);
  const selectedSlots = photoSlots.filter((slot): slot is PhotoSlot & { file: File } => Boolean(slot.file));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Escolhe uma gravaÃ§Ã£o para comeÃ§ar.");
  const [downloads, setDownloads] = useState<Partial<Record<Format, string>>>({});
  const [generatedPreview, setGeneratedPreview] = useState("");
  const [variantDownloads, setVariantDownloads] = useState<VariantDownloads>({});
  const [publicationId, setPublicationId] = useState("");
  const [publishTitle, setPublishTitle] = useState("");
  const [publishDescription, setPublishDescription] = useState("");
  const [publishDate, setPublishDate] = useState("");
  const publishDateRef = useRef("");
  const [publishProgress, setPublishProgress] = useState(0);
  const [publishing, setPublishing] = useState<"both" | null>(null);
  const [publishStatus, setPublishStatus] = useState("");

  const updatePublishedDate = async () => {
    if (!publicationId || !publishDate) { setPublishStatus("Indica uma data e publica primeiro este vÃ­deo."); return; }
    setPublishStatus("A atualizar a data da publicaÃ§Ã£oâ€¦");
    const response = await fetch("/api/publish", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicationId, publishedAt: publishDate }) });
    const result = await response.json().catch(() => ({})) as { error?: string };
    setPublishStatus(response.ok ? "Data da publicaÃ§Ã£o atualizada." : (result.error || "NÃ£o foi possÃ­vel atualizar a data."));
  };

  useEffect(() => {
    const savedPublication = window.localStorage.getItem("xcatarina-publication-id") || "";
    if (savedPublication) window.setTimeout(() => setPublicationId(savedPublication), 0);
    const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    const modeTimer = window.setTimeout(() => setLocalMode(local), 0);
    if (!local) return () => window.clearTimeout(modeTimer);
    const check = async () => {
      try {
      const result = await fetch("/api/twitch/session", { cache: "no-store" }).then((response) => response.json()) as { available?: boolean; vodId?: string; vodStartedAt?: string | null; vodDurationSeconds?: number | null };
      setVodConnected(Boolean(result.available));
      setConnectedVodId(result.vodId || "");
      if (result.vodStartedAt && result.vodDurationSeconds) {
        const end = new Date(Date.parse(result.vodStartedAt) + result.vodDurationSeconds * 1000);
        if (!Number.isNaN(end.getTime()) && !publishDateRef.current) {
          const date = end.toISOString().slice(0, 10);
          publishDateRef.current = date;
          setPublishDate(date);
        }
      }
      } catch { setVodConnected(false); }
    };
    void check();
    const timer = window.setInterval(check, 2000);
    return () => { window.clearTimeout(modeTimer); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const activeJob = window.localStorage.getItem("xcatarina-active-job") || "";
    const savedReusable = window.localStorage.getItem("xcatarina-reusable-job");
    const restoreTimer = window.setTimeout(() => {
      if (activeJob) {
        setJobId(activeJob);
        setBusy(true);
        setStatus("A recuperar o processamento que ficou ativoâ€¦");
      }
      if (savedReusable) {
        try {
          const reusable = JSON.parse(savedReusable) as ReusableJob;
          setReusableJob(reusable);
          if (!activeJob) setJobId(reusable.id);
        } catch { window.localStorage.removeItem("xcatarina-reusable-job"); }
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const check = async () => {
      try {
        const job = await fetch(`/api/twitch/jobs?id=${encodeURIComponent(jobId)}`, { cache: "no-store" }).then((response) => response.json()) as LocalJob;
        if (stopped) return;
        setProgress(job.progress || 0);
        if (job.state === "probing") setStatus("A verificar a duraÃ§Ã£o e o acesso Ã  VODâ€¦");
        if (job.state === "processing") setStatus(job.currentFormat ? `A criar a versÃ£o ${job.currentFormat === "vertical" ? "vertical 9:16" : "horizontal 16:9"}â€¦` : `A acelerar o intervalo completo em 1080p60${job.segmentCount ? ` (${job.segmentCount} segmentos contÃ­nuos)` : ""}â€¦`);
        if (job.outputs?.horizontal) {
          setDownloads(job.outputs);
          setGeneratedPreview(job.outputs.horizontal);
          setVariantDownloads(job.variants || {});
          const firstGeneratedDuration = Object.keys(job.variants || {})[0];
          if (firstGeneratedDuration) setDuration(Number(firstGeneratedDuration));
          if (job.state === "processing") setStatus("A primeira versão horizontal está pronta; o resto continua a ser gerado…");
        }
        if (job.state === "complete") {
          setDownloads(job.outputs || {});
          setVariantDownloads(job.variants || (job.outputs ? { "30": job.outputs } : {}));
          if (job.duration) {
            const reusable = { id: job.id, duration: job.baseDuration || job.duration, startAt: job.startAt || 0, endAt: job.endAt || 0 };
            setReusableJob(reusable);
            window.localStorage.setItem("xcatarina-reusable-job", JSON.stringify(reusable));
          }
          window.localStorage.removeItem("xcatarina-active-job");
          setPublicationId(crypto.randomUUID());
          setStatus(job.duration && job.duration > 90 ? `As 6 duraÃ§Ãµes pÃºblicas e a versÃ£o local de ${job.duration / 60} minutos estÃ£o prontas.` : "As 6 duraÃ§Ãµes, em 16:9 e 9:16, estÃ£o prontas para descarregar e publicar.");
          setBusy(false);
          setJobId("");
        }
        if (job.state === "error") {
          window.localStorage.removeItem("xcatarina-active-job");
          setStatus(job.error || "NÃ£o foi possÃ­vel processar a VOD.");
          setBusy(false);
          setJobId("");
        }
      } catch {
        if (!stopped) setStatus("NÃ£o foi possÃ­vel consultar o processamento local.");
      }
    };
    void check();
    const timer = window.setInterval(check, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [jobId]);

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
    const width = Math.round(canvas.width * (canvas.width > canvas.height ? .285 : .57));
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

  const drawFrame = useCallback((ctx: CanvasRenderingContext2D, video: HTMLVideoElement, outputFormat: Format, withWatermark = true) => {
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
    if (withWatermark) drawWatermark(ctx);
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
    Object.values(downloads).forEach((url) => url?.startsWith("blob:") && URL.revokeObjectURL(url));
    setSourceUrl(URL.createObjectURL(file));
    setSourceName(file.name);
    setTwitchEmbed("");
    setReusableJob(null);
    window.localStorage.removeItem("xcatarina-reusable-job");
    if (localBaseRef.current) URL.revokeObjectURL(localBaseRef.current.url);
    localBaseRef.current = null;
    setDownloads({});
    setVariantDownloads({});
    setStatus("VÃ­deo pronto. Confirma o enquadramento e gera o timelapse.");
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
        setStatus("A VOD abriu na Twitch. Inicia sessÃ£o e carrega no Play; o helper liga-a automaticamente ao Studio.");
      } else {
        setStatus("LigaÃ§Ã£o Twitch reconhecida. Podes confirmar a live na prÃ©-visualizaÃ§Ã£o.");
      }
    } catch {
      setStatus("Esse link nÃ£o parece ser um vÃ­deo, clipe ou canal Twitch vÃ¡lido.");
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
    const range = resolvedMarkerRange();
    const startSeconds = timeToSeconds(range.start);
    const endSeconds = range.end ? timeToSeconds(range.end) : null;
    if (startSeconds === null || (range.end && endSeconds === null)) {
      setStatus("Usa horÃ¡rios vÃ¡lidos no formato HH:MM:SS.");
      return;
    }
    if (endSeconds !== null && endSeconds <= startSeconds) {
      setStatus("O fim do intervalo deve ser posterior ao inÃ­cio.");
      return;
    }
    const canReuse = reusableJob
      && reusableJob.startAt === startSeconds
      && reusableJob.endAt === (endSeconds || 0)
      && Math.max(90, duration) <= reusableJob.duration;
    if (!vodConnected && !canReuse) {
      setStatus("Instala o helper, abre a VOD na Twitch, inicia sessÃ£o e carrega no Play.");
      return;
    }
    setBusy(true);
    setProgress(0);
    setDownloads({});
    setVariantDownloads({});
    setPublicationId("");
    setStatus(`A iniciar o vÃ­deo acelerado entre ${range.start}${range.end ? ` e ${range.end}` : " e o fim da VOD"}â€¦`);
    try {
      const requestBody = new FormData();
      requestBody.set("duration", String(duration));
      requestBody.set("focus", String(focus));
      requestBody.set("start", range.start);
      requestBody.set("end", range.end);
      if (canReuse) requestBody.set("reuseJobId", reusableJob.id);
      if (photoSlots[2].file) requestBody.set("outroImage", photoSlots[2].file);
      const response = await fetch("/api/twitch/jobs", {
        method: "POST",
        body: requestBody,
      });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok || !result.id) throw new Error(result.error || "NÃ£o foi possÃ­vel iniciar o processamento.");
      setJobId(result.id);
      window.localStorage.setItem("xcatarina-active-job", result.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "NÃ£o foi possÃ­vel iniciar o processamento.");
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
    if (!localMode) throw new Error("Abre o estÃºdio em localhost para converter a gravaÃ§Ã£o para MP4 H.264 1080p60.");
    setStatus("A converter a versÃ£o para MP4 H.264â€¦");
    const response = await fetch("/api/timelapse/convert", {
      method: "POST",
      headers: { "Content-Type": recorded.type || "video/webm" },
      body: recorded,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error || "NÃ£o foi possÃ­vel converter a gravaÃ§Ã£o para MP4. Abre o estÃºdio em localhost e tenta novamente.");
    }
    return response.blob();
  };

  const generate = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !sourceUrl) {
      setStatus("As imagens sÃ£o marcadores de referÃªncia. Escolhe uma VOD ou gravaÃ§Ã£o para criar um timelapse real.");
      return;
    }
    if (!video) {
      setStatus("A gravaÃ§Ã£o ainda nÃ£o estÃ¡ pronta. Aguarda o carregamento e tenta novamente.");
      return;
    }
    setBusy(true);
    setProgress(0);
    Object.values(downloads).forEach((url) => url && URL.revokeObjectURL(url));
    setDownloads({});
    setPublicationId("");
    setStatus("A acelerar o vÃ­deo realâ€¦ mantÃ©m esta pÃ¡gina aberta.");
    try {
      if (!video.duration || Number.isNaN(video.duration)) {
        await waitFor(video, "loadedmetadata");
      }
      const range = resolvedMarkerRange();
      if (timeToSeconds(range.start) === null || (range.end && timeToSeconds(range.end) === null)) {
        throw new Error("Usa horÃ¡rios vÃ¡lidos no formato HH:MM:SS.");
      }
      const clipStart = Math.max(0, Math.min(video.duration - .04, timeToSeconds(range.start) ?? 0));
      const requestedEnd = timeToSeconds(range.end);
      const clipEnd = requestedEnd === null ? video.duration : Math.max(0, Math.min(video.duration, requestedEnd));
      if (clipEnd <= clipStart) throw new Error("O fim do intervalo deve ser posterior ao inÃ­cio.");
      if (clipEnd - clipStart < duration) throw new Error("A duraÃ§Ã£o final tem de ser igual ou inferior ao intervalo escolhido para haver aceleraÃ§Ã£o real.");
      const processingVideo = document.createElement("video");
      processingVideo.muted = true;
      processingVideo.preload = "auto";
      processingVideo.src = sourceUrl;
      processingVideo.load();
      await waitFor(processingVideo, "loadedmetadata");
      let endingImage: HTMLImageElement | null = null;
      if (photoSlots[2].previewUrl) {
        endingImage = new Image();
        endingImage.src = photoSlots[2].previewUrl;
        await new Promise<void>((resolve, reject) => { endingImage!.onload = () => resolve(); endingImage!.onerror = () => reject(new Error("NÃ£o foi possÃ­vel ler a terceira imagem.")); });
      }
      const record = async (input: HTMLVideoElement, inputStart: number, inputEnd: number, outputDuration: number, outputFormat: Format, withWatermark: boolean, progressStart: number, progressSpan: number, outro: HTMLImageElement | null = null) => {
        canvas.width = outputFormat === "vertical" ? 1080 : 1920;
        canvas.height = outputFormat === "vertical" ? 1920 : 1080;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("O navegador nÃ£o disponibilizou o editor de vÃ­deo.");
        const stream = canvas.captureStream(60);
        const mimeType = ["video/mp4;codecs=avc1.64002a", "video/mp4;codecs=avc1.42e01e", "video/mp4", "video/webm;codecs=vp9", "video/webm"]
          .find((candidate) => MediaRecorder.isTypeSupported(candidate));
        if (!mimeType) throw new Error("Este navegador nÃ£o consegue gravar o timelapse. Usa uma versÃ£o recente do Chrome.");
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: withWatermark ? (outputFormat === "horizontal" ? 16_000_000 : 14_000_000) : 24_000_000 });
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
        const finished = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
        recorder.start(1000);
        const frames = outputDuration * 60;
        const outroFrames = outro && withWatermark ? (outputDuration < 60 ? 2 : 3) * 60 : 0;
        const mainFrames = frames - outroFrames;
        for (let frame = 0; frame < frames; frame += 1) {
          if (frame < mainFrames) {
            const target = Math.min(inputEnd - .01, inputStart + (frame / Math.max(1, mainFrames - 1)) * (inputEnd - inputStart));
            if (Math.abs(input.currentTime - target) > .008) { input.currentTime = target; await waitFor(input, "seeked"); }
            drawFrame(ctx, input, outputFormat, withWatermark);
          } else if (outro) {
            const coverScale = Math.max(canvas.width / outro.naturalWidth, canvas.height / outro.naturalHeight);
            const coverWidth = outro.naturalWidth * coverScale;
            const coverHeight = outro.naturalHeight * coverScale;
            ctx.save();
            ctx.filter = "blur(42px)";
            ctx.globalAlpha = .86;
            ctx.drawImage(outro, (canvas.width - coverWidth) / 2, (canvas.height - coverHeight) / 2, coverWidth, coverHeight);
            ctx.restore();
            const containScale = Math.min(canvas.width * .88 / outro.naturalWidth, canvas.height * .84 / outro.naturalHeight);
            const imageWidth = outro.naturalWidth * containScale;
            const imageHeight = outro.naturalHeight * containScale;
            ctx.save();
            ctx.globalAlpha = Math.min(1, (frame - mainFrames + 1) / 21);
            ctx.drawImage(outro, (canvas.width - imageWidth) / 2, (canvas.height - imageHeight) / 2, imageWidth, imageHeight);
            ctx.restore();
            drawWatermark(ctx);
          }
          if (frame % 10 === 0) setProgress(Math.round(progressStart + (frame / frames) * progressSpan));
          await sleep(1000 / 60);
        }
        recorder.stop();
        await finished;
        return ensureMp4(new Blob(chunks, { type: mimeType }));
      };

      const previousBase = localBaseRef.current;
      const canReuse = previousBase
        && previousBase.sourceUrl === sourceUrl
        && previousBase.startAt === clipStart
        && previousBase.endAt === clipEnd
        && duration <= previousBase.duration;
      let baseUrl = canReuse && duration === previousBase.duration ? previousBase.url : "";
      let createdBaseUrl = "";
      if (!baseUrl) {
        setStatus(canReuse ? "A encurtar o horizontal-base jÃ¡ geradoâ€¦" : "A criar o horizontal-base 1080p60 a partir da gravaÃ§Ã£oâ€¦");
        let baseInput = processingVideo;
        let baseStart = clipStart;
        let baseEnd = clipEnd;
        if (canReuse) {
          baseInput = document.createElement("video");
          baseInput.muted = true;
          baseInput.preload = "auto";
          baseInput.src = previousBase.url;
          baseInput.load();
          await waitFor(baseInput, "loadedmetadata");
          baseStart = 0;
          baseEnd = previousBase.duration;
        }
        const baseBlob = await record(baseInput, baseStart, baseEnd, duration, "horizontal", false, 0, 55);
        createdBaseUrl = URL.createObjectURL(baseBlob);
        baseUrl = createdBaseUrl;
      } else {
        setProgress(55);
      }

      const baseVideo = document.createElement("video");
      baseVideo.muted = true;
      baseVideo.preload = "auto";
      baseVideo.src = baseUrl;
      baseVideo.load();
      await waitFor(baseVideo, "loadedmetadata");
      setStatus("A aplicar a marca de Ã¡gua ao horizontal 1080p60â€¦");
      const horizontal = await record(baseVideo, 0, duration, duration, "horizontal", true, 55, 20, endingImage);
      setStatus("A criar o vertical a partir do horizontal-baseâ€¦");
      const vertical = await record(baseVideo, 0, duration, duration, "vertical", true, 75, 20, endingImage);
      const results: Partial<Record<Format, string>> = {
        horizontal: URL.createObjectURL(horizontal),
        vertical: URL.createObjectURL(vertical),
      };
      if (canReuse) {
        if (createdBaseUrl) URL.revokeObjectURL(createdBaseUrl);
      } else {
        if (previousBase) URL.revokeObjectURL(previousBase.url);
        localBaseRef.current = { url: baseUrl, duration, startAt: clipStart, endAt: clipEnd, sourceUrl };
      }
      setDownloads(results);
      setVariantDownloads({ [String(duration)]: results });
      setPublicationId(crypto.randomUUID());
      setProgress(100);
      setStatus("As duas versÃµes MP4 1080p60 estÃ£o prontas para descarregar e publicar.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "NÃ£o foi possÃ­vel gerar o timelapse.");
    } finally {
      setBusy(false);
      window.setTimeout(refreshPreview, 0);
    }
  };

  const publishBoth = async () => {
    if (!publishTitle.trim()) { setPublishStatus("Escreve um tÃ­tulo antes de publicar."); return; }
    if (!DURATION_VARIANTS.every((seconds) => variantDownloads[String(seconds)]?.horizontal && variantDownloads[String(seconds)]?.vertical)) { setPublishStatus("Gera primeiro o pacote completo das 6 duraÃ§Ãµes."); return; }
    if (!reusableJob?.id) { setPublishStatus("NÃ£o foi encontrado o pacote local. Gera novamente a partir da VOD."); return; }
    const sharedPublicationId = publicationId || crypto.randomUUID();
    if (!publicationId) setPublicationId(sharedPublicationId);
    window.localStorage.setItem("xcatarina-publication-id", sharedPublicationId);
    setPublishing("both"); setPublishProgress(0); setPublishStatus("A publicar as 12 versÃµes como um sÃ³ vÃ­deoâ€¦");
    try {
      setPublishProgress(5);
      const response = await fetch("/api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: reusableJob.id, publicationId: sharedPublicationId, title: publishTitle, description: publishDescription, category, publishedAt: publishDate }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || "NÃ£o foi possÃ­vel publicar no Cloudflare R2.");
      setPublishProgress(100);
      setPublishStatus("Publicado: 30 segundos em 16:9 Ã© o principal; as outras 11 versÃµes ficam disponÃ­veis para download.");
    } catch (error) {
      setPublishStatus(error instanceof Error ? error.message : "NÃ£o foi possÃ­vel publicar o pacote completo.");
    } finally { setPublishing(null); }
  };

  const clearStudio = async () => {
    if (busy || publishing) return;
    if (!window.confirm("Limpar a VOD ligada, imagens, horÃ¡rios e vÃ­deos temporÃ¡rios deste Studio? Os vÃ­deos jÃ¡ publicados nÃ£o serÃ£o apagados.")) return;
    const ids = [jobId, reusableJob?.id || ""].filter(Boolean);
    await Promise.all([
      fetch("/api/twitch/session", { method: "DELETE" }).catch(() => undefined),
      fetch("/api/twitch/jobs", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, all: true }) }).catch(() => undefined),
    ]);
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
    Object.values(downloads).forEach((url) => url?.startsWith("blob:") && URL.revokeObjectURL(url));
    for (const variants of Object.values(variantDownloads)) Object.values(variants).forEach((url) => url?.startsWith("blob:") && URL.revokeObjectURL(url));
    if (localBaseRef.current) URL.revokeObjectURL(localBaseRef.current.url);
    photoSlots.forEach((slot) => slot.previewUrl && URL.revokeObjectURL(slot.previewUrl));
    localBaseRef.current = null;
    window.localStorage.removeItem("xcatarina-active-job");
    window.localStorage.removeItem("xcatarina-reusable-job");
    setJobId(""); setReusableJob(null); setVodConnected(false); setConnectedVodId("");
    setSourceUrl(""); setSourceName(""); setSourceInputKey((value) => value + 1); setTwitchUrl(""); setTwitchEmbed("");
    setStartAt(""); setEndAt(""); setDuration(30); setFocus(77);
    setPhotoSlots([0, 1, 2].map(() => ({ file: null, time: "", isLive: true, previewUrl: "" })));
    setDownloads({}); setGeneratedPreview(""); setVariantDownloads({}); setPublicationId(""); setPublishTitle(""); setPublishDescription(""); publishDateRef.current = ""; setPublishDate(""); setPublishStatus(""); setPublishProgress(0);
    setProgress(0); setStatus("EstÃºdio limpo. Escolhe uma nova VOD ou gravaÃ§Ã£o.");
  };

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="EstÃºdio xCatarina">
          <span className="brand-dot">xC</span>
          <span>timelapse studio</span>
        </a>
        <span className="private-pill">EstÃºdio privado</span>
      </header>

      <section className="hero" id="top">
        <div>
          <span className="eyebrow">DA LIVE Ã€ PEÃ‡A FINAL</span>
          <h1>Transforma horas<br />em <em>segundos.</em></h1>
        </div>
        <p>Importa uma live, escolhe o enquadramento e cria um timelapse pronto para partilhar â€” sem perder o LEGO de vista.</p>
      </section>

      <section className="workspace">
        <div className="controls">
          <div className="step-heading"><span>01</span><div><h2>Fonte da live</h2><p>Usa o link da Twitch ou a gravaÃ§Ã£o original.</p></div></div>
          <div className="twitch-row">
          <input aria-label="Link da Twitch" value={twitchUrl} onChange={(event) => setTwitchUrl(event.target.value)} placeholder="https://twitch.tv/xcatarina/v/â€¦" />
            <button type="button" className="dark-button" onClick={tryTwitch}>Tentar importar</button>
          </div>
          {localMode && <div className={vodConnected ? "vod-helper connected" : "vod-helper"}>
            <div><b>{vodConnected ? `VOD ${connectedVodId || "Twitch"} ligada` : "ImportaÃ§Ã£o direta de VOD"}</b><small>{vodConnected ? "A autorizaÃ§Ã£o da tua sessÃ£o foi recebida neste computador." : "Instala uma vez o helper Tampermonkey; depois abre a VOD, inicia sessÃ£o e carrega no Play."}</small></div>
            <a href="/xcatarina-twitch-helper.user.js" target="_blank" rel="noreferrer">Instalar helper</a>
          </div>}
          <div className="or"><span />ou<span /></div>
          <label className="dropzone">
            <input key={sourceInputKey} type="file" accept="video/*" onChange={chooseVideo} />
            <b>{sourceName || "Escolher gravaÃ§Ã£o"}</b>
            <small>MP4, MOV ou WebM Â· o ficheiro fica neste dispositivo</small>
          </label>

          <div className="divider" />
          <div className="step-heading"><span>02</span><div><h2>Enquadramento</h2><p>A VOD gera 6 duraÃ§Ãµes em 16:9 e 9:16; 30 segundos serÃ¡ a versÃ£o pÃºblica principal.</p></div></div>
          <div className="output-pair" aria-label="Formatos gerados">
            <span><i className="ratio wide" /><b>Live completa</b><small>1920 Ã— 1080 Â· 60 fps</small></span>
            <span><i className="ratio tall" /><b>LEGO em foco</b><small>1080 Ã— 1920 Â· 60 fps</small></span>
          </div>
          <div className="content-type" role="group" aria-label="Tipo de criaÃ§Ã£o">
            <span>ConteÃºdo</span>
            <button type="button" className={category === "arte" ? "active" : ""} onClick={() => setCategory("arte")}>Pintura / Arte</button>
            <button type="button" className={category === "lego" ? "active" : ""} onClick={() => setCategory("lego")}>LEGO</button>
          </div>
          <label className="range-row"><span>PosiÃ§Ã£o do recorte LEGO</span><input aria-label="PosiÃ§Ã£o horizontal do recorte LEGO" type="range" min="0" max="100" value={focus} onChange={(event) => setFocus(Number(event.target.value))} /><output>{focus}%</output></label>

          <div className="field-row duration-row">
            <label><span>VersÃ£o para descarregar</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value="8">8 segundos</option><option value="15">15 segundos</option><option value="30">30 segundos Â· principal</option><option value="45">45 segundos</option><option value="60">1 minuto</option><option value="90">1 minuto e 30</option><option value="120">2 minutos Â· apenas Studio</option><option value="300">5 minutos Â· apenas Studio</option><option value="600">10 minutos Â· apenas Studio</option></select></label>
          </div>
          <div className="vod-range"><label><span>InÃ­cio do vÃ­deo (opcional)</span><input value={startAt} onChange={(event) => setStartAt(event.target.value)} placeholder="usar 1.Âº marcador ou 00:00:00" /></label><label><span>Fim do vÃ­deo (opcional)</span><input value={endAt} onChange={(event) => setEndAt(event.target.value)} placeholder="usar Ãºltimo marcador ou atÃ© ao fim" /></label></div>
          <div className="photo-heading"><b>Marcadores visuais</b><span>O horÃ¡rio nunca aparece no vÃ­deo</span></div>
          <p className="photo-help">A primeira imagem da live define o inÃ­cio e a Ãºltima imagem da live define o fim quando os campos acima estÃ£o vazios. Se carregares a 3.Âª imagem, ela tambÃ©m aparece centrada no final, com fade-in e fundo desfocado.</p>
          <div className="photo-slots">
            {photoSlots.map((slot, index) => <div className={slot.file ? "photo-slot filled" : "photo-slot"} key={index} tabIndex={0} onPaste={(event) => pastePhoto(index, event)}>
              <span className="photo-number">0{index + 1}</span>
              {slot.previewUrl ? <img className="photo-preview" src={slot.previewUrl} alt={`PrÃ©-visualizaÃ§Ã£o da imagem ${index + 1}`} /> : <div className="photo-placeholder">Imagem {index + 1}</div>}
              <b>{slot.file?.name || "Colar ou escolher imagem"}</b>
              <small>Ctrl+V nesta caixa</small>
              <label className="file-button">Escolher ficheiro<input type="file" accept="image/*" onChange={(event) => setPhoto(index, event.target.files?.[0] || null)} /></label>
              {index === 2 && <label className="live-check"><input type="checkbox" checked={slot.isLive} onChange={(event) => setPhotoLive(index, event.target.checked)} /> Imagem da live</label>}
              {slot.isLive ? <input className="time-input" aria-label={`Momento da imagem ${index + 1} na live`} type="text" inputMode="numeric" placeholder="HH:MM:SS" value={slot.time} onChange={(event) => setPhotoTime(index, event.target.value)} /> : <small className="reference-only">Imagem final de referÃªncia Â· fica fora do vÃ­deo</small>}
            </div>)}
          </div>
        </div>

        <aside className="preview-panel">
          <div className="preview-head"><span>PRÃ‰-VISUALIZAÃ‡ÃƒO DOS 2 FORMATOS</span><span>16:9 + 9:16</span></div>
          <div className="canvas-wrap horizontal">
            {sourceUrl ? <canvas ref={canvasRef} aria-label="Live 16:9 com limites do recorte vertical 9:16" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); moveCropGuide(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveCropGuide(event); }} /> : twitchEmbed ? <div className="twitch-preview"><iframe title="PrÃ©-visualizaÃ§Ã£o Twitch" src={twitchEmbed} allowFullScreen /><div className="crop-shade left" style={{ width: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100}%` }} /><div className="crop-guide" style={{ left: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100}%`, width: `${(9 / 16) / (16 / 9) * 100}%` }}><span>RECORTE 9:16</span></div><div className="crop-shade right" style={{ left: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100 + (9 / 16) / (16 / 9) * 100}%` }} /><div className="crop-interaction" style={{ left: `${(100 - (9 / 16) / (16 / 9) * 100) * focus / 100}%`, width: `${(9 / 16) / (16 / 9) * 100}%` }} role="slider" aria-label="PosiÃ§Ã£o do recorte vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={focus} tabIndex={0} title="Arrasta para mover o recorte 9:16" onKeyDown={(event) => { if (event.key === "ArrowLeft") setFocus((value) => Math.max(0, value - 1)); if (event.key === "ArrowRight") setFocus((value) => Math.min(100, value + 1)); }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); moveTwitchCropGuide(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTwitchCropGuide(event); }} /></div> : <div className="empty-preview"><span>âœ¦</span><b>O teu timelapse aparece aqui</b><small>Escolhe uma VOD ou gravaÃ§Ã£o para comeÃ§ar</small></div>}
          </div>
          <video ref={videoRef} src={generatedPreview || sourceUrl || undefined} muted playsInline preload="metadata" onLoadedData={refreshPreview} />
          <div className="status" aria-live="polite"><span>{status}</span>{busy && <b>Falta {100 - progress}%</b>}</div>
          {busy && <div className="progress"><i style={{ width: `${progress}%` }} /></div>}
          <button className="generate" type="button" disabled={busy} onClick={localMode && (vodConnected || reusableJob) && !sourceUrl ? generateFromTwitch : generate}>{busy ? "A gerar o pacote 1080p60â€¦" : localMode && (vodConnected || reusableJob) && !sourceUrl ? duration > 90 ? `Gerar pacote pÃºblico + ${duration / 60} min local` : "Gerar 6 duraÃ§Ãµes nos 2 formatos" : sourceUrl ? "Gerar a duraÃ§Ã£o escolhida da gravaÃ§Ã£o" : "Escolhe uma VOD ou gravaÃ§Ã£o"}<span>â†’</span></button>
          <div className="download-grid">
            {(variantDownloads[String(duration)]?.horizontal || downloads.horizontal) && <a className="download" href={variantDownloads[String(duration)]?.horizontal || downloads.horizontal} download={`xcatarina-${category}-${duration}s-horizontal-1080p60-timelapse.mp4`}>Descarregar {duration}s Â· 16:9</a>}
            {(variantDownloads[String(duration)]?.vertical || downloads.vertical) && <a className="download" href={variantDownloads[String(duration)]?.vertical || downloads.vertical} download={`xcatarina-${category}-${duration}s-vertical-1080p60-timelapse.mp4`}>Descarregar {duration}s Â· 9:16</a>}
          </div>
          {Object.keys(variantDownloads).length >= 6 && (downloads.horizontal || downloads.vertical) && <div className="publish-box">
            <span>PUBLICAR NO SITE PÃšBLICO</span>
            <input aria-label="TÃ­tulo pÃºblico" placeholder="TÃ­tulo do vÃ­deo" value={publishTitle} onChange={(event) => setPublishTitle(event.target.value)} />
            <textarea aria-label="DescriÃ§Ã£o pÃºblica" placeholder="DescriÃ§Ã£o curta (opcional)" rows={2} value={publishDescription} onChange={(event) => setPublishDescription(event.target.value)} />
            <label><span>Data do timelapse (por defeito, fim da VOD)</span><input aria-label="Data do timelapse" type="date" value={publishDate} onChange={(event) => { publishDateRef.current = event.target.value; setPublishDate(event.target.value); }} /></label>
            <div className="publish-actions">
              <button className="publish-both" type="button" disabled={Boolean(publishing)} onClick={publishBoth}>{publishing === "both" ? `A publicar Â· ${publishProgress}%` : "Publicar as 6 duraÃ§Ãµes nos 2 formatos"}</button>
              {publicationId && <button type="button" disabled={Boolean(publishing)} onClick={updatePublishedDate}>Atualizar data</button>}
            </div>
            <output>{publishStatus}</output>
          </div>}
          <button className="clear-studio" type="button" disabled={busy || Boolean(publishing)} onClick={clearStudio}>Limpar imagens, horÃ¡rios e VOD</button>
        </aside>
      </section>

      <footer><span>feito para <b>xCatarina</b></span><span>rosa Â· azul-bebÃ© Â· amarelo</span></footer>
    </main>
  );
}




