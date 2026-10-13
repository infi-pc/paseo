import { randomUUID } from "node:crypto";
import type { ProviderActivityRecord } from "@getpaseo/protocol/provider-activity";
import type { AgentTimelineItem } from "../agent-sdk-types.js";

const MAX_PAYLOAD = 16_384;
const MAX_TOTAL = 65_536;
const MAX_RECORDS = 80;
const SECRET_KEY =
  /^(authorization|proxy.authorization|cookie|set.cookie|.*password|.*secret|.*api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|env|environment|headers)$/i;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface CaptureBudget {
  remaining: number;
  truncated: boolean;
}

function sanitize(value: unknown, budget: CaptureBudget, depth = 0): unknown {
  if (depth > 12 || budget.remaining <= 0) {
    budget.truncated = true;
    return "[capture limit]";
  }
  if (typeof value === "string") {
    const redacted = value
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{20,})\b/g, "[redacted]");
    const clipped = redacted.slice(0, budget.remaining);
    budget.remaining -= clipped.length;
    budget.truncated ||= clipped.length < redacted.length;
    return clipped;
  }
  if (Array.isArray(value)) {
    budget.truncated ||= value.length > 100;
    return value.slice(0, 100).map((entry) => sanitize(entry, budget, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;
  const isMedia = "type" in value && ["image", "audio", "base64"].includes(String(value.type));
  const entries = Object.entries(value);
  budget.truncated ||= entries.length > 100;
  return Object.fromEntries(
    entries.slice(0, 100).map(([key, entry]) => {
      if (SECRET_KEY.test(key)) return [key, "[redacted]"];
      if (key === "data" && typeof entry === "string" && (isMedia || entry.length > 1024)) {
        budget.truncated = true;
        return [key, "[binary or large data omitted]"];
      }
      budget.remaining -= key.length;
      return [key, sanitize(entry, budget, depth + 1)];
    }),
  );
}

interface EventDescription {
  summary: string;
  level: ProviderActivityRecord["level"];
  callId?: string;
}

function describeReview(
  review: Record<string, unknown>,
  callId: string | undefined,
): EventDescription {
  const status = text(review.status) ?? "inProgress";
  const labels: Record<string, string> = {
    inProgress: "Reviewing permission",
    approved: "Auto-review approved",
    denied: "Blocked by auto-review",
    timedOut: "Auto-review timed out",
    aborted: "Auto-review aborted",
  };
  const rationale = text(review.rationale);
  const label = labels[status] ?? status;
  return {
    summary: rationale ? `${label}: ${rationale}` : label,
    level: status === "denied" || status === "timedOut" ? "warning" : "info",
    callId,
  };
}

function toolCallId(value: Record<string, unknown>): string | undefined {
  return (
    text(value.targetItemId) ??
    text(value.tool_use_id) ??
    text(value.itemId) ??
    text(record(value.item).id) ??
    text(record(value.msg).call_id)
  );
}

function describe(event: string, value: Record<string, unknown>): EventDescription {
  const review = record(value.review);
  const callId = toolCallId(value);
  if (event.includes("ApprovalReview/")) return describeReview(review, callId);
  if (event === "system/permission_denied") {
    const reason = text(value.decision_reason) ?? text(value.message);
    return { summary: `Permission denied${reason ? `: ${reason}` : ""}`, level: "warning", callId };
  }
  if (event === "rate_limit_event") {
    const limit = record(value.rate_limit_info);
    return {
      summary: `Rate limit: ${text(limit.status) ?? "updated"}`,
      level: limit.status === "allowed" ? "info" : "warning",
    };
  }
  if (event === "tool_use_summary") {
    return { summary: text(value.summary) ?? "Tool summary", level: "info", callId };
  }
  if (event === "tool_progress") {
    return {
      summary: `${text(value.tool_name) ?? "Tool"} running (${value.elapsed_time_seconds ?? 0}s)`,
      level: "info",
      callId,
    };
  }
  if (event === "turn/diff/updated" || event === "codex/event/turn_diff") {
    return { summary: "Changes tracked during this turn", level: "info" };
  }
  return { summary: event, level: "info", callId };
}

/** One bounded, immutable inspector snapshot per turn; streaming content stays in its existing rows. */
export class ProviderActivityCapture {
  private group: string | undefined;
  private id = randomUUID();
  private records: ProviderActivityRecord[] = [];
  private omitted = 0;

  capture(
    provider: string,
    group: string,
    event: string,
    payload: unknown,
  ): AgentTimelineItem | null {
    if (event === "stream_event" || /(?:delta|outputDelta)$/i.test(event)) return null;
    if (this.group !== group) {
      this.group = group;
      this.id = randomUUID();
      this.records = [];
      this.omitted = 0;
    }
    const value = record(payload);
    const description = describe(event, value);
    const budget = { remaining: MAX_PAYLOAD, truncated: false };
    const safeDescription = sanitize(description.summary, { remaining: 500, truncated: false });
    const serialized = JSON.stringify(sanitize(payload, budget), null, 2) ?? "null";
    const truncated = budget.truncated || serialized.length > MAX_PAYLOAD;
    const previous = this.records.at(-1);
    if (previous?.event === event && previous.payload === serialized.slice(0, MAX_PAYLOAD))
      return null;
    const entry: ProviderActivityRecord = {
      id: randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      ...description,
      summary: typeof safeDescription === "string" ? safeDescription.slice(0, 500) : event,
      payload: serialized.slice(0, MAX_PAYLOAD),
      truncated,
      ...(typeof value.diff === "string" ? { diff: value.diff.slice(0, MAX_PAYLOAD) } : {}),
    };
    this.records = [...this.records, entry];
    while (this.records.length > MAX_RECORDS || this.size() > MAX_TOTAL) {
      this.records.shift();
      this.omitted += 1;
    }
    const warning = this.records.findLast((candidate) => candidate.level !== "info");
    return {
      type: "notification",
      level: warning?.level ?? "info",
      message: warning?.summary ?? "Agent activity",
      activity: { id: this.id, provider, records: this.records, omitted: this.omitted },
    };
  }

  private size(): number {
    return this.records.reduce(
      (total, entry) =>
        total + entry.payload.length + entry.summary.length + (entry.diff?.length ?? 0),
      0,
    );
  }
}
