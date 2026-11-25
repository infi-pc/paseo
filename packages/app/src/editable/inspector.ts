import type { EditableElementSnapshot } from "./types";

export function installEditableInspector(): () => void {
  return () => {};
}

export function recordEditableRoute(_route: string): void {}

export function captureEditableElementSnapshot(_element: unknown): EditableElementSnapshot | null {
  return null;
}
