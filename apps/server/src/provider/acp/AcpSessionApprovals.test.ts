import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { AcpPermissionRequest } from "./AcpRuntimeModel.ts";
import {
  acpSessionApprovalGrantKey,
  isAcpSessionApprovalGranted,
  splitSafeShellChain,
} from "./AcpSessionApprovals.ts";

const WORKSPACE = ["/repo/project"] as const;

const execRequest = (command: string, cwd?: string): AcpPermissionRequest => ({
  kind: "execute",
  detail: command,
  toolCall: {
    toolCallId: "call_cmd",
    kind: "execute",
    title: command,
    command,
    data: {
      kind: "execute",
      command,
      rawInput: { CommandLine: command, ...(cwd ? { Cwd: cwd } : {}) },
      ...(cwd ? { item: { command, cwd } } : {}),
    },
  },
});

const mcpRequest = (
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
): AcpPermissionRequest => ({
  kind: "other",
  detail: `MCP tool ${server} · ${tool}`,
  toolCall: {
    toolCallId: "call_mcp",
    kind: "other",
    itemType: "mcp_tool_call",
    title: tool,
    detail: `MCP tool ${server} · ${tool}`,
    data: { kind: "other", server, tool, arguments: args },
  },
});

const fileRequest = (
  kind: "edit" | "delete" | "move" | "read",
  paths: ReadonlyArray<string>,
): AcpPermissionRequest => ({
  kind,
  detail: paths.join(", "),
  toolCall: {
    toolCallId: "call_file",
    kind,
    title: `File ${paths[0] ?? ""}`,
    data: {
      kind,
      locations: paths.map((path) => ({ path })),
    },
  },
});

