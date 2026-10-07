import {
  statusWatchKey,
  isStatusSnooze,
  type AnyWorkspaceSnooze,
  type StatusSnoozeInput,
  type StatusWatchSnapshot,
} from "@getpaseo/protocol/workspace-status-snooze";
import type { WorkspaceSnoozeInput } from "@getpaseo/protocol/workspace-snooze";

export type TimePreset = "hour" | "day" | "tomorrow" | "monday" | "custom";
export interface SnoozeFormState {
  mode: "time" | "ai" | "status";
  statusLoad: "idle" | "loading" | "ready" | "error";
  candidates: StatusWatchSnapshot[];
  selected: string[];
  intervalMinutes: 5 | 60;
  discoveryErrors: string[];
  autoArchiveAfterMerge: boolean;
  preset: TimePreset;
  date: string;
  time: string;
  month: Date;
  prompt: string;
  intervalHours: 1 | 24;
  pending: boolean;
  error: string | null;
  checked: boolean;
}
interface Options {
  snooze: AnyWorkspaceSnooze | null;
  discover?: () => Promise<{
    candidates: StatusWatchSnapshot[];
    errors: string[];
    autoArchiveAfterMerge: boolean;
  }>;
  timezone: string;
  now: () => Date;
  save: (input: WorkspaceSnoozeInput | StatusSnoozeInput | null) => Promise<void>;
  check: () => Promise<void>;
  saved: () => void;
}
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
export function dateText(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function presetDate(preset: Exclude<TimePreset, "custom">, now: Date): Date {
  if (preset === "hour") return new Date(now.getTime() + 3_600_000);
  if (preset === "day") return new Date(now.getTime() + 86_400_000);
  const date = new Date(now);
  const days = preset === "tomorrow" ? 1 : (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date;
}
export function customDate(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const parsed = new Date(year, month - 1, day, hour, minute);
  if (dateText(parsed) !== date || parsed.getHours() !== hour || parsed.getMinutes() !== minute)
    return null;
  return parsed;
}
export function calendarDays(month: Date): Array<string | null> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return Array.from({ length: Math.ceil((days + offset) / 7) * 7 }, (_, index) => {
    const day = index - offset + 1;
    return day > 0 && day <= days
      ? dateText(new Date(month.getFullYear(), month.getMonth(), day))
      : null;
  });
}

export function openSnoozeForm(options: Options) {
  const config = options.snooze?.config;
  const initialDate =
    config?.mode === "time" ? new Date(config.wakeAt) : presetDate("tomorrow", options.now());
  let state: SnoozeFormState = {
    mode: config?.mode ?? "time",
    statusLoad: "idle",
    candidates: isStatusSnooze(options.snooze) ? options.snooze.baseline : [],
    selected: config?.mode === "status" ? config.targets.map(statusWatchKey) : [],
    intervalMinutes: config?.mode === "status" ? config.intervalMinutes : 5,
    discoveryErrors: [],
    autoArchiveAfterMerge: false,
    preset: config?.mode === "time" ? "custom" : "hour",
    date: dateText(initialDate),
    time: `${pad(initialDate.getHours())}:${pad(initialDate.getMinutes())}`,
    month: new Date(initialDate.getFullYear(), initialDate.getMonth(), 1),
    prompt: config?.mode === "ai" ? config.prompt : "",
    intervalHours: config?.mode === "ai" ? config.intervalHours : 1,
    pending: false,
    error: null,
    checked: false,
  };
  let closed = false;
  let statusLoaded = config?.mode === "status";
  const listeners = new Set<() => void>();
  function publish(patch: Partial<SnoozeFormState>) {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function perform(action: () => Promise<void>, close: boolean) {
    if (state.pending || closed) return;
    publish({ pending: true, error: null, checked: false });
    try {
      await action();
      if (closed) return;
      if (close) options.saved();
      else publish({ checked: true });
    } catch (error) {
      publish({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      publish({ pending: false });
    }
  }
  async function loadStatus() {
    if (!options.discover || state.statusLoad === "loading" || closed) return;
    const first = !statusLoaded;
    publish({ statusLoad: "loading", discoveryErrors: [] });
    try {
      const result = await options.discover();
      statusLoaded ||= result.candidates.length > 0;
      publish({
        statusLoad: "ready",
        candidates: result.candidates,
        discoveryErrors: result.errors,
        autoArchiveAfterMerge: result.autoArchiveAfterMerge,
        selected: first ? result.candidates.map((s) => statusWatchKey(s.target)) : state.selected,
      });
    } catch (error) {
      publish({
        statusLoad: "error",
        discoveryErrors: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    loadStatus,
    toggleTarget(key: string) {
      publish({
        selected: state.selected.includes(key)
          ? state.selected.filter((k) => k !== key)
          : [...state.selected, key],
        error: null,
      });
    },
    setStatusInterval(intervalMinutes: 5 | 60) {
      publish({ intervalMinutes });
    },
    setMode(mode: SnoozeFormState["mode"]) {
      publish({ mode, error: null });
      if (mode === "status" && state.statusLoad === "idle") void loadStatus();
    },
    setPreset(preset: TimePreset) {
      publish({ preset, error: null });
    },
    setDate(date: string) {
      publish({ date, error: null });
    },
    setTime(time: string) {
      publish({ time, error: null });
    },
    setPrompt(prompt: string) {
      publish({ prompt, error: null });
    },
    setInterval(intervalHours: 1 | 24) {
      publish({ intervalHours });
    },
    moveMonth(delta: number) {
      publish({ month: new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1) });
    },
    submit() {
      return perform(async () => {
        if (state.mode === "status") {
          if (state.statusLoad !== "ready")
            throw new Error("Load connected statuses before saving");
          const targets = state.candidates
            .filter((s) => state.selected.includes(statusWatchKey(s.target)))
            .map((s) => s.target);
          if (!targets.length) throw new Error("Choose at least one status to watch");
          await options.save({ mode: "status", targets, intervalMinutes: state.intervalMinutes });
          return;
        }
        if (state.mode === "ai") {
          if (!state.prompt.trim()) throw new Error("Enter an unsnooze condition");
          await options.save({
            mode: "ai",
            prompt: state.prompt.trim(),
            intervalHours: state.intervalHours,
          });
          return;
        }
        const date =
          state.preset === "custom"
            ? customDate(state.date, state.time)
            : presetDate(state.preset, options.now());
        if (!date || date.getTime() <= options.now().getTime())
          throw new Error("Choose a valid future date and time");
        await options.save({
          mode: "time",
          wakeAt: date.toISOString(),
          timezone: options.timezone,
        });
      }, true);
    },
    unsnooze() {
      return perform(() => options.save(null), true);
    },
    check() {
      return perform(options.check, false);
    },
  };
}
