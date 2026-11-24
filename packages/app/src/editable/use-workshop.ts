import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import type {
  EditableDesktopBridge,
  EditableLocatorContext,
  EditableWorkshopConfig,
  EditableWorkshopDaemonStatus,
} from "./types";
import { sendWorkshopEdit } from "./workshop-client";

const STORAGE_KEY = "paseo.editable.workshop";
const WORKSHOP_HOST_LABEL = "Editable Workshop";
const WORKSHOP_START_TIMEOUT_MS = 45_000;
const WORKSHOP_CONNECT_TIMEOUT_MS = 15_000;

const schema = z.object({
  workshopHostId: z.string().nullable().default(null),
  workshopCwd: z.string().nullable().default(null),
  workshopAgentId: z.string().nullable().default(null),
  lastRequest: z.string().nullable().optional().default(null),
  enabled: z.boolean().default(true),
});
const defaults = schema.parse({});

export interface UseWorkshopOptions {
  bridge?: EditableDesktopBridge;
  workshopDaemon?: EditableWorkshopDaemonStatus | null;
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

export function useWorkshop(options: UseWorkshopOptions = {}) {
  const { bridge, workshopDaemon = null, refreshDesktop } = options;
  const managedWorkshop = Boolean(bridge?.startWorkshopDaemon);
  const hosts = useHosts();
  const [config, setConfig] = useState<EditableWorkshopConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [startingWorkshop, setStartingWorkshop] = useState(false);
  const [workshopError, setWorkshopError] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const locked = useRef(false);
  const configRef = useRef<EditableWorkshopConfig | null>(null);
  configRef.current = config;

  const effectiveHostId =
    managedWorkshop && workshopDaemon?.serverId
      ? workshopDaemon.serverId
      : (config?.workshopHostId ?? null);
  const agentId = config?.workshopAgentId ?? null;
  const isConnected = useHostRuntimeIsConnected(effectiveHostId ?? "");
  const host = hosts.find((entry) => entry.serverId === effectiveHostId);

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

  // When the dedicated desktop Workshop daemon is running, ensure it is paired and selected.
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

  useEffect(() => {
    if (!effectiveHostId || !agentId || !config?.enabled || !isConnected) {
      setActiveAgentId(null);
      setAgentStatus(null);
      return;
    }
    const client = getHostRuntimeStore().getClient(effectiveHostId);
    if (!client) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      const result = await client.fetchAgent({ agentId, timeout: 5000 }).catch(() => null);
      if (stopped) return;
      const status = result?.agent.status ?? null;
      setAgentStatus(status);
      setActiveAgentId(status === "initializing" || status === "running" ? agentId : null);
      timer = setTimeout(sample, 3000);
    };
    void sample();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [effectiveHostId, agentId, config?.enabled, isConnected]);

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

  async function send(locator: EditableLocatorContext, request: string, cwd: string) {
    if (!config || locked.current) return { kind: "busy" } as const;
    locked.current = true;
    setSending(true);
    try {
      let targetHostId = host?.serverId ?? null;
      let targetCwd = cwd.trim() || null;
      let targetAgentId = targetCwd === config.workshopCwd ? config.workshopAgentId : null;

      if (managedWorkshop) {
        const ready = await ensureManagedWorkshopReady();
        const sameHost = config.workshopHostId === ready.serverId;
        targetHostId = ready.serverId;
        targetCwd = targetCwd ?? ready.repoDir;
        targetAgentId =
          sameHost && targetCwd === config.workshopCwd ? config.workshopAgentId : null;
      }

      const trimmedRequest = request.trim();
      const target: EditableWorkshopConfig = {
        ...config,
        workshopHostId: targetHostId,
        workshopCwd: targetCwd,
        workshopAgentId: targetAgentId,
        lastRequest: trimmedRequest,
      };
      const runtime = getHostRuntimeStore();
      const result = await sendWorkshopEdit({
        target,
        locator,
        request,
        getClient: (serverId) =>
          isHostRuntimeConnected(runtime.getSnapshot(serverId))
            ? runtime.getClient(serverId)
            : null,
        rememberAgent: async (workshopAgentId) => {
          const next = { ...target, workshopAgentId };
          setConfig(next);
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        },
      });
      if (result.kind === "sent") {
        const next = { ...target, workshopAgentId: result.agentId };
        setConfig(next);
        void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
        setActiveAgentId(result.agentId);
        setAgentStatus("running");
      }
      return result;
    } finally {
      locked.current = false;
      setSending(false);
    }
  }

  return {
    config,
    hosts,
    host,
    hostId: effectiveHostId,
    agentId,
    agentStatus,
    lastRequest: config?.lastRequest ?? null,
    isConnected,
    managedWorkshop,
    workshopDaemon,
    startingWorkshop,
    workshopError,
    saving,
    sending,
    editing: sending || startingWorkshop || (isConnected && !!agentId && activeAgentId === agentId),
    chooseHost,
    startWorkshop: ensureManagedWorkshopReady,
    send,
  };
}
