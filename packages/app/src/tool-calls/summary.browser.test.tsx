import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { ToolCallSummaryLabel } from "./summary-label";
import { Pressable } from "react-native";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCallDetailsContent } from "@/components/tool-call-details";

const detail: ToolCallDetail = {
  type: "shell",
  command: "npm run typecheck",
  output: "TS2339: Property foo does not exist",
};

let mounted: { root: Root; container: HTMLDivElement } | null = null;
afterEach(() => {
  if (!mounted) return;
  act(() => mounted?.root.unmount());
  mounted.container.remove();
  mounted = null;
});

describe("generated tool-call details", () => {
  it.each([360, 1000])(
    "shows the full description and original command/output at %ipx",
    (width) => {
      const container = document.createElement("div");
      container.style.width = `${width}px`;
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted = { root, container };
      const description =
        "Checked the app's types. The check failed because a required property was missing. The command made no changes.";
      act(() =>
        root.render(
          <ToolCallDetailsContent
            description={description}
            detail={detail}
            errorText="Exit code 1"
          />,
        ),
      );
      const summary = container.querySelector('[data-testid="tool-call-description"]');
      expect(summary?.textContent).toBe(description);
      expect(container.textContent).toContain("npm run typecheck");
      expect(container.textContent).toContain("TS2339");
      expect(container.textContent).toContain("Exit code 1");
      expect(summary?.getBoundingClientRect().width).toBeLessThanOrEqual(width);
    },
  );
});

describe("input and result labels", () => {
  it.each([360, 1000])("keeps linked input and result on one line at %ipx", (width) => {
    const container = document.createElement("div");
    container.style.width = `${width}px`;
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };
    const openFile = vi.fn();
    const expand = vi.fn();
    const render = (output?: string) =>
      act(() =>
        root.render(
          <Pressable onPress={expand}>
            <ToolCallSummaryLabel
              input="Read lets-plan-adding-it-federated-cerf.md"
              output={output}
              inputFilePath="/Users/me/.claude/plans/lets-plan-adding-it-federated-cerf.md"
              onOpenFilePath={openFile}
              outputFilePath="/repo/src/keep-awake.ts"
            />
          </Pressable>,
        ),
      );
    render();
    expect(container.textContent).toBe("Read lets-plan-adding-it-federated-cerf.md");
    expect(container.querySelector('[data-testid="tool-call-output-label"]')).toBeNull();
    render("Plan: prevent Mac sleep during agent runs");
    const input = container.querySelector<HTMLElement>('[data-testid="tool-call-input-label"]')!;
    const output = container.querySelector<HTMLElement>('[data-testid="tool-call-output-label"]')!;
    const link = container.querySelector<HTMLElement>('[role="link"]')!;
    expect(getComputedStyle(input).fontWeight).toBe("500");
    expect(getComputedStyle(output).fontWeight).toBe("400");
    expect(getComputedStyle(link).fontWeight).toBe("500");
    expect(input.getBoundingClientRect().top).toBe(output.getBoundingClientRect().top);
    expect(output.getBoundingClientRect().right).toBeLessThanOrEqual(
      container.getBoundingClientRect().right,
    );
    expect(container.textContent).toContain("→Plan: prevent Mac sleep during agent runs");
    act(() => link.click());
    expect(openFile).toHaveBeenCalledOnce();
    expect(expand).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenLastCalledWith(
      "/Users/me/.claude/plans/lets-plan-adding-it-federated-cerf.md",
    );
    render("Updated keep-awake.ts");
    const outputLink = container.querySelector<HTMLElement>(
      '[data-testid="tool-call-output-label"] [role="link"]',
    )!;
    act(() => outputLink.click());
    expect(openFile).toHaveBeenLastCalledWith("/repo/src/keep-awake.ts");
    expect(expand).not.toHaveBeenCalled();
  });
});

const activity = {
  id: "review-turn",
  provider: "codex",
  omitted: 1,
  records: [
    {
      id: "review",
      event: "item/autoApprovalReview/completed",
      timestamp: "2026-09-30T12:00:00Z",
      summary: "Blocked by auto-review: outside scope",
      level: "warning" as const,
      callId: "call-1",
      payload: '{"rationale":"outside scope","riskLevel":"high"}',
      truncated: false,
    },
  ],
};

it.each([360, 1000])("reveals activity evidence progressively at %ipx", async (width) => {
  expect(i18n.isInitialized).toBe(true);
  const { ProviderActivityView } = await import("@/components/provider-activity");
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };

  act(() =>
    root.render(
      <ProviderActivityView
        activity={activity}
        level="warning"
        message="Blocked by auto-review: outside scope"
      />,
    ),
  );
  expect(container.textContent).toContain("Blocked by auto-review");
  expect(container.textContent).not.toContain("riskLevel");
  const toggle = container.querySelector<HTMLElement>('[role="button"]');
  expect(toggle).not.toBeNull();
  act(() => toggle!.click());
  expect(container.textContent).toContain("call-1");
  expect(container.textContent).not.toContain("riskLevel");
  const buttons = [...container.querySelectorAll<HTMLElement>('[role="button"]')];
  act(() => buttons.at(-1)!.click());
  expect(container.textContent).toContain("riskLevel");
  await page
    .getByTestId("provider-activity")
    .screenshot({ path: `/tmp/paseo-activity-${width}.png` });
  expect(container.getBoundingClientRect().width).toBeLessThanOrEqual(width);
});