describe("AcpSessionApprovals", () => {
  it("scopes MCP grants to the exact server and tool, with any arguments", () => {
    const grants = new Set<string>();
    const snap1 = mcpRequest("threadlines_browser", "browser_snapshot", { tabId: "t1" });
    const snap2 = mcpRequest("threadlines_browser", "browser_snapshot", { tabId: "t2" });
    const click = mcpRequest("threadlines_browser", "browser_click", { target: "btn" });

    const key = acpSessionApprovalGrantKey(snap1, WORKSPACE, "darwin");
    expect(key).toBeDefined();
    grants.add(key!);

    expect(isAcpSessionApprovalGranted(snap2, grants, WORKSPACE, "darwin")).toBe(true);
    expect(isAcpSessionApprovalGranted(click, grants, WORKSPACE, "darwin")).toBe(false);
  });

  it("generalizes only strictly read-only git and gh subcommands, never mutating forms or exec flags", () => {
    const grants = new Set<string>();
    grants.add(
      acpSessionApprovalGrantKey(execRequest("gh pr view 1073 --json state"), WORKSPACE, "darwin")!,
    );
    grants.add(acpSessionApprovalGrantKey(execRequest("git status"), WORKSPACE, "darwin")!);
    grants.add(acpSessionApprovalGrantKey(execRequest("git branch --list"), WORKSPACE, "darwin")!);
    grants.add(
      acpSessionApprovalGrantKey(
        execRequest("git push --dry-run origin main"),
        WORKSPACE,
        "darwin",
      )!,
    );
    grants.add(acpSessionApprovalGrantKey(execRequest("vp run typecheck"), WORKSPACE, "darwin")!);

    expect(
      isAcpSessionApprovalGranted(
        execRequest("gh pr view 1074 --json body"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(true);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("gh pr view 1074 --web"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("gh pr merge 1073 --squash"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);

    expect(
      isAcpSessionApprovalGranted(execRequest("git status -sb"), grants, WORKSPACE, "darwin"),
    ).toBe(true);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("git -c core.pager=evil status"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("git status --exec-path=/tmp"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("git status --output=/tmp/x"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);

    // Mutating or non-readonly commands require exact matching.
    expect(
      isAcpSessionApprovalGranted(execRequest("git branch -D main"), grants, WORKSPACE, "darwin"),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(execRequest("git push origin main"), grants, WORKSPACE, "darwin"),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(execRequest("vp run typecheck"), grants, WORKSPACE, "darwin"),
    ).toBe(true);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("vp run typecheck --watch"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(execRequest("vp run deploy"), grants, WORKSPACE, "darwin"),
    ).toBe(false);
  });

  it("binds command grants to cwd and refuses truncated or display-only commands", () => {
    const grants = new Set<string>();
    const scratchKey = acpSessionApprovalGrantKey(
      execRequest("rm -rf build", "/tmp/scratch"),
      WORKSPACE,
      "darwin",
    );
    expect(scratchKey).toBeDefined();
    grants.add(scratchKey!);

    expect(
      isAcpSessionApprovalGranted(
        execRequest("rm -rf build", "/tmp/scratch"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(true);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("rm -rf build", "/repo/project"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(execRequest("rm -rf build"), grants, WORKSPACE, "darwin"),
    ).toBe(false);

    // Truncated command text cannot uniquely identify a command.
    expect(
      acpSessionApprovalGrantKey(
        execRequest("echo hello\n\n[Command truncated]"),
        WORKSPACE,
        "darwin",
      ),
    ).toBeUndefined();

    // Display-only detail without `toolCall.command` must not create a command grant.
    const detailOnly: AcpPermissionRequest = {
      kind: "execute",
      detail: "git status",
      toolCall: { toolCallId: "c1", kind: "execute", title: "git status", data: {} },
    };
    expect(acpSessionApprovalGrantKey(detailOnly, WORKSPACE, "darwin")).toBeUndefined();
  });

  it("rejects pipelines and Windows shell splitting, and requires every chain segment to match", () => {
    const grants = new Set<string>();
    grants.add(acpSessionApprovalGrantKey(execRequest("git status"), WORKSPACE, "darwin")!);
    grants.add(acpSessionApprovalGrantKey(execRequest("git diff"), WORKSPACE, "darwin")!);

    expect(
      isAcpSessionApprovalGranted(
        execRequest("git status && git diff"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(true);
    expect(
      isAcpSessionApprovalGranted(
        execRequest("git status && rm -rf /"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    // Pipelines change command semantics and must not be split across grants.
    expect(
      isAcpSessionApprovalGranted(
        execRequest("git status | git diff"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    expect(splitSafeShellChain("git status | cat", "darwin")).toBeUndefined();
    expect(splitSafeShellChain("git status && git diff", "win32")).toBeUndefined();
    // On Windows, prefix generalization and chain splitting are disabled.
    const winGrants = new Set<string>();
    winGrants.add(acpSessionApprovalGrantKey(execRequest("git status"), WORKSPACE, "win32")!);
    expect(
      isAcpSessionApprovalGranted(execRequest("git status -sb"), winGrants, WORKSPACE, "win32"),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(execRequest("git status"), winGrants, WORKSPACE, "win32"),
    ).toBe(true);
    // Metacharacters and redirects are rejected from chain matching.
    expect(
      isAcpSessionApprovalGranted(
        execRequest("git status > /tmp/out"),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isAcpSessionApprovalGranted(
        execRequest('git status "$(whoami)"'),
        grants,
        WORKSPACE,
        "darwin",
      ),
    ).toBe(false);
  });

  it("verifies realpath workspace containment (blocking symlinks) and preserves path whitespace", () => {
    const tempBase = mkdtempSync(join(tmpdir(), "acp-grants-"));
    try {
      const workspace = join(tempBase, "workspace");
      const outside = join(tempBase, "outside");
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      const insideFile = join(workspace, "src", "a.ts");
      const insideNewFile = join(workspace, "src", "nested", "new.ts");
      const escapeLink = join(workspace, "escape");
      writeFileSync(insideFile, "a");
      symlinkSync(outside, escapeLink);

      const grants = new Set<string>();
      const wsKey = acpSessionApprovalGrantKey(fileRequest("edit", [insideFile]), [workspace]);
      expect(wsKey).toBe("file:edit:workspace");
      grants.add(wsKey!);

      // Another file inside workspace (including a not-yet-created one) matches.
      expect(
        isAcpSessionApprovalGranted(fileRequest("edit", [insideNewFile]), grants, [workspace]),
      ).toBe(true);
      // Delete stays separate from edit.
      expect(
        isAcpSessionApprovalGranted(fileRequest("delete", [insideFile]), grants, [workspace]),
      ).toBe(false);
      // Symlink inside workspace pointing outside MUST NOT match the workspace edit grant.
      expect(
        isAcpSessionApprovalGranted(fileRequest("edit", [join(escapeLink, "secret.txt")]), grants, [
          workspace,
        ]),
      ).toBe(false);

      // Trailing whitespace in outside file names is preserved (distinct files).
      const outsideClean = join(outside, "file.txt");
      const outsidePadded = join(outside, "file.txt ");
      grants.add(acpSessionApprovalGrantKey(fileRequest("edit", [outsideClean]), [workspace])!);
      expect(
        isAcpSessionApprovalGranted(fileRequest("edit", [outsideClean]), grants, [workspace]),
      ).toBe(true);
      expect(
        isAcpSessionApprovalGranted(fileRequest("edit", [outsidePadded]), grants, [workspace]),
      ).toBe(false);
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it("suppresses session approval when a revised card has a conflicting kind", () => {
    const revisedEditToExec: AcpPermissionRequest = {
      kind: "edit",
      detail: "rm -rf /",
      toolCall: {
        toolCallId: "call_rev",
        kind: "execute",
        title: "rm -rf /",
        command: "rm -rf /",
        data: {
          kind: "execute",
          command: "rm -rf /",
          locations: [{ path: "/repo/project/src/a.ts" }],
        },
      },
    };
    expect(acpSessionApprovalGrantKey(revisedEditToExec, WORKSPACE)).toBeUndefined();
    const grants = new Set(["file:edit:workspace"]);
    expect(isAcpSessionApprovalGranted(revisedEditToExec, grants, WORKSPACE)).toBe(false);
  });

  it("scopes web fetches by origin and refuses generic untitled tools", () => {
    const grants = new Set<string>();
    const fetch1: AcpPermissionRequest = {
      kind: "fetch",
      toolCall: {
        toolCallId: "f1",
        kind: "fetch",
        title: "Fetch docs",
        data: {
          kind: "fetch",
          rawInput: { url: "https://antigravity.google/docs/permissions.md" },
        },
      },
    };
    const fetch2: AcpPermissionRequest = {
      kind: "fetch",
      toolCall: {
        toolCallId: "f2",
        kind: "fetch",
        title: "Fetch settings",
        data: {
          kind: "fetch",
          rawInput: { url: "https://antigravity.google/docs/settings.md" },
        },
      },
    };
    const fetchOther: AcpPermissionRequest = {
      kind: "fetch",
      toolCall: {
        toolCallId: "f3",
        kind: "fetch",
        title: "Fetch other",
        data: { kind: "fetch", rawInput: { url: "https://evil.example/docs" } },
      },
    };
    grants.add(acpSessionApprovalGrantKey(fetch1, WORKSPACE)!);
    expect(isAcpSessionApprovalGranted(fetch2, grants, WORKSPACE)).toBe(true);
    expect(isAcpSessionApprovalGranted(fetchOther, grants, WORKSPACE)).toBe(false);

    const generic: AcpPermissionRequest = {
      kind: "other",
      toolCall: { toolCallId: "g1", kind: "other", title: "Tool", data: {} },
    };
    expect(acpSessionApprovalGrantKey(generic, WORKSPACE)).toBeUndefined();
  });
});
