import { describe, expect, it } from "vitest";
import type { execCommand } from "../utils/spawn.js";
import { LinearService } from "./linear-service.js";

type CommandResult = Awaited<ReturnType<typeof execCommand>>;

function createCommand(...responses: (CommandResult | Error)[]) {
  const calls: Parameters<typeof execCommand>[] = [];
  const execute: typeof execCommand = async (...args) => {
    calls.push(args);
    const response = responses.shift();
    if (!response) throw new Error("No CLI response queued");
    if (response instanceof Error) throw response;
    return response;
  };
  return { execute, calls };
}

const target = { cwd: process.cwd(), prUrl: "https://github.com/ventrata/web-builder/pull/1095" };
const states = [
  { id: "release", name: "Ready for Release", type: "started", color: "#5e6ad2", position: 3144 },
  { id: "qa", name: "Ready for QA", type: "started", color: "#eb5757", position: 2079 },
  { id: "review", name: "Ready for review", type: "started", color: "#f2994a", position: 1022 },
  { id: "progress", name: "In Progress", type: "started", color: "#f2c94c", position: 2 },
  { id: "todo", name: "TO DO", type: "unstarted", color: "#e2e2e2", position: 1 },
];
const issue = {
  id: "issue-id",
  identifier: "CMS-664",
  title: "Search page",
  url: "https://linear.app/ventrata/issue/CMS-664",
  state: states[1],
  team: { states: { nodes: states } },
};
function reply(data: unknown) {
  return { stdout: JSON.stringify({ data }), stderr: "" };
}
function linked(nodes = [{ issue }]) {
  return reply({ attachmentsForURL: { nodes } });
}

const watchedId = "6e22bbbf-7d65-4463-8c1e-9ea7f8914abc";
const otherId = "6e22bbbf-7d65-4463-8c1e-9ea7f8914abd";
const watchedIssue = {
  id: watchedId,
  identifier: "APP-1",
  state: { id: "done", name: "Done" },
};
const otherIssue = { ...watchedIssue, id: otherId, identifier: "APP-2" };
const partialResponse = {
  data: { i0: watchedIssue, i1: null },
  errors: [{ message: "Missing issue", path: ["i1"] }],
};

function failedCommand(stdout: string) {
  return Object.assign(new Error("Linear exited 1 with private arguments"), {
    code: 1,
    killed: false,
    signal: null,
    stdout,
    stderr: "private diagnostics",
  });
}

