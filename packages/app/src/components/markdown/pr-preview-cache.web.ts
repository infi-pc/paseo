import { ForgeSearchItemSchema, type ForgeSearchItem } from "@getpaseo/protocol/messages";

const STORAGE_KEY = "paseo.github-pr-link-previews.v1";
const MAX_ENTRIES = 96;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedPreview {
  updatedAt: number;
  data: ForgeSearchItem;
}

function readCache(): Record<string, CachedPreview> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function readCachedPrPreview(key: string): CachedPreview | undefined {
  const entry = readCache()[key];
  if (!entry || !Number.isFinite(entry.updatedAt) || Date.now() - entry.updatedAt >= MAX_AGE_MS) {
    return undefined;
  }
  const parsed = ForgeSearchItemSchema.safeParse(entry.data);
  if (parsed.success) return { data: parsed.data, updatedAt: entry.updatedAt };
}

export function writeCachedPrPreview(key: string, data: ForgeSearchItem) {
  try {
    const now = Date.now();
    const cache = readCache();
    cache[key] = {
      updatedAt: now,
      data: {
        kind: data.kind,
        number: data.number,
        url: data.url,
        title: data.title.slice(0, 512),
        state: data.state,
        body: null,
        labels: [],
        isDraft: data.isDraft,
        reviewDecision: data.reviewDecision,
        checks: data.checks?.map(({ name, status, workflow }) => ({
          name: name.slice(0, 256),
          workflow: workflow?.slice(0, 256),
          status,
          url: null,
        })),
      },
    };
    const recent = Object.entries(cache)
      .filter(([, entry]) => entry && now - entry.updatedAt < MAX_AGE_MS)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    // In-memory status still works when browser storage is full or disabled.
  }
}
