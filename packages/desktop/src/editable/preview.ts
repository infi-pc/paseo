export function validatePreviewUrl(value: unknown): string {
  const match =
    typeof value === "string" &&
    /^http:\/\/(localhost|127\.0\.0\.1):([0-9]+)(?:[/?#]|$)/.exec(value);
  if (!match) throw new Error("Preview requires an HTTP localhost or 127.0.0.1 URL with a port");
  const url = new URL(match.input);
  if (url.hostname !== match[1] || url.username || url.password) {
    throw new Error("Preview requires an HTTP loopback origin");
  }
  return `http://${url.hostname}:${url.port || "80"}${url.pathname}${url.search}${url.hash}`;
}
