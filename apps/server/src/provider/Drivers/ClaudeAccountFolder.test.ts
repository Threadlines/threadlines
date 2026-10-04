import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { materializeClaudeAccountFolder } from "./ClaudeAccountFolder.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tl-claude-account-" });
  const mainDir = path.join(root, "main");
  const accountDir = path.join(root, "accounts", "work");
  yield* fileSystem.makeDirectory(mainDir, { recursive: true });
  return { fileSystem, path, root, mainDir, accountDir };
});

it.layer(NodeServices.layer)("materializeClaudeAccountFolder", (it) => {
  it.effect("shares config and history with the main folder and keeps the login private", () =>
    Effect.gen(function* () {
      const { fileSystem, path, root, mainDir, accountDir } = yield* setup;
      // The user's settings are themselves a link into a dotfiles repo.
      const dotfiles = path.join(root, "dotfiles-settings.json");
      yield* fileSystem.writeFileString(dotfiles, "{}");
      yield* fileSystem.symlink(dotfiles, path.join(mainDir, "settings.json"));
      yield* fileSystem.writeFileString(path.join(mainDir, "CLAUDE.md"), "be terse");
      yield* fileSystem.writeFileString(path.join(mainDir, ".credentials.json"), "main-login");
      yield* fileSystem.writeFileString(path.join(mainDir, ".claude.json"), "{}");

      const result = yield* materializeClaudeAccountFolder({ mainDir, accountDir });

      expect(result.sharesMainHistory).toBe(true);
      expect(yield* fileSystem.readLink(path.join(accountDir, "projects"))).toBe(
        path.join(mainDir, "projects"),
      );
      // Shared folders exist in the main folder before the account can write any.
      expect(yield* fileSystem.exists(path.join(mainDir, "file-history"))).toBe(true);
      expect(yield* fileSystem.readFileString(path.join(accountDir, "CLAUDE.md"))).toBe("be terse");
      // Linked by path, so editing the dotfile still reaches every account.
      expect(yield* fileSystem.readLink(path.join(accountDir, "settings.json"))).toBe(
        path.join(mainDir, "settings.json"),
      );
      expect(yield* fileSystem.exists(path.join(accountDir, ".credentials.json"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(accountDir, ".claude.json"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the account's own copies and stops claiming shared history", () =>
    Effect.gen(function* () {
      const { fileSystem, path, mainDir, accountDir } = yield* setup;
      yield* fileSystem.makeDirectory(path.join(accountDir, "projects"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(accountDir, "projects", "mine.jsonl"), "x");
      yield* fileSystem.writeFileString(path.join(mainDir, "CLAUDE.md"), "main");
      yield* fileSystem.writeFileString(path.join(accountDir, "CLAUDE.md"), "account");

      const result = yield* materializeClaudeAccountFolder({ mainDir, accountDir });

      expect(result.sharesMainHistory).toBe(false);
      expect(
        yield* fileSystem.readFileString(path.join(accountDir, "projects", "mine.jsonl")),
      ).toBe("x");
      expect(yield* fileSystem.readFileString(path.join(accountDir, "CLAUDE.md"))).toBe("account");
    }).pipe(Effect.scoped),
  );

  it.effect("removes a link that would share the main login", () =>
    Effect.gen(function* () {
      const { fileSystem, path, mainDir, accountDir } = yield* setup;
      yield* fileSystem.writeFileString(path.join(mainDir, ".credentials.json"), "main-login");
      yield* fileSystem.makeDirectory(accountDir, { recursive: true });
      yield* fileSystem.symlink(
        path.join(mainDir, ".credentials.json"),
        path.join(accountDir, ".credentials.json"),
      );

      yield* materializeClaudeAccountFolder({ mainDir, accountDir });

      expect(yield* fileSystem.exists(path.join(accountDir, ".credentials.json"))).toBe(false);
      expect(yield* fileSystem.readFileString(path.join(mainDir, ".credentials.json"))).toBe(
        "main-login",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("leaves links the user made in a folder they chose", () =>
    Effect.gen(function* () {
      const { fileSystem, path, root, mainDir, accountDir } = yield* setup;
      const ownSettings = path.join(root, "work-dotfiles-settings.json");
      yield* fileSystem.writeFileString(ownSettings, "{}");
      yield* fileSystem.writeFileString(path.join(mainDir, "settings.json"), "{}");
      yield* fileSystem.makeDirectory(accountDir, { recursive: true });
      yield* fileSystem.symlink(ownSettings, path.join(accountDir, "settings.json"));

      yield* materializeClaudeAccountFolder({ mainDir, accountDir });

      expect(yield* fileSystem.readLink(path.join(accountDir, "settings.json"))).toBe(ownSettings);
    }).pipe(Effect.scoped),
  );
});
