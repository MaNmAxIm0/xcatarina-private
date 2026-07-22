// ==UserScript==
// @name         xCatarina VOD → Timelapse Studio
// @namespace    https://xcatarina-timelapse-studio.vercel.app/
// @version      1.1.0
// @description  Envia a ligação HLS autorizada da VOD Twitch para o estúdio local xCatarina.
// @match        https://www.twitch.tv/*
// @match        https://player.twitch.tv/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(() => {
  "use strict";
  const studio = "http://localhost:3000/api/twitch/session";
  let sent = "";

  function vodId() {
    const match = location.href.match(/(?:videos\/|\/v\/|[?&]video=)(\d+)/);
    return match ? match[1] : "";
  }

  function isManifest(value) {
    try {
      const url = new URL(value, location.href);
      return (url.hostname === "usher.ttvnw.net" || url.hostname.endsWith(".ttvnw.net")) && url.pathname.endsWith(".m3u8");
    } catch { return false; }
  }

  function findPlaybackToken(value) {
    if (!value || typeof value !== "object") return null;
    if (value.videoPlaybackAccessToken?.signature && value.videoPlaybackAccessToken?.value) return value.videoPlaybackAccessToken;
    for (const child of Object.values(value)) {
      const found = findPlaybackToken(child);
      if (found) return found;
    }
    return null;
  }

  function usePlaybackResponse(value) {
    const id = vodId();
    const token = findPlaybackToken(value);
    if (!id || !token) return;
    const query = new URLSearchParams({
      allow_source: "true",
      allow_audio_only: "true",
      playlist_include_framerate: "true",
      reassignments_supported: "true",
      player: "twitchweb",
      sig: token.signature,
      token: token.value,
    });
    send(`https://usher.ttvnw.net/vod/${id}.m3u8?${query}`);
  }

  function send(value) {
    if (!isManifest(value) || value === sent) return;
    sent = value;
    GM_xmlhttpRequest({
      method: "POST",
      url: studio,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ manifestUrl: value, vodId: vodId() }),
      onload: (response) => {
        if (response.status >= 200 && response.status < 300) show("VOD ligada ao Studio ✓", "#52ad77");
        else show("Abre primeiro o Studio local", "#e5679f");
      },
      onerror: () => show("Abre primeiro o Studio local", "#e5679f"),
    });
  }

  function scan() {
    performance.getEntriesByType("resource").forEach((entry) => send(entry.name));
  }

  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const originalFetch = page.fetch;
  page.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    send(url);
    const request = originalFetch.call(this, input, init);
    if (String(url).includes("gql.twitch.tv/gql")) {
      request.then((response) => response.clone().json()).then(usePlaybackResponse).catch(() => {});
    }
    return request;
  };

  const originalOpen = page.XMLHttpRequest.prototype.open;
  page.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    send(String(url));
    if (String(url).includes("gql.twitch.tv/gql")) {
      this.addEventListener("load", () => {
        try { usePlaybackResponse(typeof this.response === "string" ? JSON.parse(this.response) : this.response); } catch {}
      }, { once: true });
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  function show(text, color) {
    const mount = () => {
      let badge = document.getElementById("xcatarina-vod-helper");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "xcatarina-vod-helper";
        Object.assign(badge.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647", padding: "10px 14px", borderRadius: "999px", color: "#181321", font: "700 12px system-ui", boxShadow: "0 5px 25px #0008" });
        document.documentElement.appendChild(badge);
      }
      badge.textContent = text;
      badge.style.background = color;
    };
    if (document.documentElement) mount();
    else addEventListener("DOMContentLoaded", mount, { once: true });
  }

  new PerformanceObserver((list) => list.getEntries().forEach((entry) => send(entry.name))).observe({ type: "resource", buffered: true });
  setInterval(scan, 2000);
  addEventListener("DOMContentLoaded", () => show("À espera da VOD…", "#ffd760"), { once: true });
})();
