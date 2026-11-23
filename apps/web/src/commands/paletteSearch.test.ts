import { describe, expect, it } from "vite-plus/test";

import {
  matchTier,
  paletteSearch,
  paletteSearchStatus,
  type PlaceSearchEntry,
  type ThreadSearchEntry,
  tierQueryWords,
} from "./paletteSearch";

const thread = (
  title: string,
  options: { branch?: string; messageScore?: number } = {},
): ThreadSearchEntry<string> => ({
  title,
  projectName: "Shop",
  branch: options.branch ?? "",
  messageScore: options.messageScore ?? null,
  value: `thread:${title}`,
});

const place = (
  value: string,
  title: string,
  keywords: ReadonlyArray<string> = [],
  extra: { section?: string; usage?: number } = {},
): PlaceSearchEntry<string> => ({
  fields: {
    title,
    keywords,
    ...(extra.section ? { section: extra.section } : {}),
  },
  order: 0,
  ...(extra.usage !== undefined ? { usage: extra.usage } : {}),
  value,
});

const COMMANDS = [
  place("command:toggle-terminal", "Toggle terminal", ["terminal", "shell"]),
  place("command:connect-agent", "Connect an agent", ["mcp", "terminal"], { usage: 40 }),
];

function search(
  query: string,
  sources: {
    threads?: ReadonlyArray<ThreadSearchEntry<string>>;
    commands?: ReadonlyArray<PlaceSearchEntry<string>>;
    settings?: ReadonlyArray<PlaceSearchEntry<string>>;
    projects?: ReadonlyArray<PlaceSearchEntry<string>>;
    filter?: "all" | "commands";
  },
) {
  return paletteSearch({
    query,
    filter: sources.filter ?? "all",
    threads: sources.threads ?? [],
    commands: sources.commands ?? COMMANDS,
    settings: sources.settings ?? [],
    projects: sources.projects ?? [],
  });
}

/** Each section as "source: value(tier), …". */
function shape(result: ReturnType<typeof search>): string[] {
  return result.sections.map(
    (section) =>
      `${section.source}: ${section.rows.map((row) => `${row.value}(${row.tier})`).join(", ")}`,
  );
}

describe("matchTier", () => {
  it("reads quoted and unquoted queries the same", () => {
    const fields = { title: "Bigger font size" };
    expect(matchTier(tierQueryWords('"font size"'), fields)).toBe(
      matchTier(tierQueryWords("font size"), fields),
    );
  });

  it("puts a word inside a longer title word at the word that starts with it", () => {
    // "term" inside "Longterm" first, but "terminal" starts with it: tier 2.
    expect(matchTier(tierQueryWords("term"), { title: "Longterm terminal" })).toBe(2);
  });
});