describe("LinearService", () => {
  it("reads fixed issue IDs in one query and keeps successful aliases on nonzero exit", async () => {
    const command = createCommand(failedCommand(JSON.stringify(partialResponse)));
    const result = await new LinearService({ execCommand: command.execute }).readIssueStates(
      target.cwd,
      [watchedId, otherId, watchedId],
    );
    expect(result).toEqual([
      { id: watchedId, issue: watchedIssue },
      { id: otherId, issue: null },
    ]);
    expect(command.calls).toHaveLength(1);
    expect(command.calls[0][1].join(" ")).not.toContain("attachmentsForURL");
    expect(command.calls[0][1].at(-1)).toBe(JSON.stringify({ id0: watchedId, id1: otherId }));
  });

  it.each(["success", "nonzero"])(
    "keeps healthy aliases and excludes an errored issue with valid-looking data on %s exit",
    async (exit) => {
      const stdout = JSON.stringify({
        data: { i0: watchedIssue, i1: otherIssue },
        errors: [{ message: "State unavailable", path: ["i1", "state", "id"] }],
      });
      const response = exit === "success" ? { stdout, stderr: "" } : failedCommand(stdout);
      const command = createCommand(response);
      const service = new LinearService({ execCommand: command.execute });
      expect(await service.readIssueStates(target.cwd, [watchedId, otherId])).toEqual([
        { id: watchedId, issue: watchedIssue },
        { id: otherId, issue: null },
      ]);
    },
  );

  it("reads all healthy aliases after a successful command", async () => {
    const command = createCommand(reply({ i0: watchedIssue, i1: otherIssue }));
    const service = new LinearService({ execCommand: command.execute });
    expect(await service.readIssueStates(target.cwd, [watchedId, otherId])).toEqual([
      { id: watchedId, issue: watchedIssue },
      { id: otherId, issue: otherIssue },
    ]);
  });

  it.each([
    { name: "timeout", overrides: { killed: true, signal: "SIGKILL" } },
    { name: "signal termination", overrides: { signal: "SIGTERM" } },
    { name: "spawn failure", overrides: { code: "EACCES" } },
    { name: "buffer overflow", overrides: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } },
  ])("rejects $name even when stdout contains partial data", async ({ overrides }) => {
    const failure = Object.assign(failedCommand(JSON.stringify(partialResponse)), overrides);
    const command = createCommand(failure);
    const service = new LinearService({ execCommand: command.execute });
    await expect(service.readIssueStates(target.cwd, [watchedId, otherId])).rejects.toThrow(
      "Linear request failed. Check the host connection and Linear CLI login, then retry",
    );
  });

  it.each([
    { name: "malformed JSON", stdout: "{broken" },
    { name: "empty stdout", stdout: "" },
    {
      name: "authentication failure",
      stdout: JSON.stringify({ data: null, errors: [{ message: "Not authenticated" }] }),
    },
    {
      name: "unattributed error",
      stdout: JSON.stringify({
        data: { i0: watchedIssue },
        errors: [{ message: "Request failed" }],
      }),
    },
    { name: "empty data", stdout: JSON.stringify({ data: {}, errors: partialResponse.errors }) },
    { name: "missing GraphQL errors", stdout: reply({ i0: watchedIssue }).stdout },
    {
      name: "invalid error path",
      stdout: JSON.stringify({
        ...partialResponse,
        errors: [{ message: "Request failed", path: [false] }],
      }),
    },
  ])("rejects nonzero exit with $name", async ({ stdout }) => {
    const command = createCommand(failedCommand(stdout));
    const service = new LinearService({ execCommand: command.execute });
    await expect(service.readIssueStates(target.cwd, [watchedId, otherId])).rejects.toThrow();
  });

  it("never attributes a different issue's state to a watched identity", async () => {
    const command = createCommand(reply({ i0: otherIssue }));
    const service = new LinearService({ execCommand: command.execute });
    expect(await service.readIssueStates(target.cwd, [watchedId])).toEqual([
      { id: watchedId, issue: null },
    ]);
  });

  it("does not recover partial attachment reads from nonzero exits", async () => {
    const stdout = JSON.stringify({
      data: { attachmentsForURL: { nodes: [{ issue }] } },
      errors: [{ message: "Issue unavailable", path: ["attachmentsForURL"] }],
    });
    const command = createCommand(failedCommand(stdout));
    const service = new LinearService({ execCommand: command.execute });
    await expect(service.getIssues(target)).rejects.toThrow("Linear request failed");
  });

  it.each(["success", "nonzero"])("rejects a failed link mutation on %s exit", async (exit) => {
    const stdout = JSON.stringify({
      data: { attachmentCreate: { success: true } },
      errors: [{ message: "Link failed", path: ["attachmentCreate"] }],
    });
    const response = exit === "success" ? { stdout, stderr: "" } : failedCommand(stdout);
    const command = createCommand(reply({ issue: { id: watchedId } }), response);
    const service = new LinearService({ execCommand: command.execute });
    await expect(service.linkIssue({ ...target, identifier: "CMS-664" })).rejects.toThrow();
  });

  it("looks up PR attachments and preserves workflow color and ordered progress", async () => {
    const command = createCommand(linked([{ issue }, { issue }]));
    const service = new LinearService({ execCommand: command.execute });
    const issues = await service.getIssues(target);
    expect(issues).toEqual([
      {
        id: "issue-id",
        identifier: "CMS-664",
        title: "Search page",
        url: issue.url,
        state: { name: "Ready for QA", type: "started", color: "#eb5757", progress: 0.6 },
      },
    ]);
    expect(command.calls[0]).toEqual([
      "linear",
      [
        "api",
        expect.stringContaining("attachmentsForURL"),
        "--variables-json",
        JSON.stringify({ url: target.prUrl }),
      ],
      expect.objectContaining({ cwd: target.cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }),
    ]);
  });

  it("shares pending lookups across clients and caches their result", async () => {
    const command = createCommand(linked(), linked());
    const service = new LinearService({ execCommand: command.execute });
    await Promise.all([service.getIssues(target), service.getIssues(target)]);
    await service.getIssues(target);
    expect(command.calls).toHaveLength(1);
    await service.getIssues({
      ...target,
      prUrl: "https://github.com/ventrata/web-builder/pull/1096",
    });
    expect(command.calls).toHaveLength(2);
  });

  it("returns no issues when a PR has no attachments", async () => {
    const command = createCommand(linked([]));
    expect(await new LinearService({ execCommand: command.execute }).getIssues(target)).toEqual([]);
  });

  it("reports failures and allows a subsequent retry", async () => {
    const command = createCommand(new Error("process failed with private arguments"), linked());
    const service = new LinearService({ execCommand: command.execute });
    await expect(service.getIssues(target)).rejects.toThrow("Linear request failed");
    expect(await service.getIssues(target)).toHaveLength(1);
  });

  it("rejects GraphQL errors instead of treating them as an unlinked PR", async () => {
    const command = createCommand({
      stdout: JSON.stringify({ errors: [{ message: "Issue unavailable" }] }),
      stderr: "",
    });
    await expect(
      new LinearService({ execCommand: command.execute }).getIssues(target),
    ).rejects.toThrow("Issue unavailable");
  });

  it("links the requested issue and invalidates the empty lookup", async () => {
    const command = createCommand(
      linked([]),
      reply({ issue: { id: "issue-id" } }),
      reply({ attachmentCreate: { success: true } }),
      linked(),
    );
    const service = new LinearService({ execCommand: command.execute });
    await service.getIssues(target);
    await service.linkIssue({ ...target, identifier: " cms-664 " });
    expect(await service.getIssues(target)).toHaveLength(1);
    expect(command.calls[1][1].at(-1)).toBe(JSON.stringify({ id: "CMS-664" }));
    expect(command.calls[2][1].at(-1)).toBe(
      JSON.stringify({ issueId: "issue-id", url: target.prUrl }),
    );
  });

  it("does not report success when Linear refuses the link", async () => {
    const command = createCommand(
      reply({ issue: { id: "issue-id" } }),
      reply({ attachmentCreate: { success: false } }),
    );
    await expect(
      new LinearService({ execCommand: command.execute }).linkIssue({
        ...target,
        identifier: "CMS-664",
      }),
    ).rejects.toThrow("Linear did not link the issue");
  });

  it("validates issue identifiers before invoking the CLI", async () => {
    const command = createCommand();
    await expect(
      new LinearService({ execCommand: command.execute }).linkIssue({
        ...target,
        identifier: "CMS-664; echo bad",
      }),
    ).rejects.toThrow("Enter a Linear issue identifier");
    expect(command.calls).toEqual([]);
  });
});
