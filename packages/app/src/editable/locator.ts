import type { EditableLocatorContext, EditableRouteContext } from "./types";

export interface EditableTarget {
  element: Element;
  context: EditableLocatorContext;
}

export function locateEditableTarget(
  _target: unknown,
  _route: EditableRouteContext,
): EditableTarget | null {
  return null;
}
