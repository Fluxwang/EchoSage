// Runs in the page world at document_start.
// TikTok only fills #__UNIVERSAL_DATA_FOR_REHYDRATION__ on the first load, so every later
// video (feed scroll, in-app navigation) is only visible in its own API responses.
// This taps those responses and forwards the video records to the content script.
(() => {
  const CHANNEL = "echosage-tiktok";
  const API = /\/api\/(item|recommend|post|related|search|user|commerce|product|shop)\b/;
  const MAX_DEPTH = 9;
  const MAX_ITEMS = 60;
  const cachedItems = new Map();

  function pick(item) {
    const video = item.video || {};
    return {
      id: String(item.id || item.aweme_id || ""),
      desc: item.desc || "",
      createTime: item.createTime || item.create_time || 0,
      textLanguage: item.textLanguage || "",
      stats: item.stats || item.statistics || {},
      products: productsFor(item),
      video: {
        cover: video.cover || video.originCover || video.dynamicCover || "",
        claInfo: video.claInfo,
        subtitleInfos: video.subtitleInfos || video.subtitle_infos || []
      }
    };
  }

  // TikTok Shop tags a video by putting a JSON-encoded product blob two levels deep:
  // item.anchors[n].extra is a JSON string of a 1-element array, whose .extra is itself
  // a JSON string of the actual product (title/img_url/product_id/seo_url/categories).
  function productFromAnchors(anchors) {
    if (!Array.isArray(anchors)) return null;
    const carrier = anchors.find(anchor => typeof anchor?.extra === "string" && anchor.extra);
    if (!carrier) return null;
    try {
      const entry = JSON.parse(carrier.extra)?.[0];
      if (typeof entry?.extra !== "string") return null;
      // product_id/sku_id/seller_id can exceed Number precision, so quote them before parsing.
      const safe = entry.extra.replace(/("(?:product_id|sku_id|seller_id)"\s*:\s*)(\d{16,})/g, (_match, prefix, digits) => `${prefix}"${digits}"`);
      const product = JSON.parse(safe);
      if (!product?.product_id) return null;
      return {
        id: String(product.product_id),
        title: product.title || "",
        image: product.img_url || "",
        url: /^https?:\/\//i.test(product.seo_url || "") ? product.seo_url : ""
      };
    } catch {
      return null;
    }
  }

  function productsFor(item) {
    const product = productFromAnchors(item.anchors);
    return product ? [product] : [];
  }

  function collect(value, depth, out) {
    if (!value || typeof value !== "object" || depth > MAX_DEPTH || out.length >= MAX_ITEMS) return out;
    if (Array.isArray(value)) {
      for (const child of value) collect(child, depth + 1, out);
      return out;
    }
    const item = value.itemStruct && typeof value.itemStruct === "object" ? value.itemStruct : value;
    if ((item.id || item.aweme_id) && item.video && (item.stats || item.statistics)) {
      const picked = pick(item);
      if (picked.id) {
        out.push(picked);
        return out;
      }
    }
    for (const child of Object.values(value)) collect(child, depth + 1, out);
    return out;
  }

  function publish(payload) {
    let data = payload;
    if (typeof data === "string") {
      if (!data.includes("itemStruct") && !data.includes("itemList") && !data.includes("aweme")) return;
      try { data = JSON.parse(data); } catch { return; }
    }
    const items = collect(data, 0, []);
    for (const item of items) {
      cachedItems.delete(item.id);
      cachedItems.set(item.id, item);
      if (cachedItems.size > MAX_ITEMS) cachedItems.delete(cachedItems.keys().next().value);
    }
    if (items.length) window.postMessage({ source: CHANNEL, items }, location.origin);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = nativeFetch.apply(this, args);
    const url = String(typeof args[0] === "string" ? args[0] : args[0]?.url || "");
    if (API.test(url)) {
      promise.then(response => response.clone().text().then(publish)).catch(() => {});
    }
    return promise;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (API.test(String(url))) {
      this.addEventListener("load", () => {
        try { publish(this.responseType === "json" ? this.response : this.responseText); } catch { /* ignore */ }
      });
    }
    return nativeOpen.call(this, method, url, ...rest);
  };

  function readHydration() {
    const node = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (!node) return;
    try { publish(JSON.parse(node.textContent || "")); } catch { /* ignore */ }
  }

  // document_idle can start after hydration or early API messages were delivered.
  // Replay only after the isolated-world receiver has installed its listener.
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "echosage-tiktok-content" || event.data?.type !== "ready") return;
    readHydration();
    if (cachedItems.size) window.postMessage({ source: CHANNEL, items: [...cachedItems.values()] }, location.origin);
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", readHydration, { once: true });
  else readHydration();
})();
