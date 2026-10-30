import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  expectTimelinePromptLandedBelowTop,
  expectTimelinePromptVisible,
  openAgentTimeline,
  scrollTimelinePromptIntoView,
  seedLongMockAgentTimeline,
  type LongTimelineAgent,
} from "../support/helpers/timeline-pagination";

// Wide enough that the transcript is well clear of the compact form factor, which has no pin.
const WIDE_VIEWPORT = { width: 1440, height: 900 };
const COMPACT_VIEWPORT = { width: 420, height: 860 };
const LOADED_TURNS = 12;
// Leave enough later content for the chosen prompt to clear a tall viewport.
const READING_TURN = 6;

function timeline(page: Page) {
  return page.locator('[data-testid="agent-chat-scroll"]:visible').first();
}

function pinnedPrompt(page: Page) {
  return page.getByTestId("pinned-prompt");
}

/** Scrolls down until the prompt's own bubble has left the top of the transcript. */
async function scrollPromptAboveFold(page: Page, prompt: string): Promise<void> {
  await scrollTimelinePromptIntoView(page, prompt);
  const promptRow = timeline(page).getByTestId("user-message").filter({ hasText: prompt });
  await expect
    .poll(
      async () => {
        const [timelineBox, promptBox] = await Promise.all([
          timeline(page).boundingBox(),
          promptRow.boundingBox().catch(() => null),
        ]);
        if (!timelineBox) return false;
        // Once the row unmounts it is definitively above the fold.
        if (!promptBox) return true;
        if (promptBox.y + promptBox.height < timelineBox.y) return true;
        await page.mouse.wheel(0, 160);
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

test.describe("pinned current prompt", () => {
  let agent: LongTimelineAgent;

  test.beforeEach(async ({ page }) => {
    agent = await seedLongMockAgentTimeline({ turns: LOADED_TURNS });
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.newestPrompt);
  });

  test.afterEach(async () => {
    await agent?.cleanup();
  });

  test("pins nothing while the prompt's own bubble is on screen", async ({ page }) => {
    await scrollTimelinePromptIntoView(page, agent.prompts[READING_TURN]!);

    await expect(pinnedPrompt(page)).toHaveCount(0);
  });

  test("pins the prompt of the turn being read once its bubble scrolls past the top", async ({
    page,
  }) => {
    await scrollPromptAboveFold(page, agent.prompts[READING_TURN]!);

    await expect(pinnedPrompt(page)).toContainText(agent.prompts[READING_TURN]!);
  });

  test("caps the pin at 70% of the content rail and keeps it on the right edge", async ({
    page,
  }) => {
    const longPrompt = Array.from({ length: 60 }, (_unused, word) => `railwidth${word}`).join(" ");
    await agent.client.sendAgentMessage(agent.agentId, longPrompt);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const realBubble = timeline(page).getByTestId("user-message").filter({ hasText: longPrompt });
    await expect(realBubble).toBeVisible();
    const realBox = await realBubble.boundingBox();
    if (!realBox) throw new Error("Expected the real user message to have a layout box");

    await scrollPromptAboveFold(page, longPrompt);
    const pin = pinnedPrompt(page);
    await expect(pin).toBeVisible();
    const pinBox = await pin.boundingBox();
    if (!pinBox) throw new Error("Expected the pinned prompt to have a layout box");

    // The real bubble spans the rail; the pin is that width scaled to 70%, never wider.
    expect(pinBox.width).toBeLessThanOrEqual(realBox.width * 0.7 + 2);
    expect(pinBox.width).toBeGreaterThan(realBox.width * 0.6);
    // Scaled toward the top-right corner, so the right edges line up.
    expect(Math.abs(pinBox.x + pinBox.width - (realBox.x + realBox.width))).toBeLessThanOrEqual(2);
  });

  test("swaps the pin when the reader crosses into the next turn", async ({ page }) => {
    await scrollPromptAboveFold(page, agent.prompts[READING_TURN]!);
    await expect(pinnedPrompt(page)).toContainText(agent.prompts[READING_TURN]!);

    await scrollPromptAboveFold(page, agent.prompts[READING_TURN + 1]!);

    await expect(pinnedPrompt(page)).toContainText(agent.prompts[READING_TURN + 1]!);
  });

  test("scrolls the real message back under the pin when clicked", async ({ page }) => {
    await scrollPromptAboveFold(page, agent.prompts[READING_TURN]!);
    await pinnedPrompt(page).click();

    await expectTimelinePromptLandedBelowTop(page, agent.prompts[READING_TURN]!);
    // The prompt is the reading row again, so its own bubble carries the turn.
    await expect(pinnedPrompt(page)).toHaveCount(0);
  });

  test("fades a prompt longer than the pinned cap", async ({ page }) => {
    const longPrompt = Array.from({ length: 20 }, (_unused, line) => `pinned cap line ${line}`)
      .join("\n")
      .concat(" end");
    await agent.client.sendAgentMessage(agent.agentId, longPrompt);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await scrollPromptAboveFold(page, longPrompt);

    await expect(pinnedPrompt(page)).toBeVisible();
    await expect(page.getByTestId("pinned-prompt-fade")).toBeVisible();
  });

  test("pins nothing on a compact viewport", async ({ page }) => {
    await page.setViewportSize(COMPACT_VIEWPORT);
    await scrollPromptAboveFold(page, agent.prompts[READING_TURN]!);

    await expect(pinnedPrompt(page)).toHaveCount(0);
  });
});
