import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CloudChannelCandidate } from "./cloud-sync.js";
import { DESKTOP_RUNTIME_VERSION, isSafeRenderer, resolveEditableHome } from "./constants.js";
import { resolveRegularFile, verifyReleaseDirectory, verifySignedEnvelope } from "./crypto.js";
import { validatePreviewUrl } from "./preview.js";
import {
  channelManifestSchema,
  deviceStateSchema,
  digestSchema,
  type DeviceState,
} from "./schema.js";

interface Integrity {
  bytes: number;
  sha256: string;
}

export interface RendererRelease {
  releaseDigest: string | null;
  distDir: string;
  files: ReadonlyMap<string, Integrity> | null;
  summary?: string | null;
}

export interface EditableDesktopStatus {
  runtimeVersion: string;
  activeDigest: string | null;
  releaseDigest: string | null;
  availableDigest: string | null;
  lastKnownGoodDigest: string | null;
  quarantinedDigests: string[];
  previewUrl: string | null;
  activeGeneration: number;
  safeRenderer: boolean;
  releaseSummary?: string | null;
  activeChannel?: string;
  availableSummary?: string | null;
}

export interface ChannelReleasePointer {
  channel: string;
  digest: string;
  generation: number;
  sourceSha: string;
  summary: string;
  updatedAt: string;
}

export interface RendererFile {
  filePath: string;
  integrity: Integrity | null;
}

