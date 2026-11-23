// @vitest-environment jsdom
import { expect, it } from "vitest";
import { locateEditableTarget } from "./locator.web";

const route = {
  route: "/h/workshop/workspace/123?token=secret#also-secret",
  releaseDigest: "a".repeat(64),
  platform: "electron",
} as const;

it("locates the nearest stamped component and emits only allowlisted metadata", () => {
  const wrapper = document.createElement("div");
  wrapper.dataset.edSrc = "packages/app/src/Layout.tsx:2:1";
  wrapper.innerHTML =
    '<div data-ed-src="packages/app/src/Header.tsx:42:5" data-ed-comp="WorkspaceHeader"><span aria-label="private" data-secret="credential">private agent transcript</span></div>';
  const target = wrapper.querySelector("span");
  expect(locateEditableTarget(target, route)).toEqual({
    element: wrapper.firstElementChild,
    context: {
      file: "packages/app/src/Header.tsx",
      line: 42,
      column: 5,
      componentName: "WorkspaceHeader",
      route: "/h/workshop/workspace/123",
      releaseDigest: "a".repeat(64),
      platform: "electron",
    },
  });
  wrapper.dataset.edOverlay = "true";
  expect(locateEditableTarget(target, route)).toBeNull();
});

it("reads React debug metadata without reading any React props", () => {
  const element = document.createElement("article");
  Object.assign(element, {
    __reactFiber$test: {
      _debugSource: { fileName: "/home/person/Paseo/packages/app/src/Panel.tsx", lineNumber: 6 },
      return: { type: function WorkshopPanel() {} },
      get memoizedProps() {
        throw new Error("Props are private");
      },
    },
  });
  expect(locateEditableTarget(element, route)?.context).toEqual({
    file: "packages/app/src/Panel.tsx",
    line: 6,
    column: 1,
    componentName: "WorkshopPanel",
    route: "/h/workshop/workspace/123",
    releaseDigest: "a".repeat(64),
    platform: "electron",
  });
});

it("rejects a fabricated stamp outside the app source directory", () => {
  const element = document.createElement("div");
  element.dataset.edSrc = "packages/app/src/../../../secret.tsx:1:2";
  expect(locateEditableTarget(element, route)).toBeNull();
});
