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
  EditableLocatorContext,
  EditableWorkshopConfig,
  EditableWorkshopDaemonStatus,
} from "./types";
import { sendWorkshopEdit, slugifyEditRequest } from "./workshop-client";

const STORAGE_KEY = "paseo.editable.workshop";
const WORKSHOP_HOST_LABEL = "Editable Workshop";
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
  summary: string,
): Promise<string | null> {
  if (!bridge?.createBranch) return null;
  const created = await bridge.createBranch({ slug, summary: summary.slice(0, 120) });
  if (!created.ok) {
    throw new Error(created.error ?? `Failed to create worktree ${slug}`);
  }
  return created.worktreePath ?? null;
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
  const [unreadReplySlugs, setUnreadReplySlugs] = useState<string[]>([]);
  const locked = useRef(false);
  const prevRunningRef = useRef<Set<string>>(new Set());
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
          hostname: WORKSHOP_HOST_LABEL,
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
      setAgentStatuses({});
      return;
    }
    const client = getHostRuntimeStore().getClient(effectiveHostId);
    if (!client) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      const nextStatuses: Record<string, string> = {};
      const nextReplies: Record<string, string> = {};
      const nextRunning = new Set<string>();
      await Promise.all(
        trackedEntries.map(async ([slug, id]) => {
          const result = await client.fetchAgent({ agentId: id, timeout: 5000 }).catch(() => null);
          const status = result?.agent.status;
          if (status) nextStatuses[slug] = status;
          if (status === "initializing" || status === "running") nextRunning.add(slug);
          const reply = result?.agent.responseMetadata?.lastTurn?.message?.trim();
          if (reply) nextReplies[slug] = reply;
        }),
      );
      if (stopped) return;
      setAgentStatuses(nextStatuses);
      setAgentReplies(nextReplies);

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
          hostname: WORKSHOP_HOST_LABEL,
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
      setUnreadReplySlugs((prev) => prev.filter((item) => item !== slug));
      setAgentReplies((prev) => {
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

  async function send(
    locator: EditableLocatorContext,
    request: string,
    cwd: string,
    branchTarget?: { slug?: string | null; isFollowUp?: boolean },
  ) {
    if (!config || locked.current) return { kind: "busy" } as const;
    locked.current = true;
    setSending(true);
    try {
      let targetHostId = host?.serverId ?? null;
      let targetCwd = cwd.trim() || null;

      if (managedWorkshop) {
        const ready = await ensureManagedWorkshopReady();
        targetHostId = ready.serverId;
        targetCwd = targetCwd ?? ready.repoDir;
      }

      const { slug, isFollowUp, followUpAgentId } = resolveBranchSendTarget({
        config,
        branches,
        request,
        branchTarget,
      });

      const trimmedRequest = request.trim();
      const worktreePath = await prepareWorktreeForSend(bridge, slug, trimmedRequest);
      const target: EditableWorkshopConfig = {
        ...config,
        workshopHostId: targetHostId,
        workshopCwd: worktreePath ?? targetCwd,
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
        getClient: (serverId) =>
          isHostRuntimeConnected(runtime.getSnapshot(serverId))
            ? runtime.getClient(serverId)
            : null,
        rememberAgent: async (createdAgentId, createdSlug) => {
          const next = recordBranchAgent(target, createdSlug, createdAgentId, trimmedRequest);
          setConfig(next);
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          void bridge?.attachBranchAgent?.(createdSlug, createdAgentId).catch(() => undefined);
        },
      });
      if (result.kind === "sent") {
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
    agentStatuses,
    agentReplies,
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