function readJson(filename: string): unknown {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function initialState(): DeviceState {
  return {
    schemaVersion: 1,
    activeDigest: null,
    lastKnownGoodDigest: null,
    quarantinedDigests: [],
    previewUrl: null,
    activeGeneration: 0,
  };
}

export class EditableReleaseStore {
  readonly windowReleaseRegistry = new Map<number, RendererRelease>();
  readonly windowChannelRegistry = new Map<number, string>();
  readonly builtIn: RendererRelease;
  readonly safe: boolean;
  private readonly home: string;
  private readonly publicKeyHome: string;
  private readonly warn: (error: unknown) => void;
  private state = initialState();
  private active: RendererRelease;
  private stateReadable = true;
  private readonly healthyDigests = new Set<string>();

  constructor(input: {
    builtInDistDir: string;
    home?: string;
    publicKeyHome?: string;
    safe?: boolean;
    warn?: (error: unknown) => void;
  }) {
    this.home = input.home ?? resolveEditableHome();
    this.publicKeyHome = input.publicKeyHome ?? this.home;
    this.safe = input.safe ?? isSafeRenderer();
    this.warn = input.warn ?? (() => {});
    this.builtIn = { releaseDigest: null, distDir: input.builtInDistDir, files: null };
    this.active = this.builtIn;
    if (!this.safe) this.initialize();
  }

  private initialize(): void {
    try {
      this.state = deviceStateSchema.parse(readJson(path.join(this.home, "device-state.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warn(error);
        this.stateReadable = false;
        // A damaged high-water mark cannot safely admit a channel generation.
        return;
      }
    }

    if (this.state.lastKnownGoodDigest) this.healthyDigests.add(this.state.lastKnownGoodDigest);
    this.active =
      this.state.activeDigest === null
        ? this.builtIn
        : (this.tryRelease(this.state.activeDigest) ?? this.recoveryRelease());
    if (!existsSync(path.join(this.home, "releases/electron-web/channel.json"))) return;
    try {
      this.reloadChannel();
    } catch (error) {
      this.warn(error);
    }
  }

  private save(state: DeviceState): void {
    const filename = path.join(this.home, "device-state.json");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, filename);
      this.state = state;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  publicKey(): string {
    return readFileSync(path.join(this.publicKeyHome, "keys", "signing.public.pem"), "utf8");
  }

  private manifestPath(digest: string): string | null {
    return (
      resolveRegularFile(this.home, `releases/electron-web/${digest}/manifest.json`) ??
      (this.publicKeyHome !== this.home
        ? resolveRegularFile(this.publicKeyHome, `releases/electron-web/${digest}/manifest.json`)
        : null)
    );
  }

  hasInstalledRelease(digest: string): boolean {
    return this.manifestPath(digest) !== null;
  }

  isQuarantined(digest: string): boolean {
    return this.state.quarantinedDigests.includes(digest);
  }

  get activeChannel(): string {
    return this.state.activeChannel ?? "prod";
  }

  getWindowChannel(windowId: number): string {
    return this.windowChannelRegistry.get(windowId) ?? this.activeChannel;
  }

  getWindowRelease(windowId: number): RendererRelease | undefined {
    return this.windowReleaseRegistry.get(windowId);
  }

  private readChannelPointerFromHome(home: string, channel: string): ChannelReleasePointer | null {
    const rel =
      channel === "prod"
        ? "releases/electron-web/channel.json"
        : `releases/electron-web/channels/${channel}.json`;
    const filename = resolveRegularFile(home, rel);
    if (!filename) return null;
    try {
      const envelope = readJson(filename);
      if (!verifySignedEnvelope(envelope, this.publicKey())) return null;
      const parsed = channelManifestSchema.parse(envelope.payload);
      if (parsed.channel !== channel) return null;
      const target = parsed.surfaces["electron-web"];
      if (!target || target.runtimeVersion !== DESKTOP_RUNTIME_VERSION) return null;
      return {
        channel: parsed.channel,
        digest: target.releaseDigest,
        generation: parsed.generation,
        sourceSha: target.sourceSha,
        summary: target.summary,
        updatedAt: target.updatedAt,
      };
    } catch {
      return null;
    }
  }

  getChannelPointer(channel: string): ChannelReleasePointer | null {
    if (this.safe || !this.stateReadable) return null;
    const local = this.readChannelPointerFromHome(this.home, channel);
    const shared =
      this.publicKeyHome !== this.home
        ? this.readChannelPointerFromHome(this.publicKeyHome, channel)
        : null;
    let best: ChannelReleasePointer | null = local;
    if (shared && (!best || shared.generation > best.generation)) {
      best = shared;
    }
    if (!best) return null;
    if (channel === "prod" && best.generation < this.state.activeGeneration) return null;
    return best;
  }

  private loadRelease(digest: unknown): RendererRelease {
    const releaseDigest = digestSchema.parse(digest);
    if (this.state.quarantinedDigests.includes(releaseDigest)) {
      throw new Error("Renderer release is quarantined");
    }
    const manifestPath = this.manifestPath(releaseDigest);
    if (!manifestPath) throw new Error("Renderer release is missing its signed manifest");
    const distDir = path.dirname(manifestPath);
    const manifest = verifyReleaseDirectory(
      distDir,
      readJson(manifestPath),
      this.publicKey(),
      DESKTOP_RUNTIME_VERSION,
    );
    if (manifest.releaseDigest !== releaseDigest) throw new Error("Release digest mismatch");
    return {
      distDir,
      releaseDigest,
      summary: manifest.summary,
      files: new Map(
        manifest.files.map(({ path: relative, bytes, sha256 }) => [relative, { bytes, sha256 }]),
      ),
    };
  }

  private tryRelease(digest: string | null): RendererRelease | null {
    if (digest === null) return null;
    try {
      return this.loadRelease(digest);
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  get activeRelease(): RendererRelease {
    return this.active;
  }

  getStatus(windowId: number): EditableDesktopStatus {
    const { previewUrl, activeGeneration, lastKnownGoodDigest, quarantinedDigests } = this.state;
    const pinned = this.windowReleaseRegistry.get(windowId);
    const activeChannel = this.getWindowChannel(windowId);
    const releaseSummary = pinned?.summary ?? this.active.summary ?? null;
    const channelCandidate =
      activeChannel === "prod"
        ? this.availableChannelRelease()
        : this.availableForChannel(activeChannel);
    return {
      runtimeVersion: DESKTOP_RUNTIME_VERSION,
      activeDigest: this.active.releaseDigest,
      releaseDigest: pinned?.releaseDigest ?? null,
      availableDigest: channelCandidate?.digest ?? null,
      lastKnownGoodDigest,
      quarantinedDigests: [...quarantinedDigests],
      previewUrl,
      activeGeneration,
      safeRenderer: this.safe,
      ...(releaseSummary !== null ? { releaseSummary } : {}),
      ...(activeChannel !== "prod" ? { activeChannel } : {}),
      ...(channelCandidate?.summary ? { availableSummary: channelCandidate.summary } : {}),
    };
  }

  private availableForChannel(channel: string): ChannelReleasePointer | null {
    if (this.safe || !this.stateReadable) return null;
    const ptr = this.getChannelPointer(channel);
    if (!ptr || this.state.quarantinedDigests.includes(ptr.digest)) return null;
    return this.manifestPath(ptr.digest) ? ptr : null;
  }

  private readChannelRelease({ fromMenu = false } = {}) {
    this.requireEditable();
    const filename = resolveRegularFile(this.home, "releases/electron-web/channel.json");
    if (!filename) throw new Error("No local signed renderer channel");
    const envelope = readJson(filename);
    if (!verifySignedEnvelope(envelope, this.publicKey())) {
      throw new Error("Invalid renderer channel signature");
    }
    const channel = channelManifestSchema.parse(envelope.payload);
    const target = channel.surfaces["electron-web"];
    if (!target || target.runtimeVersion !== DESKTOP_RUNTIME_VERSION) {
      throw new Error("Channel has no compatible desktop renderer");
    }
    const { activeGeneration, activeDigest } = this.state;
    if (
      channel.generation < activeGeneration ||
      (channel.generation === activeGeneration &&
        target.releaseDigest !== activeDigest &&
        !(fromMenu && activeDigest === null))
    ) {
      throw new Error("Renderer channel generation has already been superseded");
    }
    return {
      digest: target.releaseDigest,
      generation: channel.generation,
      summary: target.summary,
    };
  }

  private availableChannelRelease() {
    if (this.safe || !this.stateReadable) return null;
    try {
      const candidate = this.readChannelRelease();
      if (this.state.quarantinedDigests.includes(candidate.digest)) return null;
      // The publisher must install the immutable directory before advertising it.
      return this.manifestPath(candidate.digest) ? candidate : null;
    } catch {
      const shared = this.getChannelPointer("prod");
      if (!shared || this.state.quarantinedDigests.includes(shared.digest)) return null;
      return this.manifestPath(shared.digest)
        ? { digest: shared.digest, generation: shared.generation, summary: shared.summary }
        : null;
    }
  }

  shouldInstallCloudChannel({ digest, generation }: CloudChannelCandidate): boolean {
    this.requireEditable();
    if (
      this.state.quarantinedDigests.includes(digest) ||
      generation <= this.state.activeGeneration
    ) {
      return false;
    }

    // A local publisher can install a signed pointer without activating it in this window.
    let local: CloudChannelCandidate | undefined;
    try {
      local = this.readChannelRelease();
    } catch {
      return true;
    }
    return (
      generation > local.generation || (generation === local.generation && digest === local.digest)
    );
  }

  reloadChannel(options?: { fromMenu?: boolean }): RendererRelease {
    const { digest, generation } = this.readChannelRelease(options);
    if (digest === this.active.releaseDigest && generation === this.state.activeGeneration) {
      return this.active;
    }
    const release = this.loadRelease(digest);
    this.save({ ...this.state, activeDigest: digest, activeGeneration: generation });
    this.active = release;
    return release;
  }

  switchRelease(digest: unknown): RendererRelease {
    this.requireEditable();
    const release = digest === null ? this.builtIn : this.loadRelease(digest);
    const currentChannel = this.activeChannel;
    const candidate =
      currentChannel === "prod"
        ? this.availableChannelRelease()
        : this.availableForChannel(currentChannel);
    const activeGeneration =
      currentChannel === "prod" && candidate?.digest === release.releaseDigest
        ? Math.max(this.state.activeGeneration, candidate.generation)
        : this.state.activeGeneration;
    this.save({
      ...this.state,
      activeDigest: release.releaseDigest,
      activeGeneration,
      activeChannel: currentChannel,
    });
    this.active = release;
    return release;
  }

  switchToChannel(channel: string, digest: string | null, generation?: number): RendererRelease {
    this.requireEditable();
    const release = digest === null ? this.builtIn : this.loadRelease(digest);
    const activeGeneration =
      channel === "prod" && typeof generation === "number"
        ? Math.max(this.state.activeGeneration, generation)
        : this.state.activeGeneration;
    this.save({
      ...this.state,
      activeDigest: release.releaseDigest,
      activeGeneration,
      activeChannel: channel,
    });
    this.active = release;
    return release;
  }

  useRecoveryRenderer(): RendererRelease {
    // Retain the accepted channel pointer so the native menu can retry it.
    this.active = this.builtIn;
    return this.active;
  }

  setPreviewUrl(url: unknown): void {
    this.requireEditable();
    const previewUrl = url === null ? null : validatePreviewUrl(url);
    if (previewUrl !== this.state.previewUrl) this.save({ ...this.state, previewUrl });
  }

  private requireEditable(): void {
    if (this.safe) throw new Error("Editable renderer is disabled in safe renderer mode");
    if (!this.stateReadable) throw new Error("Cannot read editable renderer device state");
  }

  pin(windowId: number, release: RendererRelease, channel?: string): void {
    this.windowReleaseRegistry.set(windowId, release);
    if (channel !== undefined) this.windowChannelRegistry.set(windowId, channel);
  }

  unpin(windowId: number): void {
    this.windowReleaseRegistry.delete(windowId);
    this.windowChannelRegistry.delete(windowId);
  }

  reportHealthy(windowId: number, digest: unknown): boolean {
    if (
      typeof digest !== "string" ||
      this.windowReleaseRegistry.get(windowId)?.releaseDigest !== digest ||
      this.state.quarantinedDigests.includes(digest)
    ) {
      return false;
    }
    if (digest === this.active.releaseDigest && digest !== this.state.lastKnownGoodDigest) {
      this.save({ ...this.state, lastKnownGoodDigest: digest });
    }
    this.healthyDigests.add(digest);
    return true;
  }

  isPending(windowId: number, digest: unknown): boolean {
    return (
      typeof digest === "string" &&
      this.windowReleaseRegistry.get(windowId)?.releaseDigest === digest &&
      !this.healthyDigests.has(digest) &&
      !this.state.quarantinedDigests.includes(digest)
    );
  }

  private recoveryRelease(): RendererRelease {
    return this.tryRelease(this.state.lastKnownGoodDigest) ?? this.builtIn;
  }

  quarantine(digest: string): RendererRelease {
    const fallback = this.recoveryRelease();
    if (!this.state.quarantinedDigests.includes(digest)) {
      const wasActive = this.active.releaseDigest === digest;
      const state = {
        ...this.state,
        activeDigest:
          this.state.activeDigest === digest ? fallback.releaseDigest : this.state.activeDigest,
        quarantinedDigests: [...this.state.quarantinedDigests, digest],
      };
      try {
        this.save(state);
      } catch (error) {
        this.warn(error);
        this.state = state;
      }
      if (wasActive) this.active = fallback;
    }
    return fallback;
  }

  resolveDocument(file: string, selection: string | null): RendererFile | null {
    if (selection === "builtin") return this.resolveIn(this.builtIn, file);
    const release = selection === null ? this.active : this.findPinned(selection, false);
    return release ? this.resolveIn(release, file) : null;
  }

  resolveAsset(file: string, prefix?: string): RendererFile | null {
    if (prefix !== undefined) {
      const release = this.findPinned(prefix, true);
      return release ? this.resolveIn(release, file) : null;
    }
    const order = new Set([this.active, ...this.windowReleaseRegistry.values(), this.builtIn]);
    for (const release of order) {
      const result = this.resolveIn(release, file);
      if (result) return result;
    }
    return null;
  }

  private findPinned(digest: string, prefix: boolean): RendererRelease | null {
    const releases = new Map<string, RendererRelease>();
    for (const release of [this.active, ...this.windowReleaseRegistry.values()]) {
      const id = release.releaseDigest;
      if (id && (prefix ? id.slice(0, 16) === digest : id === digest)) releases.set(id, release);
    }
    return releases.size === 1 ? (releases.values().next().value ?? null) : null;
  }

  private resolveIn(release: RendererRelease, file: string): RendererFile | null {
    const integrity = release.files?.get(file) ?? null;
    if (release.files && !integrity) return null;
    if (release.releaseDigest && this.state.quarantinedDigests.includes(release.releaseDigest))
      return null;
    const filePath = resolveRegularFile(release.distDir, file);
    return filePath ? { filePath, integrity } : null;
  }
}
