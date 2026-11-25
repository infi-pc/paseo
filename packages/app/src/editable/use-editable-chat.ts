import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPermissionRequest, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  applyStreamEvent,
  createUserMessage,
  generateMessageId,
  hydrateStreamState,
  type StreamItem,
  type ToolCallItem,
} from "@/types/stream";

export interface ParsedWorkshopUserMessage {
  text: string;
  locatorLabel: string | null;
}

function formatLocatorFromJson(rawJson: string): string | null {
  try {
    const parsed = JSON.parse(rawJson) as {
      componentName?: unknown;
      file?: unknown;
      line?: unknown;
    };
    const file = typeof parsed.file === "string" ? parsed.file.split("/").pop() : null;
    const comp = typeof parsed.componentName === "string" ? parsed.componentName : null;
    const line = typeof parsed.line === "number" ? `:${parsed.line}` : "";
    if (comp && file) return `${comp} · ${file}${line}`;
    if (file) return `${file}${line}`;
    return comp;
  } catch {
    return null;
  }
}

/**
 * Strips the internal Editable Paseo Workshop instruction wrapper when rendering
 * user bubbles in the popover chat, exposing the user's actual message and a
 * compact locator badge.
 */
export function parseWorkshopUserMessage(raw: string): ParsedWorkshopUserMessage {
  const marker = "\nLocator context:\n";
  const markerIdx = raw.indexOf(marker);
  if (markerIdx < 0) return { text: raw, locatorLabel: null };

  const afterLocator = raw.slice(markerIdx + marker.length);
  const msgMatch = /\n\n(?:User message|Edit request):\n([\s\S]*)$/.exec(afterLocator);
  if (!msgMatch) return { text: raw, locatorLabel: null };

  const jsonPart = afterLocator.slice(0, msgMatch.index).trim();
  const userText = (msgMatch[1] ?? "").trim();
  return {
    text: userText || raw,
    locatorLabel: formatLocatorFromJson(jsonPart),
  };
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.pop() || filePath;
}

function describeToolDetail(
  detail: ToolCallDetail,
  fallbackName: string,
): {
  title: string;
  body: string | null;
} {
  switch (detail.type) {
    case "shell":
      return {
        title: detail.command.trim().slice(0, 72) || "shell",
        body: [detail.command, detail.output].filter(Boolean).join("\n\n") || null,
      };
    case "read":
      return { title: `read ${basename(detail.filePath)}`, body: detail.filePath };
    case "edit":
      return { title: `edit ${basename(detail.filePath)}`, body: detail.filePath };
    case "write":
      return { title: `write ${basename(detail.filePath)}`, body: detail.filePath };
    case "search":
      return { title: `search ${detail.query.slice(0, 48)}`, body: detail.query };
    case "worktree_setup":
      return { title: detail.branchName || "worktree setup", body: detail.worktreePath };
    default:
      return { title: fallbackName, body: null };
  }
}

export function summarizeToolCall(item: ToolCallItem): {
  title: string;
  status: string;
  body: string | null;
} {
  if (item.payload.source === "orchestrator") {
    const { toolName, status, error } = item.payload.data;
    return {
      title: toolName,
      status,
      body: error ? String(error) : null,
    };
  }
  const { name, status, detail, error } = item.payload.data;
  const described = describeToolDetail(detail, name);
  const errorText = error ? `\nError: ${String(error)}` : "";
  return {
    title: described.title,
    status,
    body: described.body ? `${described.body}${errorText}` : errorText.trim() || null,
  };
}

function deriveStatusFromEvent(
  current: string,
  event: AgentStreamEventPayload,
): { nextStatus: string; turnFinished: boolean } {
  if (event.type === "turn_started") return { nextStatus: "running", turnFinished: false };
  if (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  ) {
    return { nextStatus: "idle", turnFinished: true };
  }
  return { nextStatus: current, turnFinished: false };
}

async function hydrateAgentTimeline(client: DaemonClient, agentId: string) {
  const page = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 120,
    projection: "projected",
  });
  const items = hydrateStreamState(
    page.entries.map((entry) => ({
      event: {
        type: "timeline" as const,
        provider: entry.provider,
        item: entry.item,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
      },
      timestamp: new Date(entry.timestamp),
      timelineCursor: { epoch: page.epoch, seq: entry.seqEnd },
    })),
    { source: "canonical" },
  );
  return {
    items,
    status: page.agent?.status ?? "idle",
    pendingPermissions: page.agent?.pendingPermissions ?? [],
  };
}

function upsertPermission(
  prev: AgentPermissionRequest[],
  request: AgentPermissionRequest,
): AgentPermissionRequest[] {
  return prev.some((entry) => entry.id === request.id) ? prev : [...prev, request];
}

function removePermission(
  prev: AgentPermissionRequest[],
  requestId: string,
): AgentPermissionRequest[] {
  return prev.filter((entry) => entry.id !== requestId);
}

export interface UseEditableChatOptions {
  serverId: string | null | undefined;
  agentId: string | null | undefined;
  onTurnFinished?: () => void;
}

