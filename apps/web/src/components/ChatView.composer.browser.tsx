import {
  ORCHESTRATION_WS_METHODS,
  MessageId,
  type OrchestrationReadModel,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
  WS_METHODS,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { useRoomRecipientStore } from "../rooms";
import { isMacPlatform } from "../lib/utils";
import { useTerminalStateStore } from "../terminalStateStore";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import {
  THREAD_ID,
  THREAD_TITLE,
  PROJECT_ID,
  THREAD_REF,
  THREAD_KEY,
  NOW_ISO,
  fixture,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  createTerminalContext,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  sendShellThreadUpsert,
  serverThreadPath,
  createDraftOnlySnapshot,
  setDraftThreadWithoutWorktree,
  CLAUDE_TEST_PROVIDER,
  createSnapshotWithPromptSuggestion,
  waitForLayout,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  pressComposerKey,
  pressComposerUndo,
  replaceComposerSelectionWithNativeSpellcheckText,
  waitForComposerText,
  setComposerSelectionByTextOffsets,
  selectAllComposerContent,
  waitForComposerMenuItem,
  waitForSendButton,
  findComposerProviderModelPicker,
  findVisibleComposerFooter,
  waitForButtonByText,
  waitForSelectItemContainingText,
  clickSelectItemContainingText,
  waitForServerConfigToApply,
  releaseModShortcut,
  mountChatView,
  registerChatViewSuiteHooks,
} from "./ChatView.browser-harness";

vi.mock("../lib/gitStatusState", () => ({
  // Read synchronously by the draft seeder to skip a checkout already known
  // to be missing; these suites never exercise a deleted checkout.
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  GIT_STATUS_STALE_MESSAGE: "Source control status isn't updating.",
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  rebuildGitStatusSubscription: () => undefined,
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

describe("ChatView (full app): composer", () => {
  registerChatViewSuiteHooks();

  it("leaves collapsed-caret typing unchanged for surround symbols", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-collapsed" as MessageId,
        targetText: "surround collapsed",
      }),
    });

    try {
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({
        start: "selected".length,
        end: "selected".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("selected(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("brings back the user's earlier messages with Up and Down, and leaves typed words alone", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-recall" as MessageId,
        targetText: "recall target",
      }),
    });

    try {
      await waitForComposerText("");
      await pressComposerKey("ArrowUp");
      await waitForComposerText("filler user message 21");
      await pressComposerKey("ArrowUp");
      await waitForComposerText("filler user message 20");
      await pressComposerKey("ArrowDown");
      await waitForComposerText("filler user message 21");
      // Past the newest, the box is empty again.
      await pressComposerKey("ArrowDown");
      await waitForComposerText("");

      // Words the user typed keep the arrows for the caret: recall leaves the key alone.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "my draft");
      await waitForComposerText("my draft");
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      const arrowUp = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      });
      composerEditor.dispatchEvent(arrowUp);
      expect(arrowUp.defaultPrevented).toBe(false);
      await waitForComposerText("my draft");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports symmetric and backward-selection surrounds", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "backward");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-backward" as MessageId,
        targetText: "surround backward",
      }),
    });

    try {
      await waitForComposerText("backward");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "backward".length,
        direction: "backward",
      });
      await pressComposerKey("*");
      await waitForComposerText("*backward*");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports option-produced surround symbols like guillemets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-guillemet" as MessageId,
        targetText: "surround guillemet",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
      await pressComposerKey("«");
      await waitForComposerText("«quoted»");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports dead-key composition that resolves to another surround symbol without an extra undo step", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-dead-quote" as MessageId,
        targetText: "surround dead quote",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          bubbles: true,
          cancelable: true,
        }),
      );
      composerEditor.dispatchEvent(
        new InputEvent("beforeinput", {
          data: "'",
          inputType: "insertCompositionText",
          bubbles: true,
          cancelable: true,
        }),
      );
      const resolvedInputEvent = new InputEvent("beforeinput", {
        data: "'",
        inputType: "insertText",
        bubbles: true,
        cancelable: true,
      });
      composerEditor.dispatchEvent(resolvedInputEvent);
      expect(resolvedInputEvent.defaultPrevented).toBe(true);
      await waitForComposerText("'quoted'");
      await pressComposerUndo();
      await waitForComposerText("quoted");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps native spellcheck replacements active and synced", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "speeling and teh");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-spellcheck-replacement" as MessageId,
        targetText: "spellcheck replacement",
      }),
    });

    try {
      await waitForComposerText("speeling and teh");
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      expect(document.activeElement).toBe(composerEditor);
      expect(composerEditor.spellcheck).toBe(true);
      await setComposerSelectionByTextOffsets({ start: 0, end: "speeling".length });

      const blurSpy = vi.spyOn(composerEditor, "blur");
      const focusSpy = vi.spyOn(composerEditor, "focus");
      const setAttributeSpy = vi.spyOn(composerEditor, "setAttribute");
      try {
        await replaceComposerSelectionWithNativeSpellcheckText("spelling");

        await waitForComposerText("spelling and teh");

        expect(blurSpy).not.toHaveBeenCalled();
        expect(focusSpy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(composerEditor);
        expect(composerEditor.spellcheck).toBe(true);
        expect(composerEditor.getAttribute("spellcheck")).toBe("true");
        const selection = window.getSelection();
        expect(selection?.rangeCount).toBe(1);
        const selectionRange = selection?.getRangeAt(0);
        expect(
          selectionRange ? composerEditor.contains(selectionRange.startContainer) : false,
        ).toBe(true);
        // We must NOT disable spellcheck (which clears every squiggle in the
        // field) and must NOT remount the host element. Chromium re-checks the
        // whole field natively after the replacement, exactly as it does after
        // a keystroke, so any interference is what made the other underlines
        // vanish until the next character was typed.
        const spellcheckDisableCalls = setAttributeSpy.mock.calls.filter(
          ([name, value]) => name === "spellcheck" && value === "false",
        );
        expect(spellcheckDisableCalls).toEqual([]);
        const refreshedComposerEditor = document.querySelector<HTMLElement>(
          '[data-testid="composer-editor"]',
        );
        expect(refreshedComposerEditor).toBe(composerEditor);
        expect(composerEditor.isConnected).toBe(true);
      } finally {
        blurSpy.mockRestore();
        focusSpy.mockRestore();
        setAttributeSpy.mockRestore();
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not refresh native spellcheck for normal typing", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "speeling and teh");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-spellcheck-normal-input" as MessageId,
        targetText: "spellcheck normal input",
      }),
    });

    try {
      await waitForComposerText("speeling and teh");
      const composerEditor = await waitForComposerEditor();
      await setComposerSelectionByTextOffsets({
        start: "speeling and teh".length,
        end: "speeling and teh".length,
      });

      const setAttributeSpy = vi.spyOn(composerEditor, "setAttribute");
      try {
        await pressComposerKey("!");
        await waitForComposerText("speeling and teh!");
        expect(setAttributeSpy.mock.calls.some(([name]) => name === "spellcheck")).toBe(false);
      } finally {
        setAttributeSpy.mockRestore();
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("edits text in place so other words keep their spelling underlines", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "speeling and teh");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-spellcheck-in-place" as MessageId,
        targetText: "spellcheck in place",
      }),
    });

    // Chromium drops every spelling underline an edit overlaps, so a write
    // that replaces a text node's whole value clears the underlines of every
    // word in it. Lexical's reconciler writes only the changed part in
    // Chromium (lexical#9354, once our patch). Record each write to the
    // composer's text as the range of old text it replaces.
    const writes: Array<{ readonly start: number; readonly end: number }> = [];
    const prototypes = [Node.prototype, CharacterData.prototype];
    const originals = prototypes.flatMap((target) =>
      Object.entries(Object.getOwnPropertyDescriptors(target)).map(
        ([key, descriptor]) => [target, key, descriptor] as const,
      ),
    );
    const restore = () => {
      for (const [target, key, descriptor] of originals) {
        Object.defineProperty(target, key, descriptor);
      }
    };
    try {
      await waitForComposerText("speeling and teh");
      const composerEditor = await waitForComposerEditor();
      const textNode = document.createTreeWalker(composerEditor, NodeFilter.SHOW_TEXT).nextNode();
      expect(textNode?.nodeValue).toBe("speeling and teh");
      const record = (node: Node, range: (length: number) => readonly [number, number]) => {
        if (node instanceof Text && composerEditor.contains(node)) {
          const [start, end] = range(node.length);
          writes.push({ start, end });
        }
      };
      const ranges: Record<
        string,
        (args: ReadonlyArray<number>) => (length: number) => readonly [number, number]
      > = {
        replaceData:
          ([offset = 0, count = 0]) =>
          () => [offset, offset + count],
        deleteData:
          ([offset = 0, count = 0]) =>
          () => [offset, offset + count],
        insertData:
          ([offset = 0]) =>
          () => [offset, offset],
        appendData: () => (length) => [length, length],
      };
      for (const [target, key, descriptor] of originals) {
        if (descriptor.set && (key === "nodeValue" || key === "textContent" || key === "data")) {
          Object.defineProperty(target, key, {
            ...descriptor,
            set(this: Node, value: string) {
              record(this, (length) => [0, length]);
              descriptor.set!.call(this, value);
            },
          });
        }
        const toRange = ranges[key];
        if (toRange && typeof descriptor.value === "function") {
          const method = descriptor.value as (...args: unknown[]) => unknown;
          Object.defineProperty(target, key, {
            ...descriptor,
            value(this: Node, ...args: unknown[]) {
              record(this, toRange(args.filter((arg): arg is number => typeof arg === "number")));
              return method.apply(this, args);
            },
          });
        }
      }
      await setComposerSelectionByTextOffsets({
        start: "speeling and teh".length,
        end: "speeling and teh".length,
      });

      // A real Backspace: Lexical deletes the character itself and the
      // reconciler writes the new text.
      await userEvent.keyboard("{Backspace}");
      await waitForComposerText("speeling and te");
      restore();

      expect(textNode?.isConnected).toBe(true);
      expect(textNode?.nodeValue).toBe("speeling and te");
      // The reconciler made the edit, not the browser, so this test still
      // checks something.
      expect(writes.length).toBeGreaterThan(0);
      // Nothing before the deleted character was written over.
      expect(writes.filter(({ start }) => start < "speeling and te".length)).toEqual([]);
    } finally {
      restore();
      await mounted.cleanup();
    }
  });

  it("surrounds text after a mention using the correct expanded offsets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-after-mention" as MessageId,
        targetText: "surround after mention",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForComposerText("hi @package.json there");
      await setComposerSelectionByTextOffsets({
        start: "hi package.json ".length,
        end: "hi package.json there".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("hi @package.json (there)");
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to normal replacement when the selection includes a mention token", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there ");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-token" as MessageId,
        targetText: "surround token",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await selectAllComposerContent();
      await pressComposerKey("(");
      await waitForComposerText("(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows runtime mode descriptions in the desktop composer access select", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const runtimeModeSelect = await waitForButtonByText("Full access");
      runtimeModeSelect.click();

      expect((await waitForSelectItemContainingText("Supervised")).textContent).toContain(
        "Asks before commands and file changes",
      );

      // The draft uses the default codex driver, so the menu shows the
      // codex-specific blast-radius copy for the middle tier.
      const autoAcceptItem = await waitForSelectItemContainingText("Auto-accept edits");
      expect(autoAcceptItem.textContent).toContain("workspace commands run");
      expect((await waitForSelectItemContainingText("Full access")).textContent).toContain(
        "No prompts or sandbox",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the access level an agent without Auto runs a chat set to Auto at", async () => {
    setDraftThreadWithoutWorktree();
    const draftThread = useComposerDraftStore.getState().draftThreadsByThreadKey[THREAD_KEY]!;
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: { [THREAD_KEY]: { ...draftThread, runtimeMode: "auto" } },
    });

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        // The draft's agent has no Auto level, as with Pi.
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: nextFixture.serverConfig.providers.map((provider, index) =>
            index === 0
              ? {
                  ...provider,
                  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
                }
              : provider,
          ),
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const footer = await waitForElement(
        findVisibleComposerFooter,
        "Unable to find composer footer.",
      );
      await vi.waitFor(() => {
        expect(
          footer.querySelector('button[aria-label="Access level: Auto-accept edits"]'),
        ).not.toBeNull();
      });
      // The chat keeps its choice, for an agent that has Auto.
      const chosen = () =>
        useComposerDraftStore.getState().draftThreadsByThreadKey[THREAD_KEY]?.runtimeMode;
      expect(chosen()).toBe("auto");

      // Picking the level shown pins it.
      footer.querySelector<HTMLButtonElement>('button[aria-label^="Access level:"]')!.click();
      await clickSelectItemContainingText("Auto-accept edits");
      await vi.waitFor(() => {
        expect(chosen()).toBe("auto-accept-edits");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const removeButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${removedLabel}"]`),
        "Unable to find terminal context remove button.",
      );
      removeButton.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_REF,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the scroll-to-bottom affordance hidden when a terminal attachment grows the composer", async () => {
    const terminalLabel = "Terminal 1 line 7";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-attachment-scroll-target" as MessageId,
        targetText: "terminal attachment scroll target",
      }),
    });

    try {
      const messagesList = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-messages-list="true"]'),
        "Unable to find messages list.",
      );

      messagesList.scrollTop = messagesList.scrollHeight;
      messagesList.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForLayout();

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_REF,
        createTerminalContext({
          id: "ctx-scroll-stable",
          terminalLabel: "Terminal 1",
          lineStart: 7,
          lineEnd: 7,
          text: "received",
        }),
      );

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(terminalLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      await waitForLayout();

      expect(document.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("removes terminal context attachments when their terminal is killed", async () => {
    const terminalId = "terminal-killed-context";
    const removedLabel = "Terminal 1 line 7";
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {
        [THREAD_KEY]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: [terminalId],
          runningTerminalIds: [],
          activeTerminalId: terminalId,
          terminalGroups: [{ id: "group-terminal-killed-context", terminalIds: [terminalId] }],
          activeTerminalGroupId: "group-terminal-killed-context",
        },
      },
    });
    useComposerDraftStore.getState().addTerminalContext(THREAD_REF, {
      ...createTerminalContext({
        id: "ctx-terminal-killed",
        terminalLabel: "Terminal 1",
        lineStart: 7,
        lineEnd: 7,
        text: "received",
      }),
      terminalId,
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-kill-context" as MessageId,
        targetText: "terminal kill context target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const killTerminalButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
            button.getAttribute("aria-label")?.startsWith("Kill Terminal"),
          ) ?? null,
        "Unable to find terminal kill button.",
      );
      killTerminalButton.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "yoowaddup");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a pointer cursor and dispatches one interrupt for repeated stop clicks", async () => {
    const activeTurnId = "turn-stop-button" as TurnId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
        sessionActiveTurnId: activeTurnId,
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
      stopButton.click();
      stopButton.click();

      await vi.waitFor(() => {
        const interruptRequests = wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.interrupt",
        );
        expect(interruptRequests).toHaveLength(1);
        expect(interruptRequests[0]).toMatchObject({
          threadId: THREAD_ID,
          turnId: activeTurnId,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders compact thread actions in the shared thread-row hover group", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-hover-test" as MessageId,
        targetText: "archive hover target",
      }),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "Unable to find thread row.",
      );
      const doneButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>(`[data-testid="thread-done-${THREAD_ID}"]`),
        "Unable to find done button.",
      );
      // Pin moved to the context menu: the hover group must not offer it.
      expect(document.querySelector(`[data-testid="thread-pin-${THREAD_ID}"]`)).toBeNull();
      const compactActions = doneButton.parentElement;
      expect(
        compactActions,
        "Thread actions should render inside a shared visibility wrapper.",
      ).not.toBeNull();
      const threadItem = doneButton.closest("li");
      expect(threadItem?.className).toContain("group/thread-row");
      expect(compactActions?.className).toContain("group-hover/thread-row:opacity-100");
      expect(compactActions?.className).toContain("group-focus-within/thread-row:opacity-100");
      expect(doneButton.getAttribute("aria-label")).toBe(`Wrap up ${THREAD_TITLE}`);
      // Icon only: the word lives in its tooltip.
      expect(doneButton.textContent).toBe("");
      // Hidden until the row is hovered or focused, which is the whole point of
      // the shared wrapper.
      expect(getComputedStyle(compactActions!).opacity).toBe("0");
    } finally {
      await mounted.cleanup();
    }
  });

  // Mount a Claude thread that ended with a prompt suggestion and wait for
  // the composer to show it in place of the hint.
  const mountPromptSuggestion = async (suggestion: string) => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPromptSuggestion(suggestion),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [...nextFixture.serverConfig.providers, CLAUDE_TEST_PROVIDER],
        };
      },
    });
    const text = await waitForElement(
      () => {
        const found = document.querySelector<HTMLElement>('[data-prompt-suggestion-text="true"]');
        return found?.textContent === suggestion ? found : null;
      },
      () =>
        `The composer never showed the suggestion "${suggestion}"; it shows "${
          document.querySelector('[data-prompt-suggestion-text="true"]')?.textContent ?? ""
        }".`,
    );
    const composerEditor = await waitForComposerEditor();
    return { mounted, text, composerEditor };
  };

  const waitForSuggestionGone = (message: string) =>
    waitForElement(
      () =>
        document.querySelector(
          '[data-prompt-suggestion-text="true"], [data-prompt-suggestion-remainder="true"]',
        )
          ? null
          : document.body,
      message,
    );

  it("shows the agent's suggestion inside the composer in place of the hint", async () => {
    const suggestion = "Commit this and open the PR";
    const { mounted, text, composerEditor } = await mountPromptSuggestion(suggestion);
    try {
      // Inside the message box, over the editor, not floating above it.
      const editorRect = composerEditor.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      expect(textRect.top).toBeGreaterThanOrEqual(editorRect.top - 1);
      expect(textRect.bottom).toBeLessThanOrEqual(editorRect.bottom + 1);
      expect(composerEditor.getAttribute("aria-placeholder")).toBe(
        `Suggested: ${suggestion}. Press Tab to use it.`,
      );
      // The usual hint gives way; its "@ / $" help moves under the suggestion.
      const composerForm = document.querySelector('[data-chat-composer-form="true"]');
      expect(composerForm?.textContent).not.toContain("Ask anything");
      expect(document.querySelector('[data-prompt-suggestion="true"]')?.textContent).toContain(
        "/ commands",
      );

      // Clicking its Tab key takes it too.
      document.querySelector<HTMLElement>('[data-prompt-suggestion-accept="true"]')?.click();
      await waitForElement(
        () => (composerEditor.textContent?.trim() === suggestion ? composerEditor : null),
        () =>
          `Clicking the Tab key never moved the suggestion into the composer; it holds "${
            composerEditor.textContent ?? ""
          }".`,
      );
      await waitForSuggestionGone("The suggestion stayed drawn over the text it filled in.");
    } finally {
      await mounted.cleanup();
    }
  });

  it("sweeps the suggestion as it arrives, and typing ends the sweep for good", async () => {
    const { mounted, text } = await mountPromptSuggestion("Run the tests");
    try {
      const overlay = text.closest<HTMLElement>('[data-prompt-suggestion="true"]')!;
      expect(overlay.dataset.sweeping).toBe("true");

      // A sweep needs its words on screen from the start. Typing ends it, so
      // emptying the box again shows them at rest instead of replaying it.
      await page.getByTestId("composer-editor").fill("no");
      await vi.waitFor(() => expect(overlay.dataset.sweeping).toBeUndefined(), { timeout: 600 });
      // Emptied through the draft, not `fill("")`: that selects all and then
      // presses Delete, and Lexical can take the key before it hears of the
      // selection, deleting nothing after the cursor.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
      await waitForElement(
        () => overlay.querySelector<HTMLElement>('[data-prompt-suggestion-text="true"]'),
        "Emptying the composer did not bring the suggestion back.",
      );
      expect(overlay.dataset.sweeping).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("accepts the prompt suggestion with Tab from the focused composer", async () => {
    const suggestion = "Commit this and open the PR";
    const { mounted, composerEditor } = await mountPromptSuggestion(suggestion);
    try {
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );

      await waitForElement(
        () => (composerEditor.textContent?.trim() === suggestion ? composerEditor : null),
        () =>
          `Tab never moved the suggestion into the composer; it holds "${
            composerEditor.textContent ?? ""
          }".`,
      );
      await waitForSuggestionGone("The suggestion stayed drawn over the text Tab filled in.");
      // Focus stays in the composer instead of tabbing out to the toolbar.
      expect(document.activeElement).toBe(composerEditor);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the rest of the suggestion after the cursor while typing its first words", async () => {
    const suggestion = "Commit this and open the PR";
    const { mounted, composerEditor } = await mountPromptSuggestion(suggestion);
    try {
      await page.getByTestId("composer-editor").fill("commit this");
      const remainder = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-suggestion-remainder="true"]'),
        "Typing the suggestion's first words dropped the rest of it.",
      );
      const rest = remainder.querySelector<HTMLElement>("span:nth-of-type(2)");
      expect(rest?.textContent).toBe(" and open the PR");

      // Tab finishes it, keeping what was typed.
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
      await waitForElement(
        () =>
          composerEditor.textContent?.trim() === "commit this and open the PR"
            ? composerEditor
            : null,
        () =>
          `Tab never finished the suggestion; the composer holds "${
            composerEditor.textContent ?? ""
          }".`,
      );

      // With words selected the rest would read as continuing the selection:
      // it hides, and Tab leaves the text alone.
      await page.getByTestId("composer-editor").fill("commit this");
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-suggestion-remainder="true"]'),
        "The rest did not come back after retyping the suggestion's first words.",
      );
      await userEvent.keyboard("{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}");
      await waitForSuggestionGone("The rest stayed after the cursor while words were selected.");
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
      await waitForLayout();
      expect(composerEditor.textContent?.trim()).toBe("commit this");

      // Words that leave the suggestion drop it, and so does a box of spaces,
      // which Tab could not fill.
      await page.getByTestId("composer-editor").fill("commit that");
      await waitForSuggestionGone("The suggestion stayed after the typed words left it.");
      await page.getByTestId("composer-editor").fill("   ");
      await waitForSuggestionGone("The suggestion stayed over a box of spaces.");
    } finally {
      await mounted.cleanup();
    }
  });

  it("lines the rest of the suggestion up with the typed words wherever they wrap", async () => {
    // The long word starts past the middle of the first line, so while it is
    // half typed it fits there, but the whole word does not.
    const suggestion =
      "Rename the configuration loader and then double check that pneumonoultramicroscopicsilicovolcanoconiosis still wraps";
    const { mounted, composerEditor } = await mountPromptSuggestion(suggestion);
    try {
      let previousTop: number | null = null;
      let wrappedMidWord = false;
      for (let length = 20; length < suggestion.length; length += 1) {
        // A trailing space hangs at a line's end, where it has no box to measure.
        if (suggestion[length - 1] === " ") continue;
        const typed = suggestion.slice(0, length);
        await page.getByTestId("composer-editor").fill(typed);
        const rest = await waitForElement(() => {
          const found = document.querySelector<HTMLElement>(
            '[data-prompt-suggestion-remainder="true"] span:nth-of-type(2)',
          );
          return found?.textContent === suggestion.slice(length) ? found : null;
        }, `The rest never followed "${typed}".`);
        const typedRange = document.createRange();
        typedRange.selectNodeContents(composerEditor);
        const typedRects = typedRange.getClientRects();
        const typedEnd = typedRects[typedRects.length - 1]!;
        // The invisible copy of the typed words wraps exactly like them, even
        // when the word the rest completes no longer fits on their line...
        const mirrorRects = rest.parentElement!.querySelector("span")!.getClientRects();
        const mirrorEnd = mirrorRects[mirrorRects.length - 1]!;
        expect(
          Math.abs(mirrorEnd.right - typedEnd.right) < 1.5 &&
            Math.abs(mirrorEnd.top - typedEnd.top) < 1.5,
          `"${typed}" ends at (${typedEnd.right}, ${typedEnd.top}) but its copy ends at (${mirrorEnd.right}, ${mirrorEnd.top}).`,
        ).toBe(true);
        // ...so the gray rest goes on right after them, or at the start of
        // the next line when it does not fit.
        const restStart = rest.getClientRects()[0]!;
        const lineStart = composerEditor.getBoundingClientRect().left;
        const continuesLine =
          Math.abs(restStart.left - typedEnd.right) < 1.5 &&
          Math.abs(restStart.top - typedEnd.top) < 1.5;
        const startsNextLine =
          Math.abs(restStart.left - lineStart) < 1.5 && restStart.top > typedEnd.top + 1;
        expect(
          continuesLine || startsNextLine,
          `"${typed}" ends at (${typedEnd.right}, ${typedEnd.top}) but its rest starts at (${restStart.left}, ${restStart.top}).`,
        ).toBe(true);
        if (
          previousTop !== null &&
          typedEnd.top > previousTop + 1 &&
          suggestion[length - 2] !== " "
        ) {
          wrappedMidWord = true;
        }
        previousTop = typedEnd.top;
      }
      // The case under test happened: typing more of a word moved it down.
      expect(wrappedMidWord).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers no rest once the typed words make the composer scroll", async () => {
    const suggestion = `${"Check the next module and note anything odd. ".repeat(24)}Then stop.`;
    const { mounted, composerEditor } = await mountPromptSuggestion(suggestion.trim());
    try {
      const typed = suggestion.slice(0, suggestion.length - "Then stop.".length - 1);
      await page.getByTestId("composer-editor").fill(typed);
      await waitForElement(
        () =>
          composerEditor.scrollHeight > composerEditor.clientHeight + 1 ? composerEditor : null,
        "The typed words never made the composer scroll.",
      );
      // The overlay does not follow the editor's scroll, so the rest would sit
      // off screen; it is not offered, and Tab adds nothing unseen.
      await waitForSuggestionGone("The rest stayed after the composer started scrolling.");
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
      await waitForLayout();
      expect(composerEditor.textContent?.endsWith("Then stop.")).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("puts the usual hint back when Escape dismisses the suggestion", async () => {
    const { mounted, composerEditor } = await mountPromptSuggestion("Run the tests");
    try {
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await waitForSuggestionGone("Escape did not dismiss the suggestion.");
      await waitForElement(
        () =>
          document
            .querySelector('[data-chat-composer-form="true"]')
            ?.textContent?.includes("Ask anything")
            ? document.body
            : null,
        "The usual hint did not come back after Escape.",
      );
      expect(composerEditor.getAttribute("aria-placeholder")).toContain("Ask anything");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a room's prompt suggestion for its own agent only", async () => {
    const fableId = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a" as ThreadParticipantId;
    const base = createSnapshotWithPromptSuggestion("Make a PR for this");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                participants: [
                  {
                    id: fableId,
                    handle: "Fable",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("claudeAgent"),
                      model: "claude-fable-5-1",
                    },
                    joinedAt: NOW_ISO,
                    leftAt: null,
                  },
                ],
              }
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [...nextFixture.serverConfig.providers, CLAUDE_TEST_PROVIDER],
        };
      },
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-suggestion-text="true"]'),
        "Unable to find the prompt suggestion in the composer.",
      );

      // The suggestion is the thread's own agent's guess at what you'd say to
      // it; sending to the other agent hides it.
      const picker = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      picker.click();
      const fableOption = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>("[data-room-agent-row]")].find((option) =>
            /fable/i.test(option.textContent ?? ""),
          ) ?? null,
        "Unable to find the other Claude agent among the model picker's agents.",
      );
      fableOption.click();
      await waitForElement(
        () => (document.querySelector('[data-prompt-suggestion="true"]') ? null : document.body),
        "The thread's own agent's suggestion stayed up while addressing the other agent.",
      );
    } finally {
      // The choice outlives the view; later tests start from the thread's own agent.
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
      await mounted.cleanup();
    }
  });

  it("keeps the slash-command menu visible above the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-target" as MessageId,
        targetText: "command menu thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");

      const menuItem = await waitForComposerMenuItem("slash:model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      await vi.waitFor(
        () => {
          const menuRect = menuItem.getBoundingClientRect();
          const composerRect = composerForm.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            menuRect.left + menuRect.width / 2,
            menuRect.top + menuRect.height / 2,
          );

          expect(menuRect.width).toBeGreaterThan(0);
          expect(menuRect.height).toBeGreaterThan(0);
          expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
          expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the model picker when selecting /model", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-command-target" as MessageId,
        targetText: "model command thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/mod");

      const menuItem = await waitForComposerMenuItem("slash:model");
      await menuItem.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
        expect(findComposerProviderModelPicker()?.textContent).not.toContain("/model");
      });

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the model picker and shows jump keys immediately from the shortcut", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-model-picker-shortcut-target" as MessageId,
      targetText: "model picker shortcut thread",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === PROJECT_ID
            ? Object.assign({}, project, {
                defaultModelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
              })
            : project,
        ),
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: true,
                shiftKey: true,
                altKey: false,
                modKey: false,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              models: [
                {
                  slug: "gpt-5.1-codex-max",
                  name: "GPT-5.1 Codex Max",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.3-codex",
                  name: "GPT-5.3 Codex",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.4",
                  name: "GPT-5.4",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
              ],
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();

      const initialPath = mounted.router.state.location.pathname;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
      });

      const jumpLabel = isMacPlatform(navigator.platform) ? "⌃1" : "Ctrl+1";
      await vi.waitFor(() => {
        expect(
          Array.from(
            document.querySelectorAll<HTMLElement>('.model-picker-list [data-slot="kbd"]'),
          ).some((element) => element.textContent?.trim() === jumpLabel),
        ).toBe(true);
      });
      expect(mounted.router.state.location.pathname).toBe(initialPath);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      releaseModShortcut("Control");
      await mounted.cleanup();
    }
  });

  it("shows a tooltip with the skill description when hovering a skill pill", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-skill-tooltip-target" as MessageId,
        targetText: "skill tooltip thread",
      }),
      resolveRpc: (body) => {
        if (body._tag !== WS_METHODS.serverGetProviderExtensions) {
          return undefined;
        }
        return {
          cwd: "/repo/project",
          generatedAt: NOW_ISO,
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              status: "ready",
              plugins: [],
              marketplaces: [],
              skills: [
                {
                  name: "agent-browser",
                  displayName: "Agent Browser",
                  description: "Open pages, click around, and inspect web apps.",
                  path: "/Users/test/.agents/skills/agent-browser/SKILL.md",
                  enabled: true,
                },
              ],
              mcpServers: [],
              apps: [],
            },
          ],
          instructionFiles: [],
        };
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "use the $agent-browser ");
      await waitForComposerText("use the $agent-browser ");

      const skillChip = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-skill-chip="true"]'),
        "Unable to find rendered composer skill chip.",
      );
      await page.elementLocator(skillChip).hover();

      await vi.waitFor(
        () => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip).not.toBeNull();
          expect(tooltip?.textContent).toContain("Open pages, click around, and inspect web apps.");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("edits a user prompt from a stopped stale turn while preserving attachments and skills", async () => {
    const sourceMessageId = "msg-user-edit-and-branch" as MessageId;
    const staleTurnId = "turn-stale-edit-and-branch" as TurnId;
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: sourceMessageId,
      targetText: "Original prompt for branching.",
      targetAttachmentCount: 1,
    });
    const sourceMessage = baseSnapshot.threads[0]?.messages.find(
      (message) => message.id === sourceMessageId,
    );
    if (!sourceMessage) {
      throw new Error("Expected source message fixture.");
    }
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              latestTurn: {
                turnId: staleTurnId,
                state: "running",
                requestedAt: NOW_ISO,
                startedAt: NOW_ISO,
                completedAt: null,
                assistantMessageId: null,
              },
              messages: [
                {
                  ...sourceMessage,
                  skills: [
                    {
                      name: "review",
                      path: "/Users/test/.codex/skills/review/SKILL.md",
                    },
                  ],
                },
              ],
              session: thread.session
                ? {
                    ...thread.session,
                    status: "stopped",
                    activeTurnId: null,
                  }
                : null,
            }
          : thread,
      ),
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      resolveRpc: (body) => {
        if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return undefined;
        }
        if (body.type === "thread.fork") {
          const nextThreadId = body.threadId as ThreadId;
          fixture.snapshot = addThreadToSnapshot(fixture.snapshot, nextThreadId);
          queueMicrotask(() => sendShellThreadUpsert(nextThreadId));
        }
        return { sequence: fixture.snapshot.snapshotSequence + 1 };
      },
    });

    try {
      const sourceMessageRow = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-message-id="${sourceMessageId}"]`),
        () =>
          `Source message did not render. Rendered message ids: ${[
            ...document.querySelectorAll<HTMLElement>("[data-message-id]"),
          ]
            .map((element) => element.dataset.messageId)
            .join(", ")}`,
      );
      expect(sourceMessageRow.textContent).toContain("Original prompt for branching.");
      await page.elementLocator(sourceMessageRow).hover();
      const branchButton = await waitForElement(
        () =>
          sourceMessageRow.querySelector<HTMLButtonElement>(
            'button[aria-label="Branch from here"]',
          ),
        "Branch button did not render for the source message.",
      );
      await page.elementLocator(branchButton).click();
      await expect
        .element(page.getByText("Edit this prompt in a new thread?", { exact: true }))
        .toBeInTheDocument();

      const editTextarea = await waitForElement(
        () => document.querySelector<HTMLTextAreaElement>('[role="alertdialog"] textarea'),
        "Edit-and-branch prompt textarea did not render.",
      );
      await page.elementLocator(editTextarea).fill("Edited prompt for the branch.");
      await page.getByRole("button", { name: "Start branch" }).click();

      let forkRequest: NormalizedWsRpcRequestBody | undefined;
      await vi.waitFor(
        () => {
          forkRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.fork",
          );
          expect(forkRequest).toBeDefined();
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(forkRequest).toMatchObject({
        type: "thread.fork",
        sourceThreadId: THREAD_ID,
        sourceMessageId,
        message: {
          role: "user",
          text: "Edited prompt for the branch.",
          attachments: [
            {
              id: "attachment-1",
              name: "attachment-1.png",
              mimeType: "image/png",
            },
          ],
          skills: [
            {
              name: "review",
              path: "/Users/test/.codex/skills/review/SKILL.md",
            },
          ],
        },
      });

      const nextThreadId = forkRequest?.threadId as ThreadId;
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(nextThreadId),
        "Edit-and-branch should navigate to the new server thread.",
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
