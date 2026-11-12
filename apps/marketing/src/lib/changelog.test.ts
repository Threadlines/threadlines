import { describe, expect, it } from "vite-plus/test";

import { sortChangelogEntries, type ChangelogEntry } from "./changelog";

const release = (version: string, date: string) =>
  ({ id: `v${version}`, data: { version, date: new Date(date) } }) as ChangelogEntry;

describe("sortChangelogEntries", () => {
  it("lists a fix shipped the same day above the release it fixes", () => {
    const sorted = sortChangelogEntries([
      release("0.10.1", "2026-11-12"),
      release("0.9.0", "2026-11-05"),
      release("0.10.0", "2026-11-12"),
    ]);

    expect(sorted.map((entry) => entry.data.version)).toEqual(["0.10.1", "0.10.0", "0.9.0"]);
    expect(
      sortChangelogEntries([release("0.10.0", "2026-11-12"), release("0.10.1", "2026-11-12")])[0]
        ?.data.version,
    ).toBe("0.10.1");
  });
});
