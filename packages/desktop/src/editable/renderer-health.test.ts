import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editableFixture } from "../../test-support/editable-fixture.js";
import { EditableReleaseStore } from "./release-store.js";
import { watchRendererHealth } from "./renderer-health.js";

let fixture: ReturnType<typeof editableFixture>;
beforeEach(() => {
  fixture = editableFixture();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fixture.clean();
});

const url = "paseo://app/";
function monitorRelease({ withLastKnownGood = true } = {}) {
  const a = fixture.release("release A");
  const b = fixture.release("release B");
  fixture.setChannel(a.digest, 1);
  const store = new EditableReleaseStore(fixture);
  store.pin(1, store.activeRelease);
  if (withLastKnownGood) expect(store.reportHealthy(1, a.digest)).toBe(true);
  fixture.setChannel(b.digest, 2);
  store.pin(1, store.reloadChannel());
  const monitor = new EventEmitter();
  const webContents = new EventEmitter();
  let visible = false;
  const win = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => false,
    isFocused: () => true,
  });
  watchRendererHealth(win as unknown as Electron.BrowserWindow, {
    pending: () => store.isPending(1, b.digest),
    matchesNavigation: (candidate) => candidate === url,
    fail: () => store.pin(1, store.quarantine(b.digest)),
    monitor: monitor as unknown as Electron.PowerMonitor,
    timeoutMs: 60_000,
  });
  return {
    a,
    b,
    monitor,
    store,
    webContents,
    show: () => {
      visible = true;
      win.emit("show");
    },
  };
}

describe("renderer startup health", () => {
  it("quarantines a failed main document and persists the last known good rollback", () => {
    const { a, b, store, webContents } = monitorRelease();

    webContents.emit("did-fail-load", {}, -6, "FILE_NOT_FOUND", url, false);
    webContents.emit("did-fail-load", {}, -3, "ABORTED", url, true);
    webContents.emit("did-fail-load", {}, -6, "FILE_NOT_FOUND", "paseo://app/other", true);
    expect(store.getStatus(1).quarantinedDigests).toEqual([]);

    webContents.emit("did-fail-load", {}, -6, "FILE_NOT_FOUND", url, true);
    expect(store.getStatus(1)).toMatchObject({
      activeDigest: a.digest,
      releaseDigest: a.digest,
      activeGeneration: 2,
      quarantinedDigests: [b.digest],
    });
    expect(new EditableReleaseStore(fixture).activeRelease.releaseDigest).toBe(a.digest);
    expect(() => store.switchRelease(b.digest)).toThrow("quarantined");
  });

  it("quarantines a renderer crash before health and recovers to built-in when needed", () => {
    const { b, store, webContents } = monitorRelease({ withLastKnownGood: false });
    webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
    expect(store.activeRelease.releaseDigest).toBe(b.digest);
    webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(store.getStatus(1)).toMatchObject({
      activeDigest: null,
      releaseDigest: null,
      quarantinedDigests: [b.digest],
    });
  });

  it("waits through hidden and suspended time before a foreground renderer must report healthy", () => {
    const { b, monitor, show, store, webContents } = monitorRelease();
    webContents.emit("did-finish-load");
    vi.advanceTimersByTime(120_000);
    expect(store.activeRelease.releaseDigest).toBe(b.digest);
    show();
    vi.advanceTimersByTime(30_000);
    monitor.emit("suspend");
    vi.advanceTimersByTime(120_000);
    expect(store.activeRelease.releaseDigest).toBe(b.digest);
    monitor.emit("resume");
    vi.advanceTimersByTime(60_000);
    expect(store.getStatus(1).quarantinedDigests).toEqual([b.digest]);
  });

  it("only accepts a health report from the matching pinned window", () => {
    const { a, b, show, store, webContents } = monitorRelease();
    expect(store.reportHealthy(2, b.digest)).toBe(false);
    expect(store.reportHealthy(1, a.digest)).toBe(false);
    expect(store.reportHealthy(1, b.digest)).toBe(true);
    show();
    vi.advanceTimersByTime(120_000);
    webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(store.getStatus(1)).toMatchObject({
      activeDigest: b.digest,
      lastKnownGoodDigest: b.digest,
      quarantinedDigests: [],
    });
  });
});
