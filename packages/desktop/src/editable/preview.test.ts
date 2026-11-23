import { describe, expect, it } from "vitest";
import { validatePreviewUrl } from "./preview.js";

describe("editable Metro preview URL", () => {
  it.each([
    "http://localhost:8081/",
    "http://127.0.0.1:8081/path?param=yes#top",
    "http://localhost:80/",
  ])("accepts the explicit HTTP loopback origin %s", (url) =>
    expect(validatePreviewUrl(url)).toBe(url),
  );

  it.each([
    null,
    "http://localhost/",
    "http://localhost.evil.test:8081/",
    "http://127.0.0.1.evil.test:8081/",
    "http://localhost:8081@evil.test/",
    "http://evil.test@localhost:8081/",
    "http://0x7f000001:8081/",
    "http://127.1:8081/",
    "http://[::1]:8081/",
    "http://localhost.:8081/",
    "http://localhost:65536/",
    "https://localhost:8081/",
    "file:///tmp/index.html",
  ])("rejects unsupported preview URL %s", (url) => {
    expect(() => validatePreviewUrl(url)).toThrow();
  });
});
