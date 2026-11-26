import { describe, expect, it } from "vitest";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import {
  getAssistantDisplayText,
  getLatestRecommendedPrompts,
  getLatestResponseMeta,
  parseWorkshopUserMessage,
  summarizeToolCall,
} from "./use-editable-chat";
import { buildWorkshopFollowUpPrompt, buildWorkshopPrompt } from "./workshop-client";

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
      locatorLabels: ["WorkspaceHeader · Header.tsx:42"],
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
      locatorLabels: ["WorkspaceHeader · Header.tsx:42"],
    });
  });

  it("extracts multiple locator chips from element-referenced follow-up prompts", () => {
    const followUp = buildWorkshopFollowUpPrompt("Compare these two elements.", [
      {
        locator: {
          file: "packages/app/src/Header.tsx",
          line: 10,
          column: 1,
          componentName: "Header",
          route: "/workspaces",
          releaseDigest: null,
          platform: "electron",
        },
      },
      {
        locator: {
          file: "packages/app/src/components/ui/press-highlight.tsx",
          line: 12,
          column: 3,
          componentName: "PressHighlight",
          route: "/workspaces",
          releaseDigest: null,
          platform: "electron",
        },
      },
    ]);
    expect(parseWorkshopUserMessage(followUp)).toEqual({
      text: "Compare these two elements.",
      locatorLabel: "Header · Header.tsx:10",
      locatorLabels: ["Header · Header.tsx:10", "PressHighlight · press-highlight.tsx:12"],
    });
  });

  it("leaves plain follow-up messages untouched", () => {
    expect(parseWorkshopUserMessage("Sounds good, go ahead and implement it.")).toEqual({
      text: "Sounds good, go ahead and implement it.",
      locatorLabel: null,
      locatorLabels: [],
    });
  });
});

describe("paseo-meta display & recommended prompts (matching main Paseo)", () => {
  const assistant = (id: string, text: string, turnId = "t1"): StreamItem => ({
    kind: "assistant_message",
    id,
    text,
    turnId,
    timestamp: new Date(0),
  });
  const user = (id: string, text: string, turnId = "t2"): StreamItem => ({
    kind: "user_message",
    id,
    text,
    turnId,
    timestamp: new Date(0),
  });

  it("strips valid <paseo-meta> on final turn responses and withholds partial footers while streaming", () => {
    const completed = [
      assistant(
        "a1",
        'Confirmed.\n<paseo-meta message="Confirmed." title="Response metadata" icon="🔎" prompt1="Add it" />',
        "t1",
      ),
    ];
    expect(getAssistantDisplayText(completed, 0, false)).toBe("Confirmed.");

    const streamingPartial = [assistant("a1", 'Confirmed.\n<paseo-meta message="Confi', "t1")];
    expect(getAssistantDisplayText(streamingPartial, 0, true)).toBe("Confirmed.");
    expect(getAssistantDisplayText(streamingPartial, 0, false)).toBe(
      'Confirmed.\n<paseo-meta message="Confi',
    );

    const midTurn = [
      assistant("a1", 'Step 1\n<paseo-meta message="Not final." />', "t1"),
      assistant("a2", 'Step 2\n<paseo-meta message="Final." />', "t1"),
    ];
    expect(getAssistantDisplayText(midTurn, 0, false)).toContain("<paseo-meta");
    expect(getAssistantDisplayText(midTurn, 1, false)).toBe("Step 2");
  });

  it("extracts deduplicated recommended prompts only for the latest completed turn", () => {
    const items = [
      assistant(
        "a1",
        'First.\n<paseo-meta message="First." title="Prompt check" icon="🔎" prompt1="Old prompt" />',
        "t1",
      ),
      user("u2", "Follow up", "t2"),
      assistant(
        "a2",
        'Second.\n<paseo-meta message="Second." prompt1="Make Paseo ask for prompts" prompt2="Make Paseo ask for prompts" prompt3="Check tests" />',
        "t2",
      ),
    ];
    expect(getLatestRecommendedPrompts(items, false)).toEqual([
      "Make Paseo ask for prompts",
      "Check tests",
    ]);
    expect(getLatestRecommendedPrompts(items, true)).toEqual([]);
    expect(
      getLatestRecommendedPrompts([...items, user("u3", "New question", "t3")], false),
    ).toEqual([]);
    expect(getLatestResponseMeta(items)).toEqual({
      message: "Second.",
      title: "Prompt check",
      icon: "🔎",
      prompts: ["Make Paseo ask for prompts", "Make Paseo ask for prompts", "Check tests"],
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
