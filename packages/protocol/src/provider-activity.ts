import { z } from "zod";

// FORK(provider-activity): retained harness evidence is additive to the existing notification.
export const ProviderActivityRecordSchema = z.object({
  id: z.string(),
  event: z.string(),
  timestamp: z.string(),
  summary: z.string(),
  level: z.enum(["info", "warning", "error"]),
  callId: z.string().optional(),
  payload: z.string(),
  diff: z.string().optional(),
  truncated: z.boolean(),
});

export const ProviderActivitySchema = z.object({
  id: z.string(),
  provider: z.string(),
  records: z.array(ProviderActivityRecordSchema),
  omitted: z.number(),
});

export type ProviderActivityRecord = z.infer<typeof ProviderActivityRecordSchema>;
export type ProviderActivity = z.infer<typeof ProviderActivitySchema>;
