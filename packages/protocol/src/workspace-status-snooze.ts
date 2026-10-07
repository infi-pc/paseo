import { z } from "zod";
import { WorkspaceSnoozeSchema } from "./workspace-snooze.js";

export const StatusWatchTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    url: z.string().url(),
    field: z.enum(["state", "review"]),
  }),
  z.object({ kind: z.literal("linear"), issueId: z.string().uuid() }),
]);
export const StatusWatchSnapshotSchema = z.object({
  target: StatusWatchTargetSchema,
  label: z.string(),
  value: z.string(),
  valueLabel: z.string(),
  capturedAt: z.string().datetime(),
});
export const StatusSnoozeInputSchema = z.object({
  mode: z.literal("status"),
  intervalMinutes: z.union([z.literal(5), z.literal(60)]),
  targets: z.array(StatusWatchTargetSchema).min(1).max(50),
});
export const StatusSnoozeSchema = WorkspaceSnoozeSchema.extend({
  config: StatusSnoozeInputSchema,
  baseline: z.array(StatusWatchSnapshotSchema).min(1).max(50),
});
export const AnyWorkspaceSnoozeSchema = z.union([WorkspaceSnoozeSchema, StatusSnoozeSchema]);
export type StatusWatchTarget = z.infer<typeof StatusWatchTargetSchema>;
export type StatusWatchSnapshot = z.infer<typeof StatusWatchSnapshotSchema>;
export type StatusSnoozeInput = z.infer<typeof StatusSnoozeInputSchema>;
export type StatusSnooze = z.infer<typeof StatusSnoozeSchema>;
export type AnyWorkspaceSnooze = z.infer<typeof AnyWorkspaceSnoozeSchema>;

export function isStatusSnooze(
  snooze: AnyWorkspaceSnooze | null | undefined,
): snooze is StatusSnooze {
  return snooze?.config.mode === "status";
}

export const StatusSnoozeDiscoverRequestSchema = z.object({
  type: z.literal("workspace.snooze.status.discover.request"),
  requestId: z.string(),
  workspaceId: z.string(),
});
export const StatusSnoozeDiscoverResponseSchema = z.object({
  type: z.literal("workspace.snooze.status.discover.response"),
  payload: z.object({
    requestId: z.string(),
    candidates: z.array(StatusWatchSnapshotSchema),
    errors: z.array(z.string()),
    autoArchiveAfterMerge: z.boolean(),
  }),
});
export const StatusSnoozeSetRequestSchema = z.object({
  type: z.literal("workspace.snooze.status.set.request"),
  requestId: z.string(),
  workspaceId: z.string(),
  snooze: StatusSnoozeInputSchema,
});
export const StatusSnoozeSetResponseSchema = z.object({
  type: z.literal("workspace.snooze.status.set.response"),
  payload: z.object({
    requestId: z.string(),
    workspaceId: z.string(),
    success: z.boolean(),
    error: z.string().nullable(),
  }),
});

export function statusWatchKey(target: StatusWatchTarget): string {
  return target.kind === "github"
    ? `github:${target.url}:${target.field}`
    : `linear:${target.issueId}`;
}

// COMPAT(statusSnoozing): added in v0.11, remove legacy projection after 2027-04-06.
// Old clients cannot parse a third config.mode; expose it only in a new optional field.
export function workspaceSnoozePayload(snooze: AnyWorkspaceSnooze | null | undefined) {
  if (isStatusSnooze(snooze)) return { snooze: null, statusSnooze: snooze };
  return {
    snooze: snooze ?? null,
    statusSnooze: null,
  };
}