export function useEditableChat({ serverId, agentId, onTurnFinished }: UseEditableChatOptions) {
  const [tail, setTail] = useState<StreamItem[]>([]);
  const [head, setHead] = useState<StreamItem[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const [pendingPermissions, setPendingPermissions] = useState<AgentPermissionRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<{ tail: StreamItem[]; head: StreamItem[] }>({ tail: [], head: [] });
  const statusRef = useRef(status);
  statusRef.current = status;
  const onTurnFinishedRef = useRef(onTurnFinished);
  onTurnFinishedRef.current = onTurnFinished;

  const commitStream = useCallback((nextTail: StreamItem[], nextHead: StreamItem[]) => {
    streamRef.current = { tail: nextTail, head: nextHead };
    setTail(nextTail);
    setHead(nextHead);
  }, []);

  useEffect(() => {
    if (!serverId || !agentId) {
      commitStream([], []);
      setStatus("idle");
      setPendingPermissions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      setError("Workshop host is offline.");
      return;
    }

    let disposed = false;
    setLoading(true);
    setError(null);

    const loadHistory = async () => {
      try {
        const hydrated = await hydrateAgentTimeline(client, agentId);
        if (disposed) return;
        commitStream(hydrated.items, []);
        setStatus(hydrated.status);
        setPendingPermissions(hydrated.pendingPermissions);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : "Could not load Workshop chat.");
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void loadHistory();

    const sub = client.subscribeAgentTimeline(agentId, (message) => {
      if (disposed) return;
      if (
        message.type === "agent.timeline.replacement" ||
        message.type === "agent.timeline.subscription_restored"
      ) {
        void loadHistory();
        return;
      }
      if (message.type === "agent.timeline.error") {
        setError(message.payload.error);
        return;
      }
      if (message.type !== "agent_stream" || message.payload.agentId !== agentId) return;

      const { event, timestamp, epoch, seq } = message.payload;
      const result = applyStreamEvent({
        tail: streamRef.current.tail,
        head: streamRef.current.head,
        event,
        timestamp: new Date(timestamp),
        timelineCursor: epoch && seq !== undefined ? { epoch, seq } : undefined,
      });
      if (result.changedTail || result.changedHead) {
        commitStream(result.tail, result.head);
      }

      const { nextStatus, turnFinished } = deriveStatusFromEvent(statusRef.current, event);
      if (nextStatus !== statusRef.current) setStatus(nextStatus);
      if (turnFinished) onTurnFinishedRef.current?.();
    });

    const unsubPermReq = client.on("agent_permission_request", (msg) => {
      if (disposed || msg.payload.agentId !== agentId) return;
      setPendingPermissions((prev) => upsertPermission(prev, msg.payload.request));
    });

    const unsubPermRes = client.on("agent_permission_resolved", (msg) => {
      if (disposed || msg.payload.agentId !== agentId) return;
      setPendingPermissions((prev) => removePermission(prev, msg.payload.requestId));
    });

    const unsubStatus = client.on("agent_status", (msg) => {
      if (disposed || msg.payload.agentId !== agentId) return;
      const prevStatus = statusRef.current;
      const next = msg.payload.status;
      setStatus(next);
      if ((prevStatus === "running" || prevStatus === "initializing") && next === "idle") {
        onTurnFinishedRef.current?.();
      }
    });

    return () => {
      disposed = true;
      sub();
      unsubPermReq();
      unsubPermRes();
      unsubStatus();
    };
  }, [serverId, agentId, commitStream]);

  const sendFollowUp = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !serverId || !agentId) return;
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        setError("Workshop host is offline.");
        return;
      }
      setSendingFollowUp(true);
      setError(null);
      const clientMessageId = generateMessageId();
      const optimistic = createUserMessage({
        id: clientMessageId,
        clientMessageId,
        text: trimmed,
        timestamp: new Date(),
      });
      commitStream([...streamRef.current.tail, ...streamRef.current.head, optimistic], []);
      setStatus("running");
      try {
        await client.sendAgentMessage(agentId, trimmed, { messageId: clientMessageId });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not send message.");
        setStatus("idle");
      } finally {
        setSendingFollowUp(false);
      }
    },
    [serverId, agentId, commitStream],
  );

  const cancel = useCallback(async () => {
    if (!serverId || !agentId) return;
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) return;
    try {
      await client.cancelAgent(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop agent.");
    }
  }, [serverId, agentId]);

  const respondPermission = useCallback(
    async (requestId: string, behavior: "allow" | "deny") => {
      if (!serverId || !agentId) return;
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) return;
      try {
        await client.respondToPermission(
          agentId,
          requestId,
          behavior === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Denied from Editable Paseo popover" },
        );
        setPendingPermissions((prev) => prev.filter((entry) => entry.id !== requestId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not respond to permission.");
      }
    },
    [serverId, agentId],
  );

  const items = useMemo(() => [...tail, ...head], [tail, head]);
  const isRunning = status === "running" || status === "initializing";

  return {
    items,
    status,
    isRunning,
    pendingPermissions,
    loading,
    sendingFollowUp,
    error,
    sendFollowUp,
    cancel,
    respondPermission,
  };
}
