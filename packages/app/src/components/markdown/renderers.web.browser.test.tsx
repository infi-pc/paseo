import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links";
import type { AssistantFileLinkDaemonClient } from "@/assistant-file-links/provider";
import { useSessionStore } from "@/stores/session-store";
import { i18n } from "@/i18n/i18next";
import { WEB_RENDERERS } from "./renderers.web";

const Link = WEB_RENDERERS.link;
const LINK_TEXT = "src/index.ts";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function anchorPropsFor(url: string) {
  return { href: url };
}

function renderAnchor(link: { url: string; sourceType?: "markdown" | "text" | "inline-code" }) {
  if (!Link) {
    throw new Error("Expected a web link renderer");
  }
  const anchorProps = anchorPropsFor(link.url);
  const client = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Link link={link} anchorProps={anchorProps}>
          {LINK_TEXT}
        </Link>
      </QueryClientProvider>,
    ),
  );
  const anchor = container.querySelector("a");
  if (!anchor) {
    throw new Error("Expected a rendered link");
  }
  return anchor;
}

it("marks a link it recognized from a path for selection copy", () => {
  const anchor = renderAnchor({ url: LINK_TEXT, sourceType: "text" });
  expect(anchor.getAttribute("href")).toBe(LINK_TEXT);
  expect(anchor.getAttribute("data-paseo-markdown-recognized-link")).toBe("true");
});

it("leaves an authored link wrapped", () => {
  const anchor = renderAnchor({ url: "https://example.test/doc", sourceType: "markdown" });
  expect(anchor.hasAttribute("data-paseo-markdown-recognized-link")).toBe(false);
});

it("loads exact PR details on keyboard focus and keeps the original link destination", async () => {
  if (!Link) throw new Error("Expected a web link renderer");
  await page.viewport(1280, 900);
  const serverId = "pr-link-preview-host";
  const sessionStore = useSessionStore.getState();
  const prUrl = "https://github.com/acme/other-repo/pull/42";
  const href = `${prUrl}/files#diff-1`;
  const searchForge = vi.fn(async () => ({
    items: [
      {
        kind: "change_request",
        number: 42,
        title: "Fix checkout",
        url: prUrl,
        state: "MERGED",
        body: null,
        labels: [],
        reviewDecision: "APPROVED",
        checks: [{ name: "Build", status: "success", url: null }],
      },
    ],
    authState: "authenticated",
    error: null,
    requestId: "test",
  }));
  sessionStore.initializeSession(serverId, null);
  sessionStore.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: { githubPullRequestLinkPreview: true },
  });
  const client = previewClient(searchForge);
  const link = markdownLinkFor(href);
  const anchorProps = anchorPropsFor(href);
  try {
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AssistantFileLinkResolverProvider
            client={client}
            serverId={serverId}
            workspaceRoot="/workspace"
            enablePullRequestLinkPreviews
          >
            <Link link={link} anchorProps={anchorProps}>
              Pull request
            </Link>
          </AssistantFileLinkResolverProvider>
        </QueryClientProvider>,
      ),
    );
    expect(searchForge).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      container.querySelector("a")?.focus();
    });
    await expect.element(page.getByRole("tooltip")).toHaveTextContent("Fix checkout");
    await expect.element(page.getByRole("tooltip")).toHaveTextContent("Build: Passed");
    await expect.element(page.getByRole("img", { name: "Merged" })).toBeInTheDocument();
    await expect.element(page.getByRole("link")).toHaveAttribute("href", href);
    expect(searchForge).toHaveBeenCalledExactlyOnceWith({
      cwd: "/workspace",
      query: prUrl,
      kinds: ["change_request"],
      limit: 1,
    });
  } finally {
    act(() => sessionStore.clearSession(serverId));
  }
});

function markdownLinkFor(url: string) {
  return { url, sourceType: "markdown" } as const;
}

function previewClient(searchForge: AssistantFileLinkDaemonClient["searchForge"]) {
  return {
    searchForge,
    getDirectorySuggestions: async () => ({ entries: [], error: null }),
  };
}
