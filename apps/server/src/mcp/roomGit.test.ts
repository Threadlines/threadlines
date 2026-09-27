import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeRoomGit, ROOM_DIFF_CHAR_LIMIT } from "./roomGit.ts";

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "room-git-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * A checkout whose own config would run commands if asked to: a text
 * conversion and an external diff, each leaving a marker when it runs.
 */
function hostileCheckout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "room-git-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const markers = {
    textconv: path.join(root, "textconv-ran"),
    external: path.join(root, "external-ran"),
  };
  const script = (name: string, marker: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\ncat "$1"\n`, { mode: 0o755 });
    return file;
  };
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "diff.conv.textconv", script("conv.sh", markers.textconv));
  git(repo, "config", "diff.external", script("ext.sh", markers.external));
  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=conv\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "first\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(repo, "notes.txt"), "first\nsecond\n");
  git(repo, "commit", "-q", "-am", "second");
  return { root, repo, markers };
}

describe("room_diff", () => {
  it.layer(GitLayer)((it) => {
    it.effect("gives its fixed views without running the checkout's conversions", () =>
      Effect.gen(function* () {
        const checkout = hostileCheckout();
        const roomGit = makeRoomGit(yield* GitVcsDriver.GitVcsDriver);
        fs.writeFileSync(path.join(checkout.repo, "fresh.ts"), "export const x = 1;\n");

        const range = yield* roomGit.view({ cwd: checkout.repo, view: "diff", base: "HEAD~1" });
        expect(range.output).toContain("+second");
        expect(range.base).toMatch(/^[0-9a-f]{40}$/);
        const show = yield* roomGit.view({ cwd: checkout.repo, view: "show" });
        expect(show.output).toContain("second");
        const stat = yield* roomGit.view({ cwd: checkout.repo, view: "diff_stat", base: "main~1" });
        expect(stat.output).toContain("notes.txt");
        const log = yield* roomGit.view({ cwd: checkout.repo, view: "log" });
        expect(log.output).toContain("    first");
        const status = yield* roomGit.view({ cwd: checkout.repo, view: "status" });
        expect(status.output).toContain("?? fresh.ts");
        const pending = yield* roomGit.view({ cwd: checkout.repo, view: "diff_stat" });
        expect(pending.output).toContain("fresh.ts");

        expect(fs.existsSync(checkout.markers.textconv)).toBe(false);
        expect(fs.existsSync(checkout.markers.external)).toBe(false);
      }),
    );

    it.effect("never lets a revision or path act as an option or leave the checkout", () =>
      Effect.gen(function* () {
        const checkout = hostileCheckout();
        const roomGit = makeRoomGit(yield* GitVcsDriver.GitVcsDriver);
        const written = path.join(checkout.root, "written");
        const attempts = [
          { view: "diff" as const, base: `--output=${written}` },
          { view: "show" as const, base: `--output=${written}` },
          { view: "log" as const, base: "HEAD --output=x" },
          { view: "show" as const, base: "no-such-branch" },
          { view: "status" as const, path: "../outside" },
          { view: "diff" as const, path: "/etc/passwd" },
          { view: "diff_stat" as const, path: ":(top)" },
        ];
        for (const attempt of attempts) {
          const outcome = yield* roomGit.view({ cwd: checkout.repo, ...attempt }).pipe(
            Effect.map(() => "ran"),
            Effect.catch((error) => Effect.succeed(error.outcome)),
          );
          expect([attempt, outcome]).toEqual([attempt, "refused"]);
        }
        expect(fs.existsSync(written)).toBe(false);
      }),
    );

    it.effect("bounds what it returns, and says so", () =>
      Effect.gen(function* () {
        const checkout = hostileCheckout();
        const roomGit = makeRoomGit(yield* GitVcsDriver.GitVcsDriver);
        fs.writeFileSync(
          path.join(checkout.repo, "big.ts"),
          Array.from({ length: 5_000 }, (_, index) => `export const line${index} = ${index};`).join(
            "\n",
          ),
        );
        git(checkout.repo, "add", "big.ts");
        git(checkout.repo, "commit", "-q", "-m", "big");

        const shown = yield* roomGit.view({ cwd: checkout.repo, view: "show" });
        expect(shown.truncated).toBe(true);
        expect(shown.output.length).toBeLessThan(ROOM_DIFF_CHAR_LIMIT + 100);

        const review = yield* roomGit.captureReviewBasis(checkout.repo, { base: "HEAD~1" });
        expect(review.basis).toMatchObject({ kind: "range", files: 1, truncated: true });
        expect(review.diff.length).toBeLessThan(ROOM_DIFF_CHAR_LIMIT + 100);
      }),
    );
  });
});
