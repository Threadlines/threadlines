import { spawnSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  type OrchestrationSecretRequest,
  SecretRequestId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeSecretDestinations, type RunGit, threadKeyOf } from "./secretDestinations.ts";

const posix = process.platform !== "win32";

const runGit: RunGit = (cwd, args) =>
  Effect.sync(() => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return result.error === undefined
      ? { code: result.status, stdout: result.stdout, stderr: result.stderr }
      : null;
  });

let home: string;
let project: string;

const git = (...args: string[]) => {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
};

const destinations = () =>
  makeSecretDestinations({ agentSecretsDir: NodePath.join(home, "agent-secrets"), runGit });

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

const REQUEST_ID = SecretRequestId.make("4f1c2e8a-0b7d-4c7e-9a1f-3d2b6c5e8f10");

const envRequest = (bound: {
  readonly folder: string;
  readonly parent: string;
  readonly path?: string;
}): OrchestrationSecretRequest => ({
  requestId: REQUEST_ID,
  participantId: null,
  turnId: TurnId.make("turn-1"),
  name: "STRIPE_SECRET_KEY",
  reason: "To run the checkout tests.",
  use: { kind: "env_file", path: bound.path ?? ".env.local" },
  replaces: false,
  folder: bound.folder,
  parent: bound.parent,
  status: "claimed",
  createdAt: "2026-11-18T10:00:00.000Z",
  noted: false,
});

beforeEach(() => {
  home = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "secret-dest-")));
  project = NodePath.join(home, "project");
  NodeFs.mkdirSync(project);
  git("init", "-q");
  NodeFs.writeFileSync(NodePath.join(project, ".gitignore"), ".env.local\nconfig/.env\n");
});

afterEach(() => {
  NodeFs.rmSync(home, { recursive: true, force: true });
});

