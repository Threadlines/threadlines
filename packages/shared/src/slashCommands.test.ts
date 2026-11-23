import { describe, expect, it } from "vite-plus/test";

import {
  cleanSlashCommands,
  SLASH_COMMAND_DESCRIPTION_MAX,
  SLASH_COMMANDS_MAX,
  slashCommandAtStart,
} from "./slashCommands.ts";

describe("cleanSlashCommands", () => {
  it("keeps only names a message can start with, each once", () => {
    expect(
      cleanSlashCommands([
        { name: "/compact", description: " Summarize " },
        { name: "compact", description: "again" },
        { name: "foo/bar" },
        { name: "two words" },
        { name: "rtl‮evil" },
        { name: "skill:review", input: { hint: "what" } },
      ]),
    ).toEqual([
      { name: "compact", description: "Summarize" },
      { name: "skill:review", input: { hint: "what" } },
    ]);
  });

  it("caps the count and the text without splitting a character, and drops control characters", () => {
    const many = Array.from({ length: SLASH_COMMANDS_MAX + 50 }, (_, index) => ({
      name: `c${index}`,
    }));
    expect(cleanSlashCommands(many)).toHaveLength(SLASH_COMMANDS_MAX);
    const [long] = cleanSlashCommands([
      { name: "long", description: `a‮${"😀".repeat(SLASH_COMMAND_DESCRIPTION_MAX)}` },
    ]);
    const kept = Array.from(long?.description ?? "");
    expect(kept).toHaveLength(SLASH_COMMAND_DESCRIPTION_MAX);
    expect(kept[0]).toBe("a");
    expect(kept.at(-1)).toBe("…");
    expect(long?.description).not.toContain("‮");
    expect(long?.description?.includes("�")).toBe(false);
  });
});

describe("slashCommandAtStart", () => {
  it("reads a command only at the very start, never a path", () => {
    expect(slashCommandAtStart("/compact")).toBe("compact");
    expect(slashCommandAtStart("/review the diff")).toBe("review");
    expect(slashCommandAtStart(" /compact")).toBeUndefined();
    expect(slashCommandAtStart("/tmp/out.log is empty")).toBeUndefined();
    expect(slashCommandAtStart("see /compact")).toBeUndefined();
  });
});
