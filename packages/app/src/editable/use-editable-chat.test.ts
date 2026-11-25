import { describe, expect, it } from "vitest";
import type { ToolCallItem } from "@/types/stream";
import { parseWorkshopUserMessage, summarizeToolCall } from "./use-editable-chat";
import { buildWorkshopPrompt } from "./workshop-client";

describe("parseWorkshopUserMessage", () => {
  it("strips the Workshop instruction wrapper and extracts the locator chip", () => {
    const prompt = buildWorkshopPrompt(
      {
        file: "packages/app/src/components/Header.tsx",
        line: 42,
        column: 5,
        componentName: "WorkspaceHeader",
        route: "/workspaces",
        releaseDigest: null,
        platform: "electron",
      },
      "What do you think about making this header static?",
      {
        slug: "inbox-headers",
        worktreePath: "/Users/tester/.editable-paseo/worktrees/inbox-headers",
      },
    );
    expect(parseWorkshopUserMessage(prompt)).toEqual({
      text: "What do you think about making this header static?",
      locatorLabel: "WorkspaceHeader · Header.tsx:42",
    });

    const withSnapshot = buildWorkshopPrompt(
      {
        file: "packages/app/src/components/Header.tsx",
        line: 42,
        column: 5,
        componentName: "WorkspaceHeader",
        route: "/workspaces",
        releaseDigest: null,
        platform: "electron",
      },
      "Why is this clipped?",
      {
        slug: "header-clip",
        snapshot: {
          react: [],
          dom: {
            tag: "div",
            role: null,
            rect: { x: 0, y: 0, width: 100, height: 24 },
            overflow: {
              horizontal: true,
              vertical: false,
              scrollWidth: 140,
              clientWidth: 100,
              scrollHeight: 24,
              clientHeight: 24,
            },
            styles: {},
            text: "Title",
            ancestors: [],
            children: [],
          },
          viewport: { width: 1200, height: 800, dpr: 2, scrollX: 0, scrollY: 0 },
          theme: "dark",
          density: null,
        },
      },
    );
    expect(parseWorkshopUserMessage(withSnapshot)).toEqual({
      text: "Why is this clipped?",
      locatorLabel: "WorkspaceHeader · Header.tsx:42",
    });
  });

  it("leaves plain follow-up messages untouched", () => {
    expect(parseWorkshopUserMessage("Sounds good, go ahead and implement it.")).toEqual({
      text: "Sounds good, go ahead and implement it.",
      locatorLabel: null,
    });
  });
});

describe("summarizeToolCall", () => {
  it("summarizes shell and file edit tool calls cleanly", () => {
    const shellItem: ToolCallItem = {
      kind: "tool_call",
      id: "tc-1",
      timestamp: new Date(0),
      payload: {
        source: "agent",
        data: {
          provider: "codex",
          callId: "call-1",
          name: "exec_command",
          status: "completed",
          error: null,
          detail: {
            type: "shell",
            command: "paseo-ed verify inbox-headers",
            output: "ok",
          },
        },
      },
    };
    expect(summarizeToolCall(shellItem)).toEqual({
      title: "paseo-ed verify inbox-headers",
      status: "completed",
      body: "paseo-ed verify inbox-headers\n\nok",
    });

    const editItem: ToolCallItem = {
      kind: "tool_call",
      id: "tc-2",
      timestamp: new Date(0),
      payload: {
        source: "agent",
        data: {
          provider: "codex",
          callId: "call-2",
          name: "edit_file",
          status: "running",
          error: null,
          detail: {
            type: "edit",
            filePath: "packages/app/src/components/Header.tsx",
          },
        },
      },
    };
    expect(summarizeToolCall(editItem)).toEqual({
      title: "edit Header.tsx",
      status: "running",
      body: "packages/app/src/components/Header.tsx",
    });
  });
});
