import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../inject.js", import.meta.url), "utf8");
const first = { id: "7629010400910019870", desc: "First video", video: { subtitleInfos: [{ Format: "webvtt", Url: "https://example.com/captions.vtt" }] }, stats: { playCount: 42 } };

function page() {
  const windowListeners = [];
  const documentListeners = new Map();
  const messages = [];
  let hydration = null;
  let response = {};
  const window = {
    addEventListener(type, listener) { if (type === "message") windowListeners.push(listener); },
    postMessage(data) { messages.push(data); },
    async fetch() { return { clone: () => ({ text: async () => JSON.stringify(response) }) }; },
  };
  const document = {
    readyState: "loading",
    getElementById(id) { return id === "__UNIVERSAL_DATA_FOR_REHYDRATION__" && hydration ? { textContent: JSON.stringify(hydration) } : null; },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = () => {};
  vm.runInNewContext(source, { window, document, XMLHttpRequest, location: { origin: "https://www.tiktok.com" } });
  function flush() {
    while (messages.length) {
      const data = messages.shift();
      for (const listener of [...windowListeners]) listener({ source: window, data });
    }
  }
  return {
    window, flush,
    hydrate(item) { hydration = { __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: item } } } }; },
    loaded() { document.readyState = "interactive"; documentListeners.get("DOMContentLoaded")?.(); flush(); },
    receive() {
      const items = new Map();
      window.addEventListener("message", event => {
        if (event.data?.source === "echosage-tiktok") for (const item of event.data.items || []) items.set(item.id, item);
      });
      window.postMessage({ source: "echosage-tiktok-content", type: "ready" });
      flush();
      return items;
    },
    async api(item) {
      response = { itemList: [item] };
      await window.fetch("https://www.tiktok.com/api/recommend/item_list/");
      await new Promise(resolve => setImmediate(resolve));
      flush();
    },
  };
}

test("direct URL: first video hydration is delivered to a receiver starting after DOMContentLoaded", () => {
  const browser = page();
  browser.hydrate(first);
  browser.loaded();
  const items = browser.receive();
  assert.equal(items.get(first.id)?.desc, first.desc, "first video must leave the pending data state without scrolling");
  assert.equal(items.get(first.id)?.video.subtitleInfos[0].Url, first.video.subtitleInfos[0].Url);
});

test("early API response is replayed even if hydration has disappeared", async () => {
  const browser = page();
  await browser.api(first);
  const items = browser.receive();
  assert.equal(items.get(first.id)?.desc, first.desc);
});

test("receiver ready before hydration still receives the first video and subsequent scroll responses", async () => {
  const browser = page();
  const items = browser.receive();
  browser.hydrate(first);
  browser.loaded();
  assert.equal(items.get(first.id)?.desc, first.desc);
  const next = { ...first, id: "7629010400910019871", desc: "Next video" };
  await browser.api(next);
  assert.equal(items.get(next.id)?.desc, next.desc);
});