describe("env files", () => {
  it("binds an ignored file to its real folders, and says when the name is already there", async () => {
    NodeFs.writeFileSync(NodePath.join(project, ".env.local"), "OTHER=1\nSTRIPE_SECRET_KEY=old\n");
    const checked = await run(
      destinations().checkEnvFile({
        threadFolder: project,
        path: ".env.local",
        name: "STRIPE_SECRET_KEY",
      }),
    );
    expect(checked).toMatchObject({
      _tag: "Success",
      success: { folder: project, parent: project, replaces: true },
    });
  });

  it("refuses a file git doesn't ignore, and one git tracks", async () => {
    const notIgnored = await run(
      destinations().checkEnvFile({ threadFolder: project, path: ".env", name: "KEY" }),
    );
    expect(notIgnored).toMatchObject({ _tag: "Failure" });
    expect(notIgnored._tag === "Failure" && notIgnored.failure.detail).toContain(".gitignore");

    NodeFs.writeFileSync(NodePath.join(project, ".env.local"), "A=1\n");
    git("add", "-f", ".env.local");
    const tracked = await run(
      destinations().checkEnvFile({ threadFolder: project, path: ".env.local", name: "KEY" }),
    );
    expect(tracked._tag === "Failure" && tracked.failure.detail).toContain("tracked by git");
  });

  it("allows any env file outside a repository", async () => {
    const plain = NodePath.join(home, "plain");
    NodeFs.mkdirSync(plain);
    const checked = await run(
      destinations().checkEnvFile({ threadFolder: plain, path: ".env", name: "KEY" }),
    );
    expect(checked._tag).toBe("Success");
  });

  it.skipIf(!posix)(
    "refuses a link, and a parent folder that leads outside the thread's folder",
    async () => {
      const outside = NodePath.join(home, "outside");
      NodeFs.mkdirSync(outside);
      NodeFs.writeFileSync(NodePath.join(outside, ".env"), "");
      NodeFs.symlinkSync(NodePath.join(outside, ".env"), NodePath.join(project, ".env.local"));
      const link = await run(
        destinations().checkEnvFile({ threadFolder: project, path: ".env.local", name: "KEY" }),
      );
      expect(link._tag === "Failure" && link.failure.detail).toContain("isn't a plain file");

      NodeFs.symlinkSync(outside, NodePath.join(project, "config"));
      const escaped = await run(
        destinations().checkEnvFile({ threadFolder: project, path: "config/.env", name: "KEY" }),
      );
      expect(escaped._tag === "Failure" && escaped.failure.detail).toContain("isn't inside");
    },
  );

  it.skipIf(!posix)(
    "writes by rename: other lines and the file's mode stay, a hard link elsewhere keeps the old text",
    async () => {
      const target = NodePath.join(project, ".env.local");
      NodeFs.writeFileSync(target, "OTHER=1\nSTRIPE_SECRET_KEY=old\n");
      NodeFs.chmodSync(target, 0o640);
      const elsewhere = NodePath.join(home, "linked-copy");
      NodeFs.linkSync(target, elsewhere);

      const wrote = await run(
        destinations().writeEnvFile({
          request: envRequest({ folder: project, parent: project }),
          threadFolder: project,
          written: "sk_test_new",
        }),
      );

      expect(wrote._tag).toBe("Success");
      expect(NodeFs.readFileSync(target, "utf8")).toBe("OTHER=1\nSTRIPE_SECRET_KEY=sk_test_new\n");
      expect(NodeFs.statSync(target).mode & 0o777).toBe(0o640);
      expect(NodeFs.readFileSync(elsewhere, "utf8")).toBe("OTHER=1\nSTRIPE_SECRET_KEY=old\n");
      expect(NodeFs.readdirSync(project).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.skipIf(!posix)("makes a new file owner-only", async () => {
    await run(
      destinations().writeEnvFile({
        request: envRequest({ folder: project, parent: project }),
        threadFolder: project,
        written: "sk_test_new",
      }),
    );
    const target = NodePath.join(project, ".env.local");
    expect(NodeFs.readFileSync(target, "utf8")).toBe("STRIPE_SECRET_KEY=sk_test_new\n");
    expect(NodeFs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("writes nothing when the thread's folder changed, or the file became tracked, since the agent asked", async () => {
    const other = NodePath.join(home, "other-checkout");
    NodeFs.mkdirSync(other);
    const moved = await run(
      destinations().writeEnvFile({
        request: envRequest({ folder: other, parent: other }),
        threadFolder: project,
        written: "sk_test_new",
      }),
    );
    expect(moved._tag === "Failure" && moved.failure.detail).toContain("folder changed");

    NodeFs.writeFileSync(NodePath.join(project, ".env.local"), "A=1\n");
    git("add", "-f", ".env.local");
    const tracked = await run(
      destinations().writeEnvFile({
        request: envRequest({ folder: project, parent: project }),
        threadFolder: project,
        written: "sk_test_new",
      }),
    );
    expect(tracked._tag === "Failure" && tracked.failure.detail).toContain("tracked by git");
    expect(NodeFs.readFileSync(NodePath.join(project, ".env.local"), "utf8")).toBe("A=1\n");
  });
});

describe("env files in a repository", () => {
  it("writes its temp copy inside git's own folder, where no checkpoint's `git add` can pick it up", async () => {
    const store = destinations();
    const request = envRequest({ folder: project, parent: project });
    await run(store.writeEnvFile({ request, threadFolder: project, written: "sk_test_new" }));
    expect(NodeFs.readdirSync(project).toSorted()).toEqual([".env.local", ".git", ".gitignore"]);
    const saves = NodePath.join(project, ".git", "threadlines-secret-saves");
    expect(NodeFs.existsSync(saves)).toBe(true);

    const leftover = NodePath.join(saves, `${REQUEST_ID}.tmp`);
    NodeFs.writeFileSync(leftover, "STRIPE_SECRET_KEY=half\n");
    await run(store.removeEnvTemp(request));
    expect(NodeFs.existsSync(leftover)).toBe(false);
  });

  it("checks git where the file is: a tracked file in a repository nested in a plain folder is refused", async () => {
    const plain = NodePath.join(home, "plain");
    const nested = NodePath.join(plain, "nested");
    NodeFs.mkdirSync(nested, { recursive: true });
    spawnSync("git", ["-C", nested, "init", "-q"]);
    NodeFs.writeFileSync(NodePath.join(nested, ".env.local"), "A=1\n");
    spawnSync("git", ["-C", nested, "add", ".env.local"]);
    const checked = await run(
      destinations().checkEnvFile({ threadFolder: plain, path: "nested/.env.local", name: "KEY" }),
    );
    expect(checked._tag === "Failure" && checked.failure.detail).toContain("tracked by git");
  });
});

describe("files for commands", () => {
  const threadId = ThreadId.make("thread/../../escape");

  it.skipIf(!posix)(
    "keeps the value as typed in an owner-only file inside agent-secrets",
    async () => {
      const value = "  -----BEGIN KEY-----\nabc\n-----END KEY-----";
      const written = await run(
        destinations().writeCommandsFile({ threadId, requestId: REQUEST_ID, written: value }),
      );
      expect(written._tag).toBe("Success");
      const path = written._tag === "Success" ? written.success : "";
      const root = NodePath.join(home, "agent-secrets");
      expect(path).toBe(NodePath.join(root, threadKeyOf(threadId), REQUEST_ID, "value"));
      expect(NodeFs.readFileSync(path, "utf8")).toBe(value);
      expect(NodeFs.statSync(path).mode & 0o777).toBe(0o600);
      expect(NodeFs.statSync(NodePath.dirname(path)).mode & 0o777).toBe(0o700);
      expect(NodeFs.statSync(root).mode & 0o777).toBe(0o700);
      // A thread id is hashed, so `..` in it never names a folder.
      expect(NodeFs.readdirSync(home).toSorted()).toEqual(["agent-secrets", "project"]);
    },
  );

  it.skipIf(!posix)(
    "never deletes through a link put in place of agent-secrets or a thread's folder",
    async () => {
      const elsewhere = NodePath.join(home, "elsewhere");
      NodeFs.mkdirSync(NodePath.join(elsewhere, "keep-me"), { recursive: true });
      NodeFs.writeFileSync(NodePath.join(elsewhere, "keep-me", "value"), "not ours");

      // agent-secrets itself is a link: nothing behind it is cleaned up or written.
      NodeFs.symlinkSync(elsewhere, NodePath.join(home, "agent-secrets"));
      const linkedRoot = destinations();
      await run(linkedRoot.removeThreadFoldersExcept(new Set()));
      await run(linkedRoot.sweep(Date.now() + 48 * 60 * 60 * 1000));
      const refused = await run(
        linkedRoot.writeCommandsFile({ threadId, requestId: REQUEST_ID, written: "v" }),
      );
      expect(refused._tag).toBe("Failure");
      expect(NodeFs.readFileSync(NodePath.join(elsewhere, "keep-me", "value"), "utf8")).toBe(
        "not ours",
      );

      // A thread's folder is a link: removing a key through it touches nothing outside.
      NodeFs.unlinkSync(NodePath.join(home, "agent-secrets"));
      NodeFs.mkdirSync(NodePath.join(home, "agent-secrets"));
      NodeFs.symlinkSync(elsewhere, NodePath.join(home, "agent-secrets", threadKeyOf(threadId)));
      NodeFs.symlinkSync(NodePath.join(elsewhere, "keep-me"), NodePath.join(elsewhere, REQUEST_ID));
      const store = destinations();
      expect(await run(store.removeCommandsFile(threadId, REQUEST_ID))).toMatchObject({
        _tag: "Success",
        success: false,
      });
      await run(store.sweep(Date.now() + 48 * 60 * 60 * 1000));
      expect(NodeFs.existsSync(NodePath.join(elsewhere, REQUEST_ID))).toBe(true);
      expect(NodeFs.readFileSync(NodePath.join(elsewhere, "keep-me", "value"), "utf8")).toBe(
        "not ours",
      );
    },
  );

  it("refuses a request id that isn't a UUID", async () => {
    const written = await run(
      destinations().writeCommandsFile({ threadId, requestId: "../../x", written: "v" }),
    );
    expect(written._tag).toBe("Failure");
    expect(NodeFs.existsSync(NodePath.join(home, "x"))).toBe(false);
  });

  it("removes one file, a thread's folder, and orphans past their lifetime", async () => {
    const store = destinations();
    const other = SecretRequestId.make("9e0d1c2b-3a4f-4e5d-8c7b-6a5f4e3d2c1b");
    await run(store.writeCommandsFile({ threadId, requestId: REQUEST_ID, written: "one" }));
    await run(store.writeCommandsFile({ threadId, requestId: other, written: "two" }));
    const threadFolder = NodePath.join(home, "agent-secrets", threadKeyOf(threadId));

    await run(store.removeCommandsFile(threadId, REQUEST_ID));
    expect(NodeFs.readdirSync(threadFolder)).toEqual([other]);

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    NodeFs.utimesSync(NodePath.join(threadFolder, other, "value"), old, old);
    await run(store.sweep(Date.now()));
    expect(NodeFs.existsSync(threadFolder)).toBe(false);

    await run(store.writeCommandsFile({ threadId, requestId: REQUEST_ID, written: "three" }));
    await run(store.removeThreadFolder(threadId));
    expect(NodeFs.existsSync(threadFolder)).toBe(false);
  });
});