describe("paletteSearch", () => {
  it('"terminal" with a thread titled Terminal: the thread, then Toggle terminal', () => {
    expect(shape(search("terminal", { threads: [thread("Terminal")] }))).toEqual([
      "threads: thread:Terminal(0)",
      "commands: command:toggle-terminal(2), command:connect-agent(4)",
    ]);
  });

  it('"term", same data: the thread at tier 1, then commands at tier 2', () => {
    expect(shape(search("term", { threads: [thread("Terminal")] }))).toEqual([
      "threads: thread:Terminal(1)",
      "commands: command:toggle-terminal(2), command:connect-agent(4)",
    ]);
  });

  it('"term" with only "Longterm terminal": a tie at tier 2 goes to Threads', () => {
    expect(shape(search("term", { threads: [thread("Longterm terminal")] }))[0]).toBe(
      "threads: thread:Longterm terminal(2)",
    );
  });

  it('"term" with the word only in a message: Commands first, the thread at tier 6', () => {
    expect(shape(search("term", { threads: [thread("Fix login", { messageScore: 10 })] }))).toEqual(
      [
        "commands: command:toggle-terminal(2), command:connect-agent(4)",
        "threads: thread:Fix login(6)",
      ],
    );
  });

  it("keeps a much-used command found by a keyword below one found by its title", () => {
    const commands = search("term", {}).sections[0]!.rows.map((row) => row.value);
    expect(commands).toEqual(["command:toggle-terminal", "command:connect-agent"]);
  });

  it('"toggle t": Toggle terminal at tier 1', () => {
    expect(shape(search("toggle t", {}))).toEqual(["commands: command:toggle-terminal(1)"]);
  });

  it('"inal ror" finds "Terminal error" at tier 3, below any tier 2', () => {
    expect(
      shape(
        search("inal ror", {
          threads: [thread("Terminal error")],
          commands: [place("command:x", "Inalert rorschach")],
        }),
      ),
    ).toEqual(["commands: command:x(2)", "threads: thread:Terminal error(3)"]);
  });

  it('"payments" finds a thread by its branch at tier 4', () => {
    expect(
      shape(search("payments", { threads: [thread("Checkout bug", { branch: "fix/payments" })] })),
    ).toEqual(["threads: thread:Checkout bug(4)"]);
  });

  it('"dark terminal" finds a setting by keyword and section at tier 5', () => {
    expect(
      shape(
        search("dark terminal", {
          commands: [],
          settings: [place("setting:terminal-theme", "Theme", ["dark"], { section: "Terminal" })],
        }),
      ),
    ).toEqual(["settings: setting:terminal-theme(5)"]);
  });

  it('"font size": the thread with those words, then Text size by keyword', () => {
    const settings = [place("setting:text-size", "Text size", ["font size"])];
    const threads = [thread("Bigger font size in the composer")];
    expect(shape(search("font size", { commands: [], settings, threads }))).toEqual([
      "threads: thread:Bigger font size in the composer(2)",
      "settings: setting:text-size(4)",
    ]);
    // Quoted, the same tiers.
    expect(shape(search('"font size"', { commands: [], settings, threads }))).toEqual(
      shape(search("font size", { commands: [], settings, threads })),
    );
  });

  it("never puts a message match above a title match in its section", () => {
    const rows = search("deploy", {
      commands: [],
      threads: [thread("Release notes", { messageScore: 0 }), thread("Deploy staging")],
    }).sections[0]!.rows;
    expect(rows.map((row) => row.value)).toEqual(["thread:Deploy staging", "thread:Release notes"]);
  });

  it("orders commands of one tier by use on this device", () => {
    const rows = search("open", {
      commands: [
        place("command:open-usage", "Open usage", [], { usage: 1 }),
        place("command:open-fleet", "Open fleet", [], { usage: 9 }),
      ],
    }).sections[0]!.rows;
    expect(rows.map((row) => row.value)).toEqual(["command:open-fleet", "command:open-usage"]);
  });

  it("offers close matches only when nothing matched, and only from three letters", () => {
    const commands = [place("command:settings", "Open settings")];
    expect(search("stngs", { commands }).closeMatches).toEqual(["command:settings"]);
    expect(search("st", { commands }).closeMatches).toEqual([]);
    // Digits aren't letters: "k12" has one.
    expect(
      search("k12", { commands: [place("command:task", "Run task1v2")] }).closeMatches,
    ).toEqual([]);
    // "open" matches, so there is nothing to offer instead.
    expect(search("open", { commands }).closeMatches).toEqual([]);
  });

  it("searches only commands behind the > filter", () => {
    expect(shape(search("term", { filter: "commands", threads: [thread("Terminal")] }))).toEqual([
      "commands: command:toggle-terminal(2), command:connect-agent(4)",
    ]);
  });

  it("matches commands by word starts: phone doesn't find microphone", () => {
    const commands = [place("command:dictate", "Dictate", ["microphone"])];
    expect(search("phone", { commands }).sections).toEqual([]);
    expect(search("micro", { commands }).sections).toHaveLength(1);
  });
});

describe("paletteSearchStatus", () => {
  const answered = { computerName: "Studio Mac", outcome: "answered" as const };

  it("keeps searching, and never says No matches, until this text's answer is in", () => {
    expect(
      paletteSearchStatus({
        searchesMessages: true,
        answeredCurrentText: false,
        outcomes: [],
        rowCount: 0,
      }),
    ).toEqual({ searching: true, noMatches: false, lines: [] });
    expect(
      paletteSearchStatus({
        searchesMessages: true,
        answeredCurrentText: true,
        outcomes: [answered],
        rowCount: 0,
      }),
    ).toEqual({ searching: false, noMatches: true, lines: [] });
  });

  it("names each computer that failed or stopped early, and only for this text's answer", () => {
    const outcomes = [
      answered,
      { computerName: "Laptop", outcome: "failed" as const },
      { computerName: "Build box", outcome: "stoppedEarly" as const },
    ];
    expect(
      paletteSearchStatus({
        searchesMessages: true,
        answeredCurrentText: true,
        outcomes,
        rowCount: 3,
      }).lines,
    ).toEqual([
      "Couldn't search Laptop",
      "The search on Build box may be incomplete. Add a word to narrow it.",
    ]);
    expect(
      paletteSearchStatus({
        searchesMessages: true,
        answeredCurrentText: false,
        outcomes,
        rowCount: 3,
      }).lines,
    ).toEqual([]);
  });

  it("doesn't wait for messages on text too short to search them", () => {
    expect(
      paletteSearchStatus({
        searchesMessages: false,
        answeredCurrentText: false,
        outcomes: [],
        rowCount: 0,
      }),
    ).toEqual({ searching: false, noMatches: true, lines: [] });
  });
});
