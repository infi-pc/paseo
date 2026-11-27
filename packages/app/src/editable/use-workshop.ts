import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import type {
  EditableBranchAgentRecord,
  EditableBranchesSnapshot,
  EditableDesktopBridge,
  EditableElementSnapshot,
  EditableLocatorContext,
  EditableReferencedElement,
  EditableScreenshotAttachment,
  EditableWorkshopConfig,
  EditableWorkshopDaemonStatus,
} from "./types";
import { sendWorkshopEdit, slugifyEditRequest, WORKSHOP_NAME } from "./workshop-client";

const STORAGE_KEY = "paseo.editable.workshop";
const WORKSHOP_START_TIMEOUT_MS = 45_000;
const WORKSHOP_CONNECT_TIMEOUT_MS = 15_000;

const branchAgentSchema = z.object({
  slug: z.string(),
  agentId: z.string(),
  request: z.string(),
  createdAt: z.string(),
});

const schema = z.object({
  workshopHostId: z.string().nullable().default(null),
  workshopCwd: z.string().nullable().default(null),
  workshopAgentId: z.string().nullable().default(null),
  lastRequest: z.string().nullable().optional().default(null),
  branchAgents: z.record(z.string(), branchAgentSchema).optional().default({}),
  enabled: z.boolean().default(true),
});
const defaults = schema.parse({});

export interface UseWorkshopOptions {
  bridge?: EditableDesktopBridge;
  workshopDaemon?: EditableWorkshopDaemonStatus | null;
  branches?: EditableBranchesSnapshot | null;
  refreshDesktop?: () => Promise<void>;
}

async function waitForHostOnline(serverId: string, timeoutMs: number): Promise<boolean> {
  const runtime = getHostRuntimeStore();
  if (isHostRuntimeConnected(runtime.getSnapshot(serverId))) return true;
  let resolveWait!: (ok: boolean) => void;
  const waiting = new Promise<boolean>((resolve) => {
    resolveWait = resolve;
  });
  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    resolveWait(ok);
  };
  const unsubscribe = runtime.subscribe(serverId, () => {
    if (isHostRuntimeConnected(runtime.getSnapshot(serverId))) finish(true);
  });
  const timer = setTimeout(() => finish(false), timeoutMs);
  return waiting;
}

function resolveBranchSendTarget(input: {
  config: EditableWorkshopConfig;
  branches: EditableBranchesSnapshot | null;
  request: string;
  branchTarget?: { slug?: string | null; isFollowUp?: boolean };
}): { slug: string; isFollowUp: boolean; followUpAgentId: string | null } {
  const existingSlugs = new Set<string>([
    ...Object.keys(input.config.branchAgents ?? {}),
    ...(input.branches?.branches.map((b) => b.slug) ?? []),
  ]);
  const isFollowUp = Boolean(input.branchTarget?.isFollowUp && input.branchTarget.slug);
  const slug = isFollowUp
    ? input.branchTarget!.slug!
    : slugifyEditRequest(input.request, existingSlugs);
  const followUpAgentId = isFollowUp
    ? (input.config.branchAgents?.[slug]?.agentId ??
      input.branches?.branches.find((b) => b.slug === slug)?.agentId ??
      null)
    : null;
  return { slug, isFollowUp, followUpAgentId };
}

async function prepareWorktreeForSend(
  bridge: EditableDesktopBridge | undefined,
  slug: string,
): Promise<string | null> {
  if (!bridge?.createBranch) return null;
  const created = await bridge.createBranch({ slug });
  if (!created.ok) {
    throw new Error(created.error ?? `Failed to create worktree ${slug}`);
  }
  return created.worktreePath ?? null;
}

