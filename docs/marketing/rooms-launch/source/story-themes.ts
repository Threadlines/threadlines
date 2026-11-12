// The themes promo story (0.10.0), one take:
//
// 1. The new-thread screen, with each starter's art behind it in turn
//    (switched directly, Glass a little clearer than the themes' own): the
//    edit cuts these together.
// 2. In a thread you type /theme, arrow to Lantern Lake and keep it.
// 3. You ask Opus 5.5 for a theme from a page you link. It offers Honu
//    Lagoon; you click Try it, then Keep.
// 4. You ask for bolder text, it shows a new version, and you click Update.
// 5. /theme again, and the Glass slider goes most of the way to Clear.
// 6. Settings › Appearance: you share your own theme, Speedcube, to the
//    Showcase, switch to it, and go back to the thread.
//
// The picker, the trial, the library and the Share dialog are the app's own.
// Scripted: the agent's turns (as in every story here), the offered theme's
// files (read from PROMO_THEMES_DIR instead of the server's page store), and
// the publish step of the share (no pull request is opened; the dialog gets
// the receipt a real one returns).
//
// Honu Lagoon is after @handsher_NGU's "honu lagoon" (honu-lagoon.vercel.app);
// the prompt on screen names it and the edit credits it. It is not in the
// repo: pass the folder holding `honu-v1.json`, `honu-v2.json` (the version
// with bolder text) and `speedcube.json` (theme files) as PROMO_THEMES_DIR.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { createEngine } from "./engine.ts";

type Json = Record<string, any>;
type Engine = ReturnType<typeof createEngine>;

export interface ThemesUi {
  mark(name: string): void;
  sleep(ms: number): Promise<void>;
  send(text: string): Promise<{ messageId: string }>;
  track(name: string, messageId: string, part?: "row" | "body" | "end"): void;
  trackSelector(name: string, selector: string, closest?: string): void;
  /** Runs `fn` in the app's page. */
  evaluate<T>(fn: (arg: any) => T | Promise<T>, arg?: unknown): Promise<T>;
  /** Moves the pointer to the last element matching `selector` and clicks it. */
  clickOn(selector: string, options?: { hover?: number; hold?: number }): Promise<void>;
  /** Moves the pointer onto an element without clicking. */
  hoverOn(selector: string): Promise<void>;
  /** Presses on `thumb` and drags it to `to` (0 to 1) along `track`. */
  dragAlong(thumb: string, track: string, to: number): Promise<void>;
  type(text: string, delay?: number): Promise<void>;
  press(key: string): Promise<void>;
  focusComposer(): Promise<void>;
  /** Takes focus (and its blinking caret) out of the page. */
  blur(): Promise<void>;
  /** While on, nothing but the art repaints, so every captured frame is the art's. */
  steady(on: boolean): Promise<void>;
  /** Fades the pointer out and parks the mouse on the message box. */
  rest(): Promise<void>;
  until(label: string, predicate: () => Promise<boolean>): Promise<void>;
  openThread(id: string, kind: "child" | "parent"): Promise<void>;
  narrow: boolean;
}

export const OPUS = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
export const THREAD_TITLE = "Pay button ignores extra clicks";
/** The engine is the only server for the thread: the story leaves it and comes back. */
export const NEEDS_CHILD_WRAP_UP = false;
/** Recorded as the app is in front of other apps: art at its own rate. */
export const IN_FRONT = true;
export const EARLIER_PROMPT =
  "Make the pay button ignore extra clicks while a payment is in progress.";
// No "@" before the name: in the message box that opens the file-mention menu.
export const THEME_PROMPT =
  "Make a theme from honu-lagoon.vercel.app, the text-art lagoon by handsher_NGU.";
export const THEME_REPLY =
  "Here's Honu Lagoon, after the original: sea turtles, a manta and a humpback over the reef.";
export const TWEAK_PROMPT = "Love it. Make the text a little bolder so it's easier to read.";
export const TWEAK_REPLY = "Done. The text is bolder and darker now.";
export const CREDIT = "Threadlines";
const LOGIN = "Badcuban";

