import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import type { EditableLocatorContext, EditableWorkshopConfig } from "./types";
import { sendWorkshopEdit } from "./workshop-client";

const STORAGE_KEY = "paseo.editable.workshop";
const schema = z.object({
  workshopHostId: z.string().nullable().default(null),
  workshopCwd: z.string().nullable().default(null),
  workshopAgentId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
const defaults = schema.parse({});

export function useWorkshop() {
  const hosts = useHosts();
  const [config, setConfig] = useState<EditableWorkshopConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const locked = useRef(false);
  const hostId = config?.workshopHostId;
  const agentId = config?.workshopAgentId;
  const isConnected = useHostRuntimeIsConnected(hostId ?? "");
  const host = hosts.find((entry) => entry.serverId === hostId);

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

  useEffect(() => {
    if (!hostId || !agentId || !config?.enabled || !isConnected) return;
    const client = getHostRuntimeStore().getClient(hostId);
    if (!client) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      const result = await client.fetchAgent({ agentId, timeout: 5000 }).catch(() => null);
      if (stopped) return;
      const status = result?.agent.status;
      setActiveAgentId(status === "initializing" || status === "running" ? agentId : null);
      timer = setTimeout(sample, 5000);
    };
    void sample();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostId, agentId, config?.enabled, isConnected]);

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
      const workshopCwd = cwd.trim() || null;
      const target = {
        ...config,
        workshopHostId: host?.serverId ?? null,
        workshopCwd,
        workshopAgentId: workshopCwd === config.workshopCwd ? config.workshopAgentId : null,
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
      if (result.kind === "sent") setActiveAgentId(result.agentId);
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
    saving,
    sending,
    editing: sending || (isConnected && !!agentId && activeAgentId === agentId),
    chooseHost,
    send,
  };
}
