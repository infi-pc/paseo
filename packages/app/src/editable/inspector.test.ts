// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  COMPACT_SANITIZE,
  FULL_SANITIZE,
  collectDomSnapshot,
  collectReactAncestors,
  sanitizeInspectorValue,
} from "./inspector-serialize";

describe("editable inspector serialization", () => {
  it("redacts real credential keys while preserving chat text and UI props", () => {
    const input = {
      title: "Inbox",
      collapsible: true,
      chatMessage: "I think these headers do not have to be contractable, what do you think?",
      authorization: "Bearer super-secret",
      apiKey: "sk-12345",
      nested: {
        accessToken: "tok-999",
        variant: "ghost",
      },
      onClick: () => {},
    };

    expect(sanitizeInspectorValue(input, COMPACT_SANITIZE)).toEqual({
      title: "Inbox",
      collapsible: true,
      chatMessage: "I think these headers do not have to be contractable, what do you think?",
      authorization: "[redacted]",
      apiKey: "[redacted]",
      nested: {
        accessToken: "[redacted]",
        variant: "ghost",
      },
      onClick: "[fn]",
    });

    const longMessage = "a".repeat(600);
    const compact = sanitizeInspectorValue(longMessage, COMPACT_SANITIZE) as string;
    const full = sanitizeInspectorValue(longMessage, FULL_SANITIZE) as string;
    expect(compact.length).toBeLessThan(500);
    expect(full).toBe(longMessage);
  });

  it("walks React fibers to collect userland ancestors, props, and hook states", () => {
    const el = document.createElement("button");
    const parentFiber = {
      type: { displayName: "InboxSection" },
      _debugSource: {
        fileName: "/repo/packages/app/src/inbox/InboxSection.tsx",
        lineNumber: 24,
        columnNumber: 3,
      },
      memoizedProps: { title: "Inbox", collapsible: true, secretToken: "abc" },
      memoizedState: {
        memoizedState: true,
        queue: {},
        next: {
          // Effect hook should be skipped
          memoizedState: { tag: 8, create: () => {}, deps: [] },
          queue: {},
          next: null,
        },
      },
      return: null,
    };
    const childFiber = {
      type: { name: "PressHighlight" },
      memoizedProps: { "data-ed-src": "packages/app/src/ui/press.tsx:12:4", disabled: false },
      memoizedState: null,
      return: parentFiber,
    };
    (el as unknown as Record<string, unknown>).__reactFiber$test = childFiber;

    const ancestors = collectReactAncestors(el);
    expect(ancestors).toEqual([
      {
        name: "PressHighlight",
        source: "packages/app/src/ui/press.tsx:12:4",
        props: { disabled: false },
        hooks: [],
      },
      {
        name: "InboxSection",
        source: "packages/app/src/inbox/InboxSection.tsx:24:3",
        props: { title: "Inbox", collapsible: true, secretToken: "[redacted]" },
        hooks: [true],
      },
    ]);
  });

  it("collects DOM neighborhood, geometry, and overflow flags", () => {
    const parent = document.createElement("div");
    parent.setAttribute("data-ed-comp", "SidebarHeader");
    const child = document.createElement("button");
    child.setAttribute("role", "button");
    child.textContent = "Open chats";
    parent.appendChild(child);
    document.body.appendChild(parent);

    const snapshot = collectDomSnapshot(child);
    expect(snapshot.target.tag).toBe("button");
    expect(snapshot.target.role).toBe("button");
    expect(snapshot.text).toBe("Open chats");
    expect(snapshot.ancestors[0]?.comp).toBe("SidebarHeader");
    expect(snapshot.overflow).toMatchObject({ horizontal: false, vertical: false });
    parent.remove();
  });
});
