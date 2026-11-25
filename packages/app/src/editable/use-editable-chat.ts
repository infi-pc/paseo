import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPermissionRequest, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import {
  parseResponseFooter,
  responseDisplayText,
  type ResponseFooterMetadata,
} from "@getpaseo/protocol/response-control/footer";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { continuesResponse, continuesTurn } from "@/agent-stream/turn-membership";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  applyStreamEvent,
  createUserMessage,
  generateMessageId,
  hydrateStreamState,
  type StreamItem,
  type ToolCallItem,
} from "@/types/stream";
import type { EditableReferencedElement } from "./types";
import { buildWorkshopFollowUpPrompt } from "./workshop-client";

export interface ParsedWorkshopUserMessage {
  text: string;
  locatorLabel: string | null;
  locatorLabels: string[];
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

function extractLocatorLabels(segment: string): string[] {
  const labels: string[] = [];
  const locatorMarker = "Locator context:\n";
  let cursor = 0;
  while (cursor < segment.length) {
    const start = segment.indexOf(locatorMarker, cursor);
    if (start < 0) break;
    const bodyStart = start + locatorMarker.length;
    const nextSnapshot = segment.indexOf("\n\nElement snapshot:\n", bodyStart);
    const nextLocator = segment.indexOf("\n\nLocator context:\n", bodyStart);
    let end = segment.length;
    if (nextSnapshot >= 0 && nextSnapshot < end) end = nextSnapshot;
    if (nextLocator >= 0 && nextLocator < end) end = nextLocator;
    const label = formatLocatorFromJson(segment.slice(bodyStart, end).trim());
    if (label) labels.push(label);
    cursor = end;
  }
  return labels;
}

/**
 * Strips the internal Editable Paseo Workshop instruction or element-reference wrapper
 * when rendering user bubbles in the popover chat, exposing the user's actual message
 * and compact locator badge(s).
 */
export function parseWorkshopUserMessage(raw: string): ParsedWorkshopUserMessage {
  const marker = "\nLocator context:\n";
  const markerIdx = raw.indexOf(marker);
  if (markerIdx < 0) return { text: raw, locatorLabel: null, locatorLabels: [] };

  const afterLocator = raw.slice(markerIdx + 1);
  const msgMatch = /\n\n(?:User message|Edit request):\n([\s\S]*)$/.exec(afterLocator);
  if (!msgMatch) return { text: raw, locatorLabel: null, locatorLabels: [] };

  const beforeMsg = afterLocator.slice(0, msgMatch.index);
  const locatorLabels = extractLocatorLabels(beforeMsg);
  const userText = (msgMatch[1] ?? "").trim();
  return {
    text: userText || raw,
    locatorLabel: locatorLabels[0] ?? null,
    locatorLabels,
  };
}

/**
 * Matches main Paseo's `layout.ts` rule: only the final response item of a turn
 * strips `<paseo-meta ... />`, and while the turn is actively streaming, partial
 * `<paseo-meta` prefixes at the end are withheld until complete or turn end.
 */
export function getAssistantDisplayText(
  items: readonly StreamItem[],
  index: number,
  isRunning: boolean,
): string {
  const item = items[index];
  if (!item || item.kind !== "assistant_message") return "";
  const belowItem = items[index + 1] ?? null;
  const isFinalResponse = belowItem === null || !continuesTurn(item, belowItem);
  if (!isFinalResponse) return item.text;
  const streaming = isRunning && belowItem === null;
  return responseDisplayText(item.text, streaming);
}

/**
 * Matches main Paseo's `resolveAuxiliaryTurnFooter` + `TurnFooter`: returns
 * deduplicated recommended prompts only for the latest completed assistant turn.
 */
export function getLatestRecommendedPrompts(
  items: readonly StreamItem[],
  isRunning: boolean,
): string[] {
  if (isRunning || items.length === 0) return [];
  let laterItem: StreamItem | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || (laterItem && !continuesResponse(item, laterItem))) return [];
    if (item.kind === "assistant_message") {
      const prompts = parseResponseFooter(item.text)?.metadata.prompts ?? [];
      return Array.from(new Set(prompts));
    }
    laterItem = item;
  }
  return [];
}

function parseFinalTurnMetaAt(
  items: readonly StreamItem[],
  index: number,
): ResponseFooterMetadata | null {
  const item = items[index];
  if (!item || item.kind !== "assistant_message") return null;
  const belowItem = items[index + 1] ?? null;
  if (belowItem !== null && continuesTurn(item, belowItem)) return null;
  return parseResponseFooter(item.text)?.metadata ?? null;
}

/** Extracts the latest response-control metadata (title/icon/message) emitted in the thread. */
export function getLatestResponseMeta(items: readonly StreamItem[]): ResponseFooterMetadata | null {
  let latest: ResponseFooterMetadata | null = null;
  let title: string | undefined;
  let icon: string | undefined;

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const parsed = parseFinalTurnMetaAt(items, i);
    if (!parsed) continue;
    latest ??= parsed;
    title ??= parsed.title;
    icon ??= parsed.icon;
    if (title && icon) break;
  }

  if (!latest) return null;
  return {
    message: latest.message,
    ...(title ? { title } : {}),
    ...(icon ? { icon } : {}),
    ...(latest.prompts ? { prompts: latest.prompts } : {}),
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
    async (text: string, options?: { references?: ReadonlyArray<EditableReferencedElement> }) => {
      const trimmed = text.trim();
      if (!trimmed || !serverId || !agentId) return;
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        setError("Workshop host is offline.");
        return;
      }
      const references = options?.references ?? [];
      const payloadText =
        references.length > 0 ? buildWorkshopFollowUpPrompt(trimmed, references) : trimmed;
      const images = references
        .map((ref) => ref.screenshot)
        .filter((img): img is NonNullable<typeof img> => Boolean(img));

      setSendingFollowUp(true);
      setError(null);
      const clientMessageId = generateMessageId();
      const optimistic = createUserMessage({
        id: clientMessageId,
        clientMessageId,
        text: payloadText,
        timestamp: new Date(),
      });
      commitStream([...streamRef.current.tail, ...streamRef.current.head, optimistic], []);
      setStatus("running");
      try {
        await client.sendAgentMessage(agentId, payloadText, {
          messageId: clientMessageId,
          ...(images.length > 0 ? { images } : {}),
        });
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
