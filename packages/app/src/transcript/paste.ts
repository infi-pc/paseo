export interface TextInsertion {
  text: string;
  start: number;
  end: number;
}

// Native text paste uses the normal input change event. Only a complete inserted envelope is consumed.
export function findTranscriptInsertion(previous: string, next: string): TextInsertion | null {
  if (!next.includes("# Paseo transcript")) return null;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < next.length - start &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  const text = next.slice(start, next.length - suffix);
  if (!text.trimStart().startsWith("# Paseo transcript")) return null;
  return { text, start, end: previous.length - suffix };
}
