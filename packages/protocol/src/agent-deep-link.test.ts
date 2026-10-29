import { parseComposeDeepLink, buildComposeRoute } from "./compose-deep-link.js";
import { describe, expect, it } from "vitest";
import {
  buildAgentDeepLink,
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
} from "./agent-deep-link.js";

describe("agent deep links", () => {
  it("round-trips an existing agent target", () => {
    const target = { serverId: "server/main", agentId: "agent 123" };

    const link = buildAgentDeepLink(target);

    expect(link).toBe("paseo://h/server%2Fmain/agent/agent%20123");
    expect(buildAgentDeepLinkRoute(target)).toBe("/h/server%2Fmain/agent/agent%20123");
    expect(parseAgentDeepLink(link)).toEqual(target);
  });

  it("rejects links outside the exact agent route", () => {
    expect(parseAgentDeepLink("https://h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://app/h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1?message=hello")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1/extra")).toBeNull();
  });
});

// FORK(locator-compose): compose URLs remain separate from stable agent URLs.
describe("compose deep links", () => {
  it("accepts encoded LocatorJS source paths and positions", () => {
    expect(
      parseComposeDeepLink(
        "paseo://compose?cwd=%2Fwork%2Fmy%20repo&file=%2Fwork%2Fmy%20repo%2FButton%23new.tsx&line=42&column=7",
      ),
    ).toEqual({
      kind: "compose",
      serverId: null,
      cwd: "/work/my repo",
      file: "/work/my repo/Button#new.tsx",
      line: 42,
      column: 7,
    });
  });

  it("supports an explicit host and Windows worktree", () => {
    expect(
      parseComposeDeepLink(
        "paseo://compose?serverId=remote&cwd=C%3A%5Cwork%5Crepo&file=src%2FButton.tsx",
      ),
    ).toEqual({
      kind: "compose",
      serverId: "remote",
      cwd: "C:\\work\\repo",
      file: "src/Button.tsx",
      line: null,
      column: null,
    });
  });

  it.each([
    "https://compose?cwd=/repo&file=Button.tsx",
    "paseo://user@compose?cwd=/repo&file=Button.tsx",
    "paseo://compose/extra?cwd=/repo&file=Button.tsx",
    "paseo://compose?cwd=/repo&file=Button.tsx#fragment",
    "paseo://compose?file=Button.tsx",
    "paseo://compose?cwd=relative&file=Button.tsx",
    "paseo://compose?cwd=/repo&file=",
    "paseo://compose?cwd=/repo&file=Button.tsx&line=0",
    "paseo://compose?cwd=/repo&file=Button.tsx&line=1.5",
    "paseo://compose?cwd=/repo&file=Button.tsx&line=9007199254740992",
    "paseo://compose?cwd=/repo&file=Button.tsx&column=7",
    "paseo://compose?cwd=/repo&file=Button.tsx&line=42&column=-1",
    "paseo://compose?cwd=/repo&file=Button.tsx&message=send",
    "paseo://compose?cwd=/repo&cwd=/other&file=Button.tsx",
    "paseo://compose?cwd=/repo&file=Button%0A.tsx",
  ])("rejects malformed or unsupported input: %s", (url) => {
    expect(parseComposeDeepLink(url)).toBeNull();
  });

  it("encodes app navigation without losing source location or request identity", () => {
    expect(
      buildComposeRoute(
        {
          kind: "compose",
          serverId: "host",
          cwd: "/repo space",
          file: "src/Button.tsx",
          line: 42,
          column: 7,
        },
        "request-1",
      ),
    ).toBe(
      "/compose?cwd=%2Frepo+space&file=src%2FButton.tsx&requestId=request-1&serverId=host&line=42&column=7",
    );
  });
});