/** The starters the opening shows, in order, and the seconds of art recorded for each. */
export const MONTAGE: ReadonlyArray<readonly [id: string, seconds: number]> = [
  ["lantern-lake", 5],
  ["aurora", 5],
  ["meadow", 5],
  ["snowfield", 5],
  ["tokyo-rain", 6.5],
];
/** The opening's spans of art alone: encode-take.py spaces their frames evenly. */
export const STEADY_MARKS = MONTAGE.map(([starter]) => [`art-${starter}-in`, `art-${starter}-out`]);
/** Glass for the opening: clearer than the themes' own (50), so the art reads. */
const MONTAGE_GLASS = Number(process.env.PROMO_MONTAGE_GLASS ?? 80);
/** The starters after Dark in the strip, in its order, and how long each holds. */
const STRIP: ReadonlyArray<readonly [id: string, holdMs: number]> = [
  ["aurora", 1900],
  ["lantern-lake", 3600],
];

const id = (prefix: string) => `${prefix}:${randomUUID()}`;
const ORBIT = "/Users/Shared/Threadlines Marketing Studio/Orbit";

const themesDir = process.env.PROMO_THEMES_DIR ?? "";
const themeFile = (name: string): Json => {
  if (themesDir === "") throw new Error("Set PROMO_THEMES_DIR to the folder with the theme files.");
  const manifest = JSON.parse(fs.readFileSync(path.join(themesDir, `${name}.json`), "utf8"));
  // Which thread made a theme never leaves the computer that made it.
  delete manifest.createdBy;
  return manifest;
};

