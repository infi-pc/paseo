import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { rendererNavigationUrl } from "./protocol.js";
import { loadRendererDocument } from "./renderer-navigation.js";

describe("pinned renderer navigation", () => {
  it("waits for the fallback document when Chromium finishes the failed page first", async () => {
    const webContents = new EventEmitter();
    const win = { webContents, loadURL: () => Promise.resolve() };
    const release = { releaseDigest: "a".repeat(64), distDir: "/renders/a", files: null };
    const url = rendererNavigationUrl("/agents/a", release);
    const loaded = vi.fn();

    const pending = loadRendererDocument(
      win as unknown as Electron.BrowserWindow,
      url,
      release,
      new AbortController().signal,
    ).then(loaded);

    webContents.emit("did-finish-load");
    await Promise.resolve();
    expect(loaded).not.toHaveBeenCalled();

    webContents.emit("did-navigate", {}, url);
    webContents.emit("did-finish-load");
    await pending;
    expect(loaded).toHaveBeenCalledOnce();
    expect(webContents.listenerCount("did-finish-load")).toBe(0);
  });
});