function pickTrimmed(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function isLegacyWorkshopTitle(title: string | null): boolean {
  return Boolean(
    title &&
    (title.startsWith("Editable: ") ||
      title === "Editable Paseo Workshop" ||
      title.startsWith("You are the Editable Paseo Workshop")),
  );
}

function maybeRepairPreambleTitle(
  client: {
    updateAgent?: (id: string, updates: { namingMode?: "automatic" | "manual" }) => Promise<void>;
  },
  id: string,
  agent: { title?: string | null; responseMetadata?: { namingMode?: string } },
): void {
  if (
    agent.title?.startsWith("You are the Editable Paseo Workshop") &&
    agent.responseMetadata?.namingMode !== "automatic"
  ) {
    void client.updateAgent?.(id, { namingMode: "automatic" }).catch(() => undefined);
  }
}

function syncBranchDisplayMeta(
  slug: string,
  meta: { title: string | null; icon: string | null },
  syncedMeta: Map<string, string>,
  bridge: EditableDesktopBridge | undefined,
): void {
  if (!meta.title && !meta.icon) return;
  const sig = `${meta.title ?? ""}\u0000${meta.icon ?? ""}`;
  if (syncedMeta.get(slug) === sig) return;
  syncedMeta.set(slug, sig);
  void bridge?.updateBranchMeta?.(slug, meta).catch(() => undefined);
}

function resolveAgentDisplayMeta(agent: {
  title?: string | null;
  icon?: string | null;
  responseMetadata?: {
    automaticTitle?: string;
    automaticIcon?: string;
    icon?: string;
    lastTurn?: { message?: string };
  };
}): { title: string | null; icon: string | null; reply: string | null } {
  const meta = agent.responseMetadata;
  const rawTitle = pickTrimmed(agent.title);
  const autoTitle = pickTrimmed(meta?.automaticTitle);
  const title = !rawTitle || isLegacyWorkshopTitle(rawTitle) ? autoTitle : rawTitle;
  const icon = pickTrimmed(meta?.icon, meta?.automaticIcon, agent.icon);
  const reply = pickTrimmed(meta?.lastTurn?.message);
  return { title, icon, reply };
}

export function useWorkshop(options: UseWorkshopOptions = {}) {
  const { bridge, workshopDaemon = null, branches = null, refreshDesktop } = options;
  const managedWorkshop = Boolean(bridge?.startWorkshopDaemon);
  const hosts = useHosts();
  const [config, setConfig] = useState<EditableWorkshopConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [startingWorkshop, setStartingWorkshop] = useState(false);
  const [workshopError, setWorkshopError] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({});
  const [agentReplies, setAgentReplies] = useState<Record<string, string>>({});
  const [agentTitles, setAgentTitles] = useState<Record<string, string>>({});
  const [agentIcons, setAgentIcons] = useState<Record<string, string>>({});
  const [unreadReplySlugs, setUnreadReplySlugs] = useState<string[]>([]);
  const [pendingBranches, setPendingBranches] = useState<
    Record<string, { slug: string; request: string; createdAt: string }>
  >({});
  const locked = useRef(false);
  const pendingSlugsRef = useRef<Set<string>>(new Set());
  const prevRunningRef = useRef<Set<string>>(new Set());
  const syncedMetaRef = useRef<Map<string, string>>(new Map());
  const configRef = useRef<EditableWorkshopConfig | null>(null);
  configRef.current = config;

  const effectiveHostId =
    managedWorkshop && workshopDaemon?.serverId
      ? workshopDaemon.serverId
      : (config?.workshopHostId ?? null);
  const agentId = config?.workshopAgentId ?? null;
  const isConnected = useHostRuntimeIsConnected(effectiveHostId ?? "");
  const host = hosts.find((entry) => entry.serverId === effectiveHostId);
  const branchAgents = useMemo(() => config?.branchAgents ?? {}, [config?.branchAgents]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const stored = schema.safeParse(raw ? JSON.parse(raw) : {});
        if (mounted) setConfig(stored.success ? stored.data : defaults);
      } catch {
        if (mounted) setConfig(defaults);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  // Auto-pair the isolated desktop Workshop daemon when running.
  useEffect(() => {
    if (!managedWorkshop || !workshopDaemon || workshopDaemon.status !== "running") return;
    const serverId = workshopDaemon.serverId;
    if (!serverId) return;

    const runtime = getHostRuntimeStore();
    if (!runtime.getHosts().some((entry) => entry.serverId === serverId)) {
      void runtime
        .upsertConnectionFromListen({
          listenAddress: workshopDaemon.listen,
          serverId,
          hostname: WORKSHOP_NAME,
        })
        .catch(() => undefined);
    }

    const current = configRef.current;
    if (
      current &&
      (current.workshopHostId !== serverId || current.workshopCwd !== workshopDaemon.repoDir)
    ) {
      const sameHost = current.workshopHostId === serverId;
      const next: EditableWorkshopConfig = {
        ...current,
        workshopHostId: serverId,
        workshopCwd: workshopDaemon.repoDir,
        workshopAgentId: sameHost ? current.workshopAgentId : null,
      };
      setConfig(next);
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
    }
  }, [managedWorkshop, workshopDaemon]);

  // Poll all active branch agents in parallel and immediately trigger sync when any finishes.
  const trackedEntries = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of Object.values(branchAgents)) {
      map.set(entry.slug, entry.agentId);
    }
    for (const branch of branches?.branches ?? []) {
      if (branch.agentId && !map.has(branch.slug)) {
        map.set(branch.slug, branch.agentId);
      }
    }
    return Array.from(map.entries());
  }, [branchAgents, branches]);

  useEffect(() => {
    if (!effectiveHostId || !config?.enabled || !isConnected || trackedEntries.length === 0) {
      setAgentStatuses((prev) => {
        if (pendingSlugsRef.current.size === 0) return Object.keys(prev).length === 0 ? prev : {};
        const kept: Record<string, string> = {};
        for (const pendingSlug of pendingSlugsRef.current) {
          kept[pendingSlug] = prev[pendingSlug] ?? "initializing";
        }
        return kept;
      });
      return;
    }
    const client = getHostRuntimeStore().getClient(effectiveHostId);
    if (!client) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      const nextStatuses: Record<string, string> = {};
      const nextReplies: Record<string, string> = {};
      const nextTitles: Record<string, string> = {};
      const nextIcons: Record<string, string> = {};
      const nextRunning = new Set<string>();
      await Promise.all(
        trackedEntries.map(async ([slug, id]) => {
          const result = await client.fetchAgent({ agentId: id, timeout: 5000 }).catch(() => null);
          const agent = result?.agent;
          if (!agent) return;
          if (agent.status) nextStatuses[slug] = agent.status;
          if (agent.status === "initializing" || agent.status === "running") nextRunning.add(slug);
          const { title, icon, reply } = resolveAgentDisplayMeta(agent);
          maybeRepairPreambleTitle(client, id, agent);
          if (reply) nextReplies[slug] = reply;
          if (title) nextTitles[slug] = title;
          if (icon) nextIcons[slug] = icon;
          syncBranchDisplayMeta(slug, { title, icon }, syncedMetaRef.current, bridge);
        }),
      );
      if (stopped) return;
      for (const pendingSlug of pendingSlugsRef.current) {
        if (!nextStatuses[pendingSlug] || nextStatuses[pendingSlug] === "idle") {
          nextStatuses[pendingSlug] = "initializing";
        }
        nextRunning.add(pendingSlug);
      }
      setAgentStatuses(nextStatuses);
      setAgentReplies(nextReplies);
      setAgentTitles(nextTitles);
      setAgentIcons(nextIcons);

      // If any branch agent just finished its turn, mark unread reply + sync immediately.
      const newlyFinished: string[] = [];
      for (const prevSlug of prevRunningRef.current) {
        if (!nextRunning.has(prevSlug)) newlyFinished.push(prevSlug);
      }
      prevRunningRef.current = nextRunning;
      if (newlyFinished.length > 0) {
        const replied = newlyFinished.filter((slug) => Boolean(nextReplies[slug]));
        if (replied.length > 0) {
          setUnreadReplySlugs((prev) => Array.from(new Set([...prev, ...replied])));
        }
        void bridge?.syncNow?.().finally(() => void refreshDesktop?.());
      }
      timer = setTimeout(sample, 3000);
    };
    void sample();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [effectiveHostId, config?.enabled, isConnected, trackedEntries, bridge, refreshDesktop]);

  const ensureManagedWorkshopReady = useCallback(async () => {
    if (!bridge?.startWorkshopDaemon) {
      throw new Error("Workshop daemon auto-start is unavailable");
    }
    setStartingWorkshop(true);
    setWorkshopError(null);
    try {
      let current = await bridge.startWorkshopDaemon();
      const deadline = Date.now() + WORKSHOP_START_TIMEOUT_MS;
      while (current.status === "starting" && bridge.getWorkshopStatus) {
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for the Workshop daemon to start");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
        const polled = await bridge.getWorkshopStatus();
        if (polled) current = polled;
      }
      if (current.status !== "running" || !current.serverId) {
        throw new Error(current.error ?? "Workshop daemon failed to start");
      }

      const runtime = getHostRuntimeStore();
      if (!runtime.getHosts().some((entry) => entry.serverId === current.serverId)) {
        await runtime.upsertConnectionFromListen({
          listenAddress: current.listen,
          serverId: current.serverId,
          hostname: WORKSHOP_NAME,
        });
      }
      const online = await waitForHostOnline(current.serverId, WORKSHOP_CONNECT_TIMEOUT_MS);
      await refreshDesktop?.();
      if (!online) {
        throw new Error(`Workshop daemon (${current.listen}) did not connect in time`);
      }
      return { serverId: current.serverId, repoDir: current.repoDir };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkshopError(message);
      throw error;
    } finally {
      setStartingWorkshop(false);
    }
  }, [bridge, refreshDesktop]);

  const markReplyRead = useCallback((slug: string) => {
    setUnreadReplySlugs((prev) =>
      prev.includes(slug) ? prev.filter((item) => item !== slug) : prev,
    );
  }, []);

  const clearBranchAgent = useCallback(
    (slug: string, clearOptions?: { archive?: boolean }) => {
      const targetAgentId =
        configRef.current?.branchAgents?.[slug]?.agentId ??
        branches?.branches.find((b) => b.slug === slug)?.agentId ??
        null;
      if (clearOptions?.archive && targetAgentId && effectiveHostId) {
        const client = getHostRuntimeStore().getClient(effectiveHostId);
        void client?.archiveAgent(targetAgentId).catch(() => undefined);
      }
      syncedMetaRef.current.delete(slug);
      setUnreadReplySlugs((prev) => prev.filter((item) => item !== slug));
      setAgentReplies((prev) => {
        if (!(slug in prev)) return prev;
        const next = { ...prev };
        delete next[slug];
        return next;
      });
      setAgentTitles((prev) => {
        if (!(slug in prev)) return prev;
        const next = { ...prev };
        delete next[slug];
        return next;
      });
      setAgentIcons((prev) => {
        if (!(slug in prev)) return prev;
        const next = { ...prev };
        delete next[slug];
        return next;
      });
      setConfig((prev) => {
        if (!prev?.branchAgents?.[slug]) return prev;
        const nextAgents = { ...prev.branchAgents };
        delete nextAgents[slug];
        const next = { ...prev, branchAgents: nextAgents };
        void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
        return next;
      });
    },
    [branches, effectiveHostId],
  );

  async function chooseHost(serverId: string) {
    if (!config || locked.current || !hosts.some((entry) => entry.serverId === serverId)) return;
    if (config.workshopHostId === serverId) return;
    locked.current = true;
    setSaving(true);
    try {
      const next = {
        ...config,
        workshopHostId: serverId,
        workshopCwd: null,
        workshopAgentId: null,
      };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setConfig(next);
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  function recordBranchAgent(
    base: EditableWorkshopConfig,
    slug: string,
    createdAgentId: string,
    trimmedRequest: string,
  ): EditableWorkshopConfig {
    const record: EditableBranchAgentRecord = {
      slug,
      agentId: createdAgentId,
      request: trimmedRequest,
      createdAt: new Date().toISOString(),
    };
    return {
      ...base,
      workshopAgentId: createdAgentId,
      branchAgents: { ...configRef.current?.branchAgents, [slug]: record },
    };
  }

  function beginPendingBranch(slug: string, request: string) {
    pendingSlugsRef.current.add(slug);
    setPendingBranches((prev) => ({
      ...prev,
      [slug]: { slug, request, createdAt: new Date().toISOString() },
    }));
    setAgentStatuses((prev) => ({ ...prev, [slug]: prev[slug] ?? "initializing" }));
  }

  function endPendingBranch(slug: string, succeeded: boolean) {
    pendingSlugsRef.current.delete(slug);
    setPendingBranches((prev) => {
      if (!(slug in prev)) return prev;
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    if (!succeeded) {
      setAgentStatuses((prev) => {
        if (prev[slug] !== "initializing") return prev;
        const next = { ...prev };
        delete next[slug];
        return next;
      });
    }
  }

  async function send(
    locator: EditableLocatorContext,
    request: string,
    cwd: string,
    branchTarget?: {
      slug?: string | null;
      isFollowUp?: boolean;
      snapshot?: EditableElementSnapshot | null;
      extraReferences?: ReadonlyArray<Pick<EditableReferencedElement, "locator" | "snapshot">>;
      images?: EditableScreenshotAttachment[];
    },
  ) {
    if (!config || locked.current) return { kind: "busy" } as const;
    locked.current = true;
    setSending(true);
    const { slug, isFollowUp, followUpAgentId } = resolveBranchSendTarget({
      config,
      branches,
      request,
      branchTarget,
    });
    const trimmedRequest = request.trim();
    beginPendingBranch(slug, trimmedRequest);
    let sentOk = false;
    try {
      let targetHostId = host?.serverId ?? null;
      let targetCwd = cwd.trim() || null;
      let managedRepoDir: string | null = null;

      if (managedWorkshop) {
        const ready = await ensureManagedWorkshopReady();
        targetHostId = ready.serverId;
        managedRepoDir = ready.repoDir;
        targetCwd = targetCwd ?? ready.repoDir;
      }

      const worktreePath = await prepareWorktreeForSend(bridge, slug);
      void refreshDesktop?.();
      const target: EditableWorkshopConfig = {
        ...config,
        workshopHostId: targetHostId,
        workshopCwd: worktreePath ? (managedRepoDir ?? targetCwd) : targetCwd,
        workshopAgentId: followUpAgentId,
        lastRequest: trimmedRequest,
      };
      const runtime = getHostRuntimeStore();
      const result = await sendWorkshopEdit({
        target,
        locator,
        request,
        slug,
        isFollowUp,
        worktreePath,
        snapshot: branchTarget?.snapshot,
        extraReferences: branchTarget?.extraReferences,
        images: branchTarget?.images,
        getClient: (serverId) =>
          isHostRuntimeConnected(runtime.getSnapshot(serverId))
            ? runtime.getClient(serverId)
            : null,
        rememberAgent: async (createdAgentId, createdSlug) => {
          const next = recordBranchAgent(target, createdSlug, createdAgentId, trimmedRequest);
          setConfig(next);
          setAgentStatuses((prev) => ({ ...prev, [createdSlug]: "running" }));
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          void bridge?.attachBranchAgent?.(createdSlug, createdAgentId).catch(() => undefined);
        },
      });
      if (result.kind === "sent") {
        sentOk = true;
        const next = recordBranchAgent(target, result.slug, result.agentId, trimmedRequest);
        setConfig(next);
        void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
        void bridge?.attachBranchAgent?.(result.slug, result.agentId).catch(() => undefined);
        markReplyRead(result.slug);
        prevRunningRef.current.add(result.slug);
        setAgentStatuses((prev) => ({ ...prev, [result.slug]: "running" }));
        void refreshDesktop?.();
      }
      return result;
    } finally {
      endPendingBranch(slug, sentOk);
      locked.current = false;
      setSending(false);
    }
  }

  const runningSlugs = useMemo(
    () =>
      Object.entries(agentStatuses)
        .filter(([, st]) => st === "running" || st === "initializing")
        .map(([slug]) => slug),
    [agentStatuses],
  );

  return {
    config,
    hosts,
    host,
    hostId: effectiveHostId,
    agentId,
    branchAgents,
    pendingBranches,
    agentStatuses,
    agentReplies,
    agentTitles,
    agentIcons,
    unreadReplySlugs,
    runningSlugs,
    lastRequest: config?.lastRequest ?? null,
    isConnected,
    managedWorkshop,
    workshopDaemon,
    startingWorkshop,
    workshopError,
    saving,
    sending,
    editing: sending || startingWorkshop || runningSlugs.length > 0,
    chooseHost,
    startWorkshop: ensureManagedWorkshopReady,
    clearBranchAgent,
    markReplyRead,
    send,
  };
}
