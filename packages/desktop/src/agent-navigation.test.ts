import { describe, expect, it } from "vitest";
import {
  AgentNavigationInbox,
  parseDesktopDeepLinkFromArgv,
  buildDesktopNavigationRoute,
} from "./agent-navigation.js";

describe("desktop agent navigation", () => {
  it("finds an agent deep link among Electron launch arguments", () => {
    expect(
      parseDesktopDeepLinkFromArgv([
        "/Applications/Paseo.app/Contents/MacOS/Paseo",
        "--no-sandbox",
        "paseo://h/server-1/agent/agent-2",
      ]),
    ).toEqual({ serverId: "server-1", agentId: "agent-2" });
  });

  it("holds navigation until the existing renderer is ready", () => {
    const inbox = new AgentNavigationInbox();
    const target = { serverId: "server-1", agentId: "agent-2" };

    expect(inbox.deliverOrQueue(7, target)).toBeNull();
    expect(inbox.windowReady(7)).toEqual(target);
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });

  it("returns only the newest navigation queued during startup", () => {
    const inbox = new AgentNavigationInbox();

    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-1" });
    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-2" });

    expect(inbox.windowReady(7)).toEqual({ serverId: "server-1", agentId: "agent-2" });
    expect(inbox.windowReady(7)).toBeNull();
  });
});

describe("compose navigation", () => {
  it("accepts compose links from launch arguments and queues them until ready", () => {
    const target = parseDesktopDeepLinkFromArgv([
      "Paseo",
      "paseo://compose?cwd=/repo&file=Button.tsx&line=42",
    ]);
    expect(target).toEqual({
      kind: "compose",
      serverId: null,
      cwd: "/repo",
      file: "Button.tsx",
      line: 42,
      column: null,
    });
    if (!target) throw new Error("Expected compose target");
    const inbox = new AgentNavigationInbox();
    expect(inbox.deliverOrQueue(7, target)).toBeNull();
    expect(inbox.windowReady(7)).toEqual(target);
    expect(inbox.windowReady(7)).toBeNull();
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
    const first = new URL(buildDesktopNavigationRoute(target), "https://app");
    const second = new URL(buildDesktopNavigationRoute(target), "https://app");
    expect(first.pathname).toBe("/compose");
    expect(first.searchParams.get("cwd")).toBe("/repo");
    expect(first.searchParams.get("requestId")).not.toBe(second.searchParams.get("requestId"));
  });
});
