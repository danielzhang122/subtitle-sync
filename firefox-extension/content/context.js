// Answers {type: "context"}: what this frame says about the content being played.
(() => {
  if (window.__subsyncContextLoaded) return;
  window.__subsyncContextLoaded = true;
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";

  function context() {
    const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => s.textContent).filter((t) => t && t.length < 200000);
    const video = (globalThis.__subsync?.allVideos?.() || [...document.querySelectorAll("video")]).sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    let videoName = "";
    const src = video?.currentSrc || video?.src || video?.querySelector("source")?.src || "";
    if (src && !src.startsWith("blob:")) {
      try { videoName = decodeURIComponent(new URL(src).pathname.split("/").pop() || ""); } catch {}
    }
    return {
      url: location.href,
      title: document.title || "",
      ogTitle: meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]'),
      ogType: meta('meta[property="og:type"]'),
      series: meta('meta[property="video:series"]'),
      h1: document.querySelector("h1")?.textContent?.trim().slice(0, 200) || "",
      jsonld,
      videoName,
    };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "context") return Promise.resolve(context());
  });
})();
