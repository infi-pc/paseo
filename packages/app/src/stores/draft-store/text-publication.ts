const pendingTextFlushers = new Map<string, Set<() => void>>();

// Retained editors publish after paint; external edits must merge their pending text first.
export function registerDraftTextPublication(input: {
  draftKey: string;
  flush: () => void;
}): () => void {
  let flushers = pendingTextFlushers.get(input.draftKey);
  if (!flushers) {
    flushers = new Set();
    pendingTextFlushers.set(input.draftKey, flushers);
  }
  flushers.add(input.flush);
  return () => {
    flushers.delete(input.flush);
    if (flushers.size === 0) pendingTextFlushers.delete(input.draftKey);
  };
}

export function flushDraftTextPublication(draftKey: string): void {
  const flushers = pendingTextFlushers.get(draftKey);
  if (!flushers) return;
  for (const flush of flushers) flush();
}
