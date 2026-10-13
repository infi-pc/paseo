import type { StatusSnoozeInput } from "@getpaseo/protocol/workspace-status-snooze";
import { expect, test } from "vitest";
import type { WorkspaceSnoozeInput } from "@getpaseo/protocol/workspace-snooze";
import { calendarDays, customDate, dateText, openSnoozeForm, presetDate } from "./form-model";
import { selectSnoozableGroup } from "./sidebar";

const now = new Date(2026, 9, 5, 12, 30);
test("relative presets measure elapsed time while calendar presets use the next local morning", () => {
  expect(presetDate("hour", now).getTime() - now.getTime()).toBe(3_600_000);
  expect(presetDate("day", now).getTime() - now.getTime()).toBe(86_400_000);
  expect(presetDate("tomorrow", now)).toEqual(new Date(2026, 9, 6, 9));
  expect(presetDate("monday", now)).toEqual(new Date(2026, 9, 12, 9));
  expect(customDate("2026-02-30", "09:00")).toBeNull();
  expect(customDate("2026-10-12", "25:00")).toBeNull();
  expect(customDate("2026-10-12", "09:30")).toEqual(new Date(2026, 9, 12, 9, 30));
  expect(calendarDays(new Date(2026, 9, 1)).slice(0, 5)).toEqual([
    null,
    null,
    null,
    "2026-10-01",
    "2026-10-02",
  ]);
});
test("failed save keeps edits and can be retried, and a fresh open seeds the saved snooze", async () => {
  const saved: Array<WorkspaceSnoozeInput | StatusSnoozeInput | null> = [];
  let fail = true;
  let closed = 0;
  const model = openSnoozeForm({
    snooze: null,
    timezone: "UTC",
    now: () => now,
    save: async (input) => {
      if (fail) throw new Error("Host disconnected");
      saved.push(input);
    },
    check: async () => {},
    saved: () => {
      closed++;
    },
  });
  model.setMode("ai");
  model.setPrompt("Wait until CI passes");
  model.setInterval(24);
  await model.submit();
  expect(model.getState()).toMatchObject({
    prompt: "Wait until CI passes",
    pending: false,
    error: "Host disconnected",
  });
  expect(closed).toBe(0);
  fail = false;
  await model.submit();
  expect(saved).toEqual([{ mode: "ai", prompt: "Wait until CI passes", intervalHours: 24 }]);
  expect(closed).toBe(1);
  const edit = openSnoozeForm({
    snooze: {
      id: "snooze",
      createdAt: now.toISOString(),
      nextCheckAt: now.toISOString(),
      lastCheck: null,
      config: {
        mode: "time",
        wakeAt: new Date(2026, 9, 20, 15, 45).toISOString(),
        timezone: "UTC",
      },
    },
    timezone: "UTC",
    now: () => now,
    save: async () => {},
    check: async () => {},
    saved: () => {},
  });
  expect(edit.getState()).toMatchObject({
    mode: "time",
    preset: "custom",
    date: "2026-10-20",
    time: "15:45",
    prompt: "",
  });
});
test("past custom dates produce a visible validation error without saving", async () => {
  let calls = 0;
  const model = openSnoozeForm({
    snooze: null,
    timezone: "UTC",
    now: () => now,
    save: async () => {
      calls++;
    },
    check: async () => {},
    saved: () => {},
  });
  model.setPreset("custom");
  model.setDate(dateText(now));
  model.setTime("01:00");
  await model.submit();
  expect(model.getState().error).toBe("Choose a valid future date and time");
  expect(calls).toBe(0);
});
test("snoozed-only and pinned groups remain reachable through Show all without consuming normal slots", () => {
  const snooze = {
    id: "s",
    createdAt: now.toISOString(),
    nextCheckAt: now.toISOString(),
    lastCheck: null,
    config: { mode: "ai" as const, prompt: "CI passes", intervalHours: 1 as const },
  };
  const hidden = { workspaceKey: "hidden", snooze };
  const awake = { workspaceKey: "awake" };
  expect(selectSnoozableGroup([hidden], false)).toEqual({ visibleItems: [], canToggle: true });
  expect(selectSnoozableGroup([hidden, awake], false).visibleItems).toEqual([awake]);
  expect(selectSnoozableGroup([hidden, awake], true).visibleItems).toEqual([awake, hidden]);
  expect(
    selectSnoozableGroup([{ workspaceKey: "hidden" }], false, new Map([["hidden", hidden]])),
  ).toEqual({ visibleItems: [], canToggle: true });
});

test("status discovery seeds selections, retry preserves choices, and save sends identities without trusting preview values", async () => {
  const target = { kind: "linear" as const, issueId: "6e22bbbf-7d65-4463-8c1e-9ea7f8914abc" };
  const snapshot = {
    target,
    label: "APP-1",
    value: "review",
    valueLabel: "Review",
    capturedAt: now.toISOString(),
  };
  const saved: Array<WorkspaceSnoozeInput | StatusSnoozeInput | null> = [];
  let unavailable = true;
  const model = openSnoozeForm({
    snooze: null,
    timezone: "UTC",
    now: () => now,
    save: async (input) => {
      saved.push(input);
    },
    check: async () => {},
    saved: () => {},
    discover: async () => {
      if (unavailable) throw new Error("Host disconnected");
      return { candidates: [snapshot], errors: [], autoArchiveAfterMerge: true };
    },
  });
  model.setMode("status");
  await Promise.resolve();
  expect(model.getState().statusLoad).toBe("error");
  unavailable = false;
  await model.loadStatus();
  expect(model.getState().statusLoad).toBe("ready");
  const key = model.getState().selected[0];
  model.toggleTarget(key);
  await model.loadStatus();
  await model.submit();
  expect(saved).toEqual([]);
  expect(model.getState().error).toContain("at least one");
  model.toggleTarget(key);
  model.setStatusInterval(60);
  await model.submit();
  expect(saved).toEqual([{ mode: "status", targets: [target], intervalMinutes: 60 }]);
  model.close();
});
