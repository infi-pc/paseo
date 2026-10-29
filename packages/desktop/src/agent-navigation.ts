import { parseAgentDeepLink, buildAgentDeepLinkRoute } from "@getpaseo/protocol/agent-deep-link";
import {
  buildComposeRoute,
  parseComposeDeepLink,
  type DesktopNavigationTarget,
} from "@getpaseo/protocol/compose-deep-link";
import { randomUUID } from "node:crypto";

export function parseDesktopDeepLink(input: string): DesktopNavigationTarget | null {
  return parseAgentDeepLink(input) ?? parseComposeDeepLink(input);
}

export function buildDesktopNavigationRoute(target: DesktopNavigationTarget): string {
  return "kind" in target
    ? buildComposeRoute(target, randomUUID())
    : buildAgentDeepLinkRoute(target);
}

export function parseDesktopDeepLinkFromArgv(argv: string[]): DesktopNavigationTarget | null {
  for (const arg of argv) {
    const target = parseDesktopDeepLink(arg);
    if (target) {
      return target;
    }
  }
  return null;
}

export class AgentNavigationInbox {
  private readonly readyWindows = new Set<number>();
  private readonly pendingByWindow = new Map<number, DesktopNavigationTarget>();

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
  }

  windowReady(webContentsId: number): DesktopNavigationTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingByWindow.get(webContentsId) ?? null;
    this.pendingByWindow.delete(webContentsId);
    return pending;
  }

  deliverOrQueue(
    webContentsId: number,
    target: DesktopNavigationTarget,
  ): DesktopNavigationTarget | null {
    if (this.readyWindows.has(webContentsId)) {
      return target;
    }
    this.pendingByWindow.set(webContentsId, target);
    return null;
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingByWindow.delete(webContentsId);
  }
}