export function createStory(input: { engine: Engine; threadId: string; ui: ThemesUi }) {
  const { engine, threadId, ui } = input;
  let clockOffsetMs = 0;
  const iso = (offsetMs = 0) => new Date(Date.now() + clockOffsetMs + offsetMs).toISOString();
  const command = (type: string, fields: Json) =>
    engine.run({ type, commandId: id("promo"), threadId, createdAt: iso(), ...fields });

  const session = (status: string, turnId: string | null) =>
    command("thread.session.set", {
      session: {
        threadId,
        status,
        providerName: "claudeAgent",
        providerInstanceId: "claudeAgent",
        providerSessionId: "promo-claudeAgent",
        providerThreadId: "promo-claudeAgent-thread",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        participantId: null,
        pendingBackgroundTaskCount: 0,
        lastError: null,
        updatedAt: iso(),
      },
    });

  const stream = async (messageId: string, text: string, turnId: string, cps = 75) => {
    let at = 0;
    while (at < text.length) {
      const size = 2 + Math.floor(Math.random() * 3);
      const chunk = text.slice(at, at + size);
      at += size;
      await command("thread.message.assistant.delta", { messageId, delta: chunk, turnId });
      await ui.sleep((chunk.length / cps) * 1000);
    }
  };

  type Tool =
    | { kind: "read"; path: string }
    | { kind: "run"; command: string }
    | { kind: "edit"; path: string; oldString: string; newString: string }
    | { kind: "fetch"; url: string }
    | { kind: "mcp"; tool: string };

  const tool = async (turnId: string, call: Tool, ms = 700) => {
    const toolCallId = id("toolu");
    const payload = (status: string): Json => {
      switch (call.kind) {
        case "read":
          return {
            itemType: "dynamic_tool_call",
            toolCallId,
            status,
            title: "Read file",
            detail: call.path,
            data: { toolName: "Read", input: { file_path: `${ORBIT}/${call.path}` } },
          };
        case "run":
          return {
            itemType: "command_execution",
            toolCallId,
            status,
            title: "Command run",
            detail: call.command,
            data: { toolName: "Bash", input: { command: call.command } },
          };
        case "edit":
          return {
            itemType: "file_change",
            toolCallId,
            status,
            title: "File change",
            detail: call.path,
            data: {
              toolName: "Edit",
              input: {
                file_path: `${ORBIT}/${call.path}`,
                old_string: call.oldString,
                new_string: call.newString,
              },
            },
          };
        case "fetch":
          return {
            itemType: "dynamic_tool_call",
            toolCallId,
            status,
            title: "Web fetch",
            detail: call.url,
            data: { toolName: "WebFetch", input: { url: `https://${call.url}` } },
          };
        case "mcp":
          return {
            itemType: "mcp_tool_call",
            toolCallId,
            status,
            title: "MCP tool call",
            detail: call.tool,
            data: { toolName: call.tool, input: {} },
          };
      }
    };
    const append = (kind: string, status: string, summary: string) =>
      command("thread.activity.append", {
        activity: {
          id: id("activity"),
          tone: "tool",
          kind,
          summary,
          payload: payload(status),
          turnId,
          createdAt: iso(),
        },
      });
    const title = payload("inProgress").title as string;
    await append("tool.started", "inProgress", `${title} started`);
    await ui.sleep(ms);
    await append("tool.completed", "completed", title);
  };

  let checkpointTurnCount = 0;
  const completeTurn = async (
    turnId: string,
    lastMessageId: string,
    files: ReadonlyArray<Json>,
  ) => {
    await command("thread.message.assistant.complete", {
      messageId: lastMessageId,
      turnId,
      completesTurn: true,
    });
    checkpointTurnCount += 1;
    await command("thread.turn.diff.complete", {
      turnId,
      completedAt: iso(),
      checkpointRef: `refs/threadlines/promo/${checkpointTurnCount}`,
      status: "ready",
      files,
      assistantMessageId: lastMessageId,
      checkpointTurnCount,
      completesTurn: true,
    });
    await session("ready", null);
  };

  // The offered theme: one page, shown twice (the second after a small ask).
  const pageId = `page-${randomUUID()}`;
  const versions = [`version-${randomUUID()}`, `version-${randomUUID()}`] as const;
  const publish = (turnId: string, version: 1 | 2) =>
    command("thread.page.publish", {
      page: {
        pageId,
        versionId: versions[version - 1],
        version,
        turnId,
        participantId: null,
        title: "Honu Lagoon",
        kind: "theme",
        height: 80,
      },
    });

  /** The theme showing now, as the app names it: a starter's id or a theme's name. */
  const shownTheme = () =>
    ui.evaluate(async () => {
      const store = await import("/src/theme/themeStore.ts" as string);
      const active = store.readActiveTheme();
      return {
        name: (active.choice.id ?? active.manifest?.name ?? active.choice.name ?? "") as string,
        trial: store.readThemeState().trial !== null,
      };
    });
  const untilTheme = (name: string) =>
    ui.until(`${name} to show`, async () => (await shownTheme()).name === name);

  /** The studio as the take needs it: Dark showing, Speedcube kept, Honu Lagoon not. */
  const dressStudio = async () => {
    // What show_theme records on a theme: the offer it is, so a later
    // version updates the copy kept from an earlier one.
    const createdBy = { kind: "agent", threadId, offer: { threadId, pageId } };
    const honu = { ...themeFile("honu-v1"), createdBy };
    const offered = Object.fromEntries(
      (["honu-v1", "honu-v2"] as const).map((file, index) => [
        versions[index],
        JSON.stringify({ ...themeFile(file), createdBy }),
      ]),
    );
    const speedcube = themeFile("speedcube");
    await ui.evaluate(
      async ({ honu, speedcube, pageId, offered, login }: Json) => {
        const [library, store, apiModule, runtime, { useStore }, settings] = await Promise.all([
          import("/src/themeLibrary/themeLibraryState.ts" as string),
          import("/src/theme/themeStore.ts" as string),
          import("/src/environmentApi.ts" as string),
          import("/src/environments/runtime/service.ts" as string),
          import("/src/store.ts" as string),
          import("/src/hooks/useSettings.ts" as string),
        ]);
        const env = useStore.getState().activeEnvironmentId;
        // Glass back at the theme's own: the take moves it.
        await settings.updateSettingsAndPersist({ themeGlass: 50 });
        const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const trial = store.readThemeState().trial;
        if (trial !== null) store.endThemeTrial(trial.id);
        for (const kept of library.currentLibraryThemes()) {
          if (kept.entry.name === honu.name) await library.deleteLibraryTheme(kept.entry.entryId);
        }
        if (
          !library.currentLibraryThemes().some((kept: any) => kept.entry.name === speedcube.name)
        ) {
          await library.saveThemeToLibrary(speedcube, speedcube.name);
          await settle(1500);
        }
        store.chooseTheme({ kind: "builtin", id: "dark" });
        // The offered theme's file, in place of the server's page store.
        const current = apiModule.readEnvironmentApi(env);
        apiModule.__setEnvironmentApiOverrideForTests(env, {
          ...current,
          pages: {
            ...current.pages,
            read: async (input: any) =>
              input.pageId === pageId
                ? { kind: "theme", content: offered[input.versionId] }
                : current.pages.read(input),
          },
        });
        // Sharing: the account and the publish step. Preparing the share
        // (the picture, the fonts' licenses) is the server's own.
        const client = runtime.readEnvironmentConnection(env)?.client;
        if (!client) throw new Error("The studio app has no server connection.");
        client.server.getReportProblemAccount = async () => ({ status: "signedIn", login });
        client.themeShowcase.submissions = async () => ({ submissions: [] });
        client.themeShowcase.submit = async (share: any) => {
          await settle(1400);
          const entry = library
            .currentLibraryThemes()
            .find((kept: any) => kept.entry.entryId === share.entryId);
          return {
            submissionId: share.submissionId,
            entryId: share.entryId,
            sourceHash: entry.entry.hash,
            publishedHash: entry.entry.hash,
            login,
            pullRequestUrl: "https://github.com/Threadlines/themes/pulls",
            state: "inReview",
            createdAt: new Date().toISOString(),
          };
        };
        // The credit an earlier share left in the dialog.
        localStorage.removeItem("threadlines:theme-export-credits");
        // Capture-only: notices that aren't part of the story (an agent
        // update), and the slash menu's groups of this computer's own
        // plugin commands, which sit under Threadlines' /theme.
        document.getElementById("promo-themes-style")?.remove();
        const style = document.createElement("style");
        style.id = "promo-themes-style";
        style.textContent = `[data-sonner-toaster],[data-slot=toast-viewport]{display:none!important}
          [data-slot=command-group]:not(:has([data-composer-item-id^="slash:"])){display:none!important}`;
        document.head.append(style);
        await settle(600);
      },
      { honu, speedcube, pageId, offered, login: LOGIN },
    );
  };

  /** An earlier finished exchange, so the chat has words over the art. */
  const history = async () => {
    clockOffsetMs = -9 * 60_000;
    await engine.run({
      type: "thread.turn.start",
      commandId: id("promo"),
      threadId,
      message: { messageId: id("message"), role: "user", text: EARLIER_PROMPT, attachments: [] },
      modelSelection: OPUS,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: iso(),
    });
    const turn = id("turn");
    await session("running", turn);
    const plan = id("assistant");
    await command("thread.message.assistant.delta", {
      messageId: plan,
      turnId: turn,
      delta: "I'll disable the button while the payment request is open.",
    });
    await command("thread.message.assistant.complete", {
      messageId: plan,
      turnId: turn,
      completesTurn: false,
    });
    clockOffsetMs += 20_000;
    await tool(turn, { kind: "read", path: "src/checkout/PayButton.tsx" }, 0);
    await tool(
      turn,
      {
        kind: "edit",
        path: "src/checkout/PayButton.tsx",
        oldString: "<Button onClick={pay}>Pay</Button>",
        newString: "<Button onClick={pay} disabled={paying}>Pay</Button>",
      },
      0,
    );
    clockOffsetMs += 60_000;
    await tool(turn, { kind: "run", command: "npm test -- checkout" }, 0);
    clockOffsetMs += 20_000;
    const done = id("assistant");
    await command("thread.message.assistant.delta", {
      messageId: done,
      turnId: turn,
      delta:
        "The pay button now shows a spinner and ignores clicks until the payment finishes. Tests pass.",
    });
    await completeTurn(turn, done, [
      { path: "src/checkout/PayButton.tsx", kind: "modified", additions: 14, deletions: 3 },
      { path: "tests/checkout.test.ts", kind: "modified", additions: 22, deletions: 0 },
    ]);
    clockOffsetMs = 0;
  };

  /** Shows a starter at once, the way picking it in Settings does, and sets Glass. */
  const showStarter = (starter: string, glass: number) =>
    ui.evaluate(
      async ({ starter, glass }: Json) => {
        const [store, catalog, settings] = await Promise.all([
          import("/src/theme/themeStore.ts" as string),
          import("/src/themeLibrary/themeCatalog.ts" as string),
          import("/src/hooks/useSettings.ts" as string),
        ]);
        await settings.updateSettingsAndPersist({ themeGlass: glass });
        if (starter === "dark") {
          store.chooseTheme({ kind: "builtin", id: "dark" });
          return;
        }
        const tile = catalog.STARTER_TILES.find((entry: any) => entry.key === `starter:${starter}`);
        await catalog.switchToTheme(tile, { preview: false });
        const trial = store.readThemeState().trial;
        if (trial !== null) store.commitThemeTrial(trial.id);
      },
      { starter, glass },
    );

  return {
    async prologue() {
      await dressStudio();
      await history();
      return {};
    },

    /** After the take, recorded or not: the studio back on Dark, Honu Lagoon out. */
    async restore() {
      await dressStudio();
    },

    async take() {
      ui.trackSelector("strip", '[role="listbox"][aria-label="Themes"]');
      ui.trackSelector("offer", "[data-theme-offer]");
      ui.trackSelector("trial-bar", "[data-theme-trial-bar]");
      ui.trackSelector("share-dialog", '[data-testid="theme-share-dialog"]');
      ui.trackSelector("tiles", '[data-theme-tile^="library:"]');
      ui.mark("open");
      await ui.sleep(800);

      // 1. The new-thread screen, each starter's art behind it in turn. No
      // caret, no pointer: the art is the only thing moving.
      await ui.clickOn('[aria-label="New thread"]:visible', { hover: 200, hold: 600 });
      await ui.until("the new-thread screen", () =>
        ui.evaluate(() => location.hash.includes("draft")),
      );
      await ui.rest();
      await ui.blur();
      for (const [starter, seconds] of MONTAGE) {
        await showStarter(starter, MONTAGE_GLASS);
        await untilTheme(starter);
        // The art fades in, and its first frames warm up.
        await ui.sleep(3200);
        await ui.steady(true);
        await ui.sleep(300);
        ui.mark(`art-${starter}-in`);
        await ui.sleep(seconds * 1000);
        ui.mark(`art-${starter}-out`);
        await ui.steady(false);
      }
      await showStarter("dark", 50);
      await untilTheme("dark");
      await ui.openThread(threadId, "parent");
      ui.mark("thread");
      await ui.sleep(1800);

      // 2. /theme, and along the strip to Lantern Lake.
      await ui.focusComposer();
      ui.mark("slash");
      await ui.type("/theme", 130);
      await ui.sleep(900);
      await ui.press("Enter");
      await ui.until("the theme strip", () =>
        ui.evaluate(() => document.querySelector('[role="listbox"][aria-label="Themes"]') !== null),
      );
      ui.mark("strip");
      await ui.sleep(1900);
      for (const [starter, hold] of STRIP) {
        await ui.press("ArrowRight");
        await untilTheme(starter);
        ui.mark(`theme-${starter}`);
        await ui.sleep(hold);
      }
      await ui.press("Enter");
      await ui.until("the strip to close", () =>
        ui.evaluate(() => document.querySelector('[role="listbox"][aria-label="Themes"]') === null),
      );
      ui.mark("kept-theme");
      await ui.sleep(2600);

      // 2. Ask an agent for one.
      ui.mark("ask");
      const asked = await ui.send(THEME_PROMPT);
      ui.track("ask-msg", asked.messageId);
      const turn = id("turn");
      await session("running", turn);
      await ui.sleep(1100);
      await tool(turn, { kind: "fetch", url: "honu-lagoon.vercel.app" }, 1700);
      await tool(turn, { kind: "mcp", tool: "mcp__threadlines_pages__preview_theme" }, 2600);
      await tool(turn, { kind: "mcp", tool: "mcp__threadlines_pages__show_theme" }, 500);
      await publish(turn, 1);
      const reply = id("assistant");
      ui.track("theme-reply", reply);
      await stream(reply, THEME_REPLY, turn);
      await engine.batch(() => completeTurn(turn, reply, []));
      ui.mark("offered");
      await ui.sleep(3400);
      await ui.clickOn('[data-theme-offer] button:text-is("Try it")', { hover: 600, hold: 300 });
      await untilTheme("Honu Lagoon");
      ui.mark("trying");
      await ui.sleep(4200);
      await ui.clickOn('[data-theme-trial-bar] button:text-is("Keep")', { hover: 500, hold: 300 });
      await ui.until("Honu Lagoon to be kept", async () => !(await shownTheme()).trial);
      ui.mark("kept-honu");
      await ui.rest();
      await ui.sleep(3200);

      // A small ask: the agent shows a new version, and Update replaces the kept copy.
      ui.mark("tweak");
      const tweak = await ui.send(TWEAK_PROMPT);
      ui.track("tweak-msg", tweak.messageId);
      const tweakTurn = id("turn");
      await session("running", tweakTurn);
      await ui.sleep(1000);
      await tool(tweakTurn, { kind: "mcp", tool: "mcp__threadlines_pages__preview_theme" }, 2200);
      await tool(tweakTurn, { kind: "mcp", tool: "mcp__threadlines_pages__show_theme" }, 500);
      await publish(tweakTurn, 2);
      const tweaked = id("assistant");
      ui.track("tweak-reply", tweaked);
      await stream(tweaked, TWEAK_REPLY, tweakTurn);
      await engine.batch(() => completeTurn(tweakTurn, tweaked, []));
      ui.mark("offered-update");
      await ui.sleep(3200);
      await ui.clickOn('[data-theme-offer] button:text-is("Try it")', { hover: 600, hold: 300 });
      await ui.until("the new version to show", async () => (await shownTheme()).trial);
      ui.mark("trying-update");
      await ui.sleep(3400);
      await ui.clickOn('[data-theme-trial-bar] button:text-is("Update")', {
        hover: 500,
        hold: 300,
      });
      await ui.until("Honu Lagoon to be updated", async () => !(await shownTheme()).trial);
      ui.mark("updated");
      await ui.rest();
      await ui.sleep(3600);

      // The Glass slider, most of the way to Clear: more of the lagoon shows.
      await ui.focusComposer();
      ui.mark("glass-slash");
      await ui.type("/theme", 110);
      await ui.sleep(700);
      await ui.press("Enter");
      const strip = '[role="listbox"][aria-label="Themes"]';
      await ui.until("the theme strip", () =>
        ui.evaluate((selector: string) => document.querySelector(selector) !== null, strip),
      );
      ui.mark("glass-strip");
      await ui.sleep(1300);
      await ui.dragAlong(
        `${strip} [data-slot="slider-thumb"]`,
        `${strip} [data-slot="slider"]`,
        0.86,
      );
      ui.mark("glass-clear");
      await ui.sleep(1500);
      await ui.press("Escape");
      await ui.until("the strip to close", () =>
        ui.evaluate((selector: string) => document.querySelector(selector) === null, strip),
      );
      await ui.rest();
      ui.mark("glass-done");
      await ui.sleep(5200);

      // 3. Share your own: Speedcube, from Settings › Appearance.
      ui.mark("settings");
      await ui.clickOn('[data-testid="rail-settings"]:visible', { hover: 300, hold: 500 });
      await ui.clickOn('a:has-text("Appearance"), button:has-text("Appearance")', {
        hover: 300,
        hold: 300,
      });
      await ui.until("Appearance to open", () =>
        ui.evaluate(() => location.hash.includes("appearance")),
      );
      ui.mark("appearance");
      await ui.sleep(1800);
      await ui.hoverOn('[data-theme-tile^="library:"]');
      await ui.sleep(500);
      await ui.clickOn('[aria-label="Speedcube options"]', { hover: 400, hold: 500 });
      ui.mark("menu");
      await ui.clickOn('[role="menuitem"]:has-text("Share to Showcase")', {
        hover: 600,
        hold: 300,
      });
      await ui.until("the share dialog's picture", () =>
        ui.evaluate(
          () => document.querySelector('[data-testid="theme-share-dialog"] img') !== null,
        ),
      );
      ui.mark("share-dialog");
      await ui.sleep(1600);
      await ui.clickOn('[data-testid="theme-share-dialog"] input[placeholder="Your name"]', {
        hover: 300,
        hold: 200,
      });
      await ui.type(CREDIT, 70);
      await ui.sleep(1100);
      await ui.clickOn('[data-testid="theme-share-dialog"] button:text-is("Share")', {
        hover: 600,
        hold: 200,
      });
      await ui.until("the share to be sent", () =>
        ui.evaluate(() =>
          (
            document.querySelector('[data-testid="theme-share-dialog"]')?.textContent ?? ""
          ).includes("Sent for review"),
        ),
      );
      ui.mark("shared");
      await ui.sleep(3000);
      await ui.clickOn('[data-testid="theme-share-dialog"] button:text-is("Done")', {
        hover: 400,
        hold: 500,
      });
      await ui.clickOn('[data-theme-tile^="library:"]', { hover: 500, hold: 300 });
      await untilTheme("Speedcube");
      // A theme this device never kept starts as a trial; keep it.
      if ((await shownTheme()).trial) {
        await ui.clickOn('[data-theme-trial-bar] button:text-is("Keep")', {
          hover: 400,
          hold: 300,
        });
      }
      ui.mark("speedcube");
      await ui.sleep(2600);

      // Back to the thread, on your own theme.
      await ui.clickOn('[data-testid="rail-threads"]:visible', { hover: 300, hold: 500 });
      await ui.openThread(threadId, "parent");
      ui.mark("back");
      await ui.sleep(6000);
      ui.mark("end");
    },
  };
}
