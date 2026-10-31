import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  MessageId,
  OutsideAgentConnectionId,
  ProviderInstanceId,
  type TurnId,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { updateSettings } from "../hooks/useSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX } from "../rightPanelLayout";
import {
  COMPOSER_FOOTER_RESERVE_ATTRIBUTE,
  measureComposerFooterReserve,
} from "./composerFooterLayout";

import {
  THREAD_ID,
  LOCAL_ENVIRONMENT_ID,
  THREAD_REF,
  THREAD_KEY,
  NOW_ISO,
  fixture,
  rpcHarness,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  PHONE_VIEWPORT,
  NARROW_DESKTOP_COMPOSER_WIDTH,
  isoAt,
  createSnapshotForTargetUser,
  createSnapshotWithLongProposedPlan,
  createSnapshotWithPendingUserInput,
  createSnapshotWithPlanFollowUpPrompt,
  waitForElement,
  waitForComposerEditor,
  waitForComposerText,
  type TestFixture,
  findComposerProviderModelPicker,
  findVisibleComposerFooter,
  setVisibleComposerFormWidth,
  waitForButtonByText,
  waitForButtonByAriaLabel,
  waitForButtonByTextWithin,
  waitForButtonContainingText,
  expectComposerActionsContained,
  expectQuestionActionsContained,
  dragRightPanelFarWider,
  waitForServerConfigToApply,
  mountChatView,
  registerChatViewSuiteHooks,
  sendShellThreadUpsert,
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

/** A Codex model whose reasoning goes Low, Medium (its default), High. */
function withEffortModel(nextFixture: TestFixture): void {
  const [codexProvider] = nextFixture.serverConfig.providers;
  if (!codexProvider) return;
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    providers: [
      {
        ...codexProvider,
        models: [
          {
            slug: "gpt-5",
            name: "GPT-5",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select" as const,
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            }),
          },
        ],
      },
    ],
  };
}

describe("ChatView (full app): plans, questions and turn controls", () => {
  registerChatViewSuiteHooks();

  it("uses the active worktree path when saving a proposed plan to the workspace", async () => {
    const snapshot = createSnapshotWithLongProposedPlan();
    const threads = snapshot.threads.slice();
    const targetThreadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
    const targetThread = targetThreadIndex >= 0 ? threads[targetThreadIndex] : undefined;
    if (targetThread) {
      threads[targetThreadIndex] = {
        ...targetThread,
        worktreePath: "/repo/worktrees/plan-thread",
      };
    }

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads,
      },
    });

    try {
      const planActionsButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]'),
        "Unable to find proposed plan actions button.",
      );
      planActionsButton.click();

      const saveToWorkspaceItem = await waitForElement(
        () =>
          (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Save to workspace",
          ) ?? null) as HTMLElement | null,
        'Unable to find "Save to workspace" menu item.',
      );
      saveToWorkspaceItem.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Enter a path relative to /repo/worktrees/plan-thread.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending-question actions inside the question panel after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();
      (await waitForButtonByText("Next question")).click();

      await waitForButtonByText("Previous");
      await waitForButtonByText("Submit answers");

      await mounted.setComposerWidth(NARROW_DESKTOP_COMPOSER_WIDTH);
      await expectQuestionActionsContained();
      expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("stops dragging the right panel wider while a waiting question's buttons still fit", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?sourceControl=1`,
    });

    try {
      // The second question shows both Previous and Submit answers.
      (await waitForButtonContainingText("Tight")).click();
      (await waitForButtonByText("Next question")).click();
      await waitForButtonByText("Submit answers");
      // As when a thread opens with the question already waiting: no footer
      // has shown, so only the question's buttons say how much room to keep.
      const form = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]')!;
      form.removeAttribute(COMPOSER_FOOTER_RESERVE_ATTRIBUTE);
      await dragRightPanelFarWider();

      const questionActions = document.querySelector<HTMLElement>(
        '[data-chat-composer-question-actions="true"]',
      )!;
      expect(form.clientWidth).toBeGreaterThanOrEqual(
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX +
          questionActions.getBoundingClientRect().width -
          0.5,
      );
      await expectQuestionActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps room for the footer while an approval hides it and the right panel is dragged", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-approval-drag" as MessageId,
        targetText: "approval drag target",
        sessionStatus: "running",
        sessionActiveTurnId: "turn-approval-drag" as TurnId,
      }),
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?sourceControl=1`,
    });

    try {
      const footer = await waitForElement(
        findVisibleComposerFooter,
        "Unable to find composer footer.",
      );
      const footerReserve = measureComposerFooterReserve(footer);
      const appendActivity = (sequence: number, kind: string) =>
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "event",
          event: {
            sequence: fixture.snapshot.snapshotSequence + sequence,
            eventId: EventId.make(`evt-approval-drag-${sequence}`),
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            occurredAt: NOW_ISO,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.activity-appended",
            payload: {
              threadId: THREAD_ID,
              activity: {
                id: EventId.make(`activity-approval-drag-${sequence}`),
                kind,
                tone: "info",
                summary: kind,
                payload: {
                  requestId: "req-approval-drag",
                  requestKind: "command",
                  detail: "git status",
                },
                turnId: "turn-approval-drag" as TurnId,
                createdAt: isoAt(sequence),
              },
            },
          },
        });

      // An approval arrives and replaces the footer; the panel is dragged.
      appendActivity(1, "approval.requested");
      await expect.element(page.getByText("Command approval requested")).toBeVisible();
      expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
      await dragRightPanelFarWider();
      const form = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]')!;
      expect(form.clientWidth).toBeGreaterThanOrEqual(
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + footerReserve - 1,
      );

      // Once it's answered the footer comes back, and it still fits.
      appendActivity(2, "approval.resolved");
      const returned = await waitForElement(
        findVisibleComposerFooter,
        "The footer should come back once the approval is answered.",
      );
      const leftActions = returned.querySelector<HTMLElement>(
        '[data-chat-composer-actions="left"]',
      )!;
      await vi.waitFor(
        () => {
          expect(returned.scrollWidth).toBeLessThanOrEqual(returned.clientWidth + 1);
          expect(leftActions.scrollWidth).toBeLessThanOrEqual(leftActions.clientWidth + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  // Real phone viewports (touch-size buttons) and desktop composers squeezed
  // by panels beside the chat. The row is the "+" menu and the settings
  // button on the left, dictation, the context ring and send on the right; it
  // must stay one row without squeezing the model name down to nothing. 300px
  // is about the narrowest desktop composer the row supports. One test per
  // viewport: the full app only mounts cleanly once per test.
  it.each([
    { name: "phone", viewport: PHONE_VIEWPORT, composerWidth: null },
    { name: "small phone", viewport: { ...PHONE_VIEWPORT, width: 360 }, composerWidth: null },
    { name: "narrow pane", viewport: WIDE_FOOTER_VIEWPORT, composerWidth: 320 },
    { name: "extra-narrow pane", viewport: WIDE_FOOTER_VIEWPORT, composerWidth: 300 },
  ])(
    "keeps one composer row with the add menu and the settings button ($name)",
    async ({ viewport, composerWidth }) => {
      const mounted = await mountChatView({
        viewport,
        // The shared fixture snapshot does not render at phone viewports in
        // this harness; the target-user snapshot does.
        snapshot:
          viewport === WIDE_FOOTER_VIEWPORT
            ? fixture.snapshot
            : createSnapshotForTargetUser({
                targetMessageId: "msg-user-narrow-footer" as MessageId,
                targetText: "narrow footer",
              }),
      });

      try {
        if (composerWidth !== null) {
          await mounted.setComposerWidth(composerWidth);
        }

        const footer = await waitForElement(
          findVisibleComposerFooter,
          "Unable to find composer footer.",
        );
        const leftActions = await waitForElement(
          () => footer.querySelector<HTMLElement>('[data-chat-composer-actions="left"]'),
          "Unable to find left composer actions.",
        );
        const rightActions = await waitForElement(
          () => footer.querySelector<HTMLElement>('[data-chat-composer-actions="right"]'),
          "Unable to find right composer actions.",
        );
        const addButton = await waitForElement(
          () => leftActions.querySelector<HTMLButtonElement>('button[aria-label="Add to message"]'),
          "Unable to find the add menu in the composer row.",
        );
        const modelButton = await waitForElement(
          () =>
            leftActions.querySelector<HTMLButtonElement>(
              '[data-chat-provider-model-picker="true"]',
            ),
          "Unable to find provider model picker.",
        );

        await vi.waitFor(
          () => {
            const footerRect = footer.getBoundingClientRect();
            const leftRect = leftActions.getBoundingClientRect();
            const rightRect = rightActions.getBoundingClientRect();
            const addRect = addButton.getBoundingClientRect();

            const leftCenter = (leftRect.top + leftRect.bottom) / 2;
            const rightCenter = (rightRect.top + rightRect.bottom) / 2;
            expect(Math.abs(leftCenter - rightCenter)).toBeLessThanOrEqual(1);
            expect(addRect.left).toBeGreaterThanOrEqual(leftRect.left - 0.5);
            expect(addRect.right).toBeLessThanOrEqual(leftRect.right + 0.5);
            expect(leftRect.right).toBeLessThanOrEqual(rightRect.left + 0.5);
            expect(rightRect.right).toBeLessThanOrEqual(footerRect.right + 0.5);
            expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth + 1);
            expect(leftActions.scrollWidth).toBeLessThanOrEqual(leftActions.clientWidth + 1);
            // The provider icon plus at least a few characters of model name.
            expect(modelButton.getBoundingClientRect().width).toBeGreaterThan(48);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("drops the settings button's effort before the model name when the row narrows, and brings it back", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: fixture.snapshot,
      configureFixture: withEffortModel,
    });

    try {
      await waitForServerConfigToApply();
      const footer = await waitForElement(
        findVisibleComposerFooter,
        "Unable to find composer footer.",
      );
      const modelButton = await waitForElement(
        () => footer.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find provider model picker.",
      );
      const effort = await waitForElement(
        () => modelButton.querySelector<HTMLElement>('[data-model-picker-trigger-effort="true"]'),
        "Unable to find the settings button's effort.",
      );
      await vi.waitFor(() => {
        expect(effort.textContent).toContain("Medium");
        expect(getComputedStyle(effort).display).not.toBe("none");
      });

      await setVisibleComposerFormWidth(380);
      await vi.waitFor(() => {
        expect(getComputedStyle(effort).display).toBe("none");
        expect(modelButton.textContent).toContain("GPT-5");
        expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth + 1);
      });

      // The way back: room returns, so does the effort.
      await setVisibleComposerFormWidth(900);
      await vi.waitFor(() => {
        expect(getComputedStyle(effort).display).not.toBe("none");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("changes effort from the meter in the settings and stays open for more changes", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: fixture.snapshot,
      configureFixture: withEffortModel,
    });

    try {
      await waitForServerConfigToApply();
      const footer = await waitForElement(
        findVisibleComposerFooter,
        "Unable to find composer footer.",
      );
      const modelButton = await waitForElement(
        () => footer.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find provider model picker.",
      );
      const buttonEffort = () =>
        modelButton.querySelector<HTMLElement>('[data-model-picker-trigger-effort="true"]')
          ?.textContent;
      await vi.waitFor(() => expect(buttonEffort()).toContain("Medium"));

      modelButton.click();
      const meter = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-effort-meter="true"]'),
        "Unable to find the effort meter.",
      );
      const level = (id: string) =>
        meter.querySelector<HTMLButtonElement>(`[data-effort-level="${id}"]`)!;
      expect(level("medium").getAttribute("aria-checked")).toBe("true");

      level("high").click();
      await vi.waitFor(() => {
        expect(buttonEffort()).toContain("High");
        expect(level("high").getAttribute("aria-checked")).toBe("true");
      });
      // Still open: the model list and the rest of the settings are right there.
      expect(document.querySelector('[data-model-picker-settings="true"]')).not.toBeNull();

      // The arrow keys step one level at a time.
      level("high").focus();
      await userEvent.keyboard("{ArrowLeft}");
      await vi.waitFor(() => {
        expect(buttonEffort()).toContain("Medium");
        expect(document.activeElement).toBe(level("medium"));
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits pending user input only after explicitly reviewing the final answer", async () => {
    let resolveDispatch!: (value: { sequence: number }) => void;
    const pendingDispatch = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return pendingDispatch;
        }
        return undefined;
      },
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();
      (await waitForButtonByText("Next question")).click();

      const finalOption = await waitForButtonContainingText("Conservative");
      finalOption.click();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.user-input.respond",
        ),
      ).toBe(false);
      (await waitForButtonByText("Submit answers")).click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.user-input.respond",
          ) as
            | {
                _tag: string;
                type?: string;
                requestId?: string;
                answers?: Record<string, unknown>;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.user-input.respond",
            requestId: "req-browser-user-input",
            answers: {
              scope: "Tight",
              risk: "Conservative",
            },
          });
          expect(finalOption.disabled).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      finalOption.click();
      expect(
        wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.user-input.respond",
        ),
      ).toHaveLength(1);
      resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    { name: "async desktop", viewport: DEFAULT_VIEWPORT, isBlocking: false },
    { name: "async phone", viewport: PHONE_VIEWPORT, isBlocking: false },
    { name: "blocking desktop", viewport: DEFAULT_VIEWPORT, isBlocking: true },
    { name: "blocking phone", viewport: PHONE_VIEWPORT, isBlocking: true },
  ])(
    "keeps answer typing separate from the Stop-to-Steer composer switch ($name)",
    async ({ name, viewport, isBlocking }) => {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, isBlocking ? "Keep checking the repository while I sign in." : "");
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotWithPendingUserInput({ isBlocking, running: true, signIn: true }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            environment: {
              ...nextFixture.serverConfig.environment,
              serverVersion: import.meta.env.APP_VERSION,
            },
          };
          nextFixture.welcome = {
            ...nextFixture.welcome,
            environment: {
              ...nextFixture.welcome.environment,
              serverVersion: import.meta.env.APP_VERSION,
            },
          };
        },
      });
      try {
        document.documentElement.classList.add("dark");
        const stop = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          "Stop must remain available when only the answer field has text.",
        );
        (await waitForButtonContainingText("Only one worked")).click();
        await page
          .getByLabelText("Custom answer", { exact: true })
          .fill("Codex is ready. Claude still needs help.", { timeout: 5_000 });
        expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
          isBlocking ? "Keep checking the repository while I sign in." : "",
        );
        // Plain DOM clicks: Playwright hit-tests the click point, and on phone
        // the scroll-to-bottom pill can cover the panel header while the
        // timeline is still settling to the end.
        (await waitForButtonByAriaLabel("Collapse questions")).click();
        await expect.element(stop, { timeout: 5_000 }).toBeVisible();
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.user-input.respond",
          ),
        ).toBe(false);
        (await waitForButtonByAriaLabel("Expand questions")).click();
        await expect
          .element(page.getByLabelText("Custom answer", { exact: true }), { timeout: 5_000 })
          .toHaveValue("Codex is ready. Claude still needs help.");
        if (!isBlocking) {
          const editor = page.getByTestId("composer-editor");
          await editor.fill("Keep checking the repository while I sign in.", { timeout: 5_000 });
          await waitForComposerText("Keep checking the repository while I sign in.");
          await waitForButtonByAriaLabel("Steer active turn");
          expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
          // Clear through the draft store. Playwright's empty fill presses Delete
          // over a select-all, which the editor does not reliably turn into an
          // empty draft, and the point here is the empty-draft state, not the key.
          useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
          await waitForButtonByAriaLabel("Stop generation");
          expect(document.querySelector('button[aria-label="Steer active turn"]')).toBeNull();
          await editor.fill("Keep checking the repository while I sign in.", { timeout: 5_000 });
          await waitForComposerText("Keep checking the repository while I sign in.");
          await waitForButtonByAriaLabel("Steer active turn");
        }
        await expectQuestionActionsContained();
        if (isBlocking) {
          // The blocked row keeps the saved draft readable and Stop inside it.
          const blockedRow = await waitForElement(
            () =>
              document.querySelector<HTMLElement>(
                '[data-chat-composer-blocked-by-question="true"]',
              ),
            "Unable to find the blocked composer row.",
          );
          expect(blockedRow.textContent).toContain("Keep checking the repository while I sign in.");
          expect(blockedRow.contains(stop)).toBe(true);
          expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
          // The draft check above is the regression guard; the screenshot shows
          // the common case of an empty composer.
          useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
          await vi.waitFor(() => {
            expect(blockedRow.textContent).toContain("Answer the question above, or stop the turn");
          });
        } else {
          await expectComposerActionsContained();
        }
        await page.screenshot({
          path: `__screenshots__/question-${name.replaceAll(" ", "-")}.png`,
        });
        if (isBlocking) {
          expect(document.querySelector('[contenteditable="true"]')).toBeNull();
          stop.click();
          await vi.waitFor(() => {
            expect(
              wsRequests.find(
                (request) =>
                  request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                  request.type === "thread.turn.interrupt",
              ),
            ).toMatchObject({ turnId: "turn-pending-input" });
          });
        } else {
          expect(document.body.textContent).toContain("The agent keeps working while you answer.");
          await expect
            .element(await waitForComposerEditor(), { timeout: 5_000 })
            .toMatchTextContent("Keep checking the repository while I sign in.");
          (await waitForButtonByText("Submit answer")).click();
          await vi.waitFor(() => {
            expect(
              wsRequests.find(
                (request) =>
                  request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                  request.type === "thread.user-input.respond",
              ),
            ).toMatchObject({ answers: { sign_in: "Codex is ready. Claude still needs help." } });
          });
          await page.getByLabelText("Steer active turn").click({ timeout: 5_000 });
          await vi.waitFor(() => {
            expect(
              wsRequests.find(
                (request) =>
                  request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                  request.type === "thread.follow-up.submit",
              ),
            ).toMatchObject({ message: { text: "Keep checking the repository while I sign in." } });
          });
        }
      } finally {
        document.documentElement.classList.remove("dark");
        await mounted.cleanup();
      }
    },
  );

  it.each([
    { name: "desktop", viewport: DEFAULT_VIEWPORT },
    { name: "phone", viewport: PHONE_VIEWPORT },
  ])(
    "keeps Stop reachable when an approval overlaps an async question ($name)",
    async ({ viewport }) => {
      const snapshot = createSnapshotWithPendingUserInput({ isBlocking: false, running: true });
      const mounted = await mountChatView({
        viewport,
        snapshot: {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id !== THREAD_ID
              ? thread
              : {
                  ...thread,
                  activities: [
                    ...thread.activities,
                    {
                      id: EventId.make("activity-overlapping-approval"),
                      kind: "approval.requested",
                      tone: "info",
                      summary: "Approval requested",
                      payload: {
                        requestId: "req-overlapping-approval",
                        requestKind: "command",
                        detail: "git status",
                      },
                      turnId: "turn-pending-input" as TurnId,
                      sequence: 2,
                      createdAt: isoAt(1_001),
                    },
                  ],
                },
          ),
        },
      });
      try {
        await expect.element(page.getByText("Command approval requested")).toBeVisible();
        const stop = page.getByLabelText("Stop generation");
        await expect.element(stop).toBeVisible();
        expect(document.querySelectorAll('button[aria-label="Stop generation"]')).toHaveLength(1);
        await stop.click();
        await vi.waitFor(() => {
          expect(
            wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.interrupt",
            ),
          ).toMatchObject({ turnId: "turn-pending-input" });
        });
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("shows why the agent asks and leaves out Always allow when the agent says so", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-approval-words" as MessageId,
      targetText: "approval words target",
      sessionStatus: "running",
      sessionActiveTurnId: "turn-approval-words" as TurnId,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id !== THREAD_ID
            ? thread
            : {
                ...thread,
                activities: [
                  ...thread.activities,
                  {
                    id: EventId.make("activity-approval-words"),
                    kind: "approval.requested",
                    tone: "info",
                    summary: "File-read approval requested",
                    payload: {
                      requestId: "req-approval-words",
                      requestKind: "file-read",
                      toolName: "Read",
                      detail: "/Users/me/.ssh/config",
                      title: "Claude wants to read a file outside this project",
                      reason: "Path is outside the allowed working directories",
                      description: "Claude will have read access to files in ~/.ssh",
                      // Exactly the detail above: not repeated.
                      blockedPath: "/Users/me/.ssh/config",
                      availableDecisions: ["accept", "decline", "cancel"],
                      defaultToNo: true,
                    },
                    turnId: "turn-approval-words" as TurnId,
                    sequence: 2,
                    createdAt: isoAt(1_001),
                  },
                ],
              },
        ),
      },
    });
    try {
      await expect
        .element(page.getByTestId("pending-approval-heading"))
        .toHaveTextContent("Claude wants to read a file outside this project");
      await expect
        .element(page.getByTestId("pending-approval-detail"))
        .toHaveTextContent("/Users/me/.ssh/config");
      const notes = document.querySelector<HTMLElement>('[data-pending-approval-notes="true"]');
      expect(notes?.textContent).toContain("Why: Path is outside the allowed working directories");
      expect(notes?.textContent).toContain("Claude will have read access to files in ~/.ssh");
      expect(notes?.textContent).not.toContain("Path:");
      await expect.element(page.getByRole("button", { name: "Approve once" })).toBeVisible();
      expect(
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "Always allow this session",
        ),
      ).toBe(false);

      // Focus left on Approve must not carry to the next request: answered
      // elsewhere, this one gives way to another the agent wants said no to.
      const appendActivity = (sequence: number, kind: string, payload: Record<string, unknown>) =>
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "event",
          event: {
            sequence: fixture.snapshot.snapshotSequence + sequence,
            eventId: EventId.make(`evt-approval-words-${sequence}`),
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            occurredAt: NOW_ISO,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.activity-appended",
            payload: {
              threadId: THREAD_ID,
              activity: {
                id: EventId.make(`activity-approval-words-${sequence}`),
                kind,
                tone: "info",
                summary: kind,
                payload,
                turnId: "turn-approval-words" as TurnId,
                createdAt: isoAt(1_001 + sequence),
              },
            },
          },
        });
      (await waitForButtonByText("Approve once")).focus();
      appendActivity(1, "approval.requested", {
        requestId: "req-approval-next",
        requestKind: "command",
        detail: "git push --force",
        defaultToNo: true,
      });
      appendActivity(2, "approval.resolved", { requestId: "req-approval-words" });
      await expect
        .element(page.getByTestId("pending-approval-detail"))
        .toHaveTextContent("git push --force");
      expect(document.activeElement?.textContent).not.toBe("Approve once");
    } finally {
      await mounted.cleanup();
    }
  });

  it("declines a waiting approval and steers the turn with a message typed meanwhile", async () => {
    // "Send when done" is picked, and still the message steers: the turn is
    // waiting on the user, so waiting for it to finish would never send.
    updateSettings({ followUpDelivery: "queue" });
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-approval-redirect" as MessageId,
      targetText: "approval redirect target",
      sessionStatus: "running",
      sessionActiveTurnId: "turn-approval-redirect" as TurnId,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id !== THREAD_ID
            ? thread
            : {
                ...thread,
                activities: [
                  ...thread.activities,
                  {
                    id: EventId.make("activity-approval-redirect"),
                    kind: "approval.requested",
                    tone: "info",
                    summary: "Approval requested",
                    payload: {
                      requestId: "req-approval-redirect",
                      requestKind: "command",
                      detail: "rm -rf build",
                    },
                    turnId: "turn-approval-redirect" as TurnId,
                    sequence: 2,
                    createdAt: isoAt(1_001),
                  },
                ],
              },
        ),
      },
    });
    const dispatchIndex = (type: string) =>
      wsRequests.findIndex(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && request.type === type,
      );
    try {
      await expect.element(page.getByText("Command approval requested")).toBeVisible();
      const editor = await waitForComposerEditor();
      expect(editor.getAttribute("aria-placeholder")).toBe(
        "Type to decline and tell the agent what to do instead",
      );
      await waitForButtonByAriaLabel("Stop generation");

      await page
        .getByTestId("composer-editor")
        .fill("Use the clean script instead", { timeout: 5_000 });
      await waitForComposerText("Use the clean script instead");
      (await waitForButtonByAriaLabel("Decline and send")).click();

      await vi.waitFor(() => {
        expect(wsRequests[dispatchIndex("thread.approval.respond")]).toMatchObject({
          requestId: "req-approval-redirect",
          decision: "decline",
        });
        expect(wsRequests[dispatchIndex("thread.follow-up.submit")]).toMatchObject({
          turnId: "turn-approval-redirect",
          delivery: "steer",
          message: { text: "Use the clean script instead" },
        });
      });
      // The agent hears "no" before it reads what to do instead.
      expect(dispatchIndex("thread.approval.respond")).toBeLessThan(
        dispatchIndex("thread.follow-up.submit"),
      );
    } finally {
      updateSettings({ followUpDelivery: "steer" });
      await mounted.cleanup();
    }
  });

  it("does not implement a plan on Enter while an approval waits, and declines it for feedback", async () => {
    // A background agent asked after the plan turn settled.
    const snapshot = createSnapshotWithPlanFollowUpPrompt();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id !== THREAD_ID
            ? thread
            : {
                ...thread,
                activities: [
                  ...thread.activities,
                  {
                    id: EventId.make("activity-plan-approval"),
                    kind: "approval.requested",
                    tone: "info",
                    summary: "Approval requested",
                    payload: {
                      requestId: "req-plan-approval",
                      requestKind: "command",
                      detail: "npm run lint",
                    },
                    turnId: null,
                    sequence: 90,
                    createdAt: isoAt(1_090),
                  },
                ],
              },
        ),
      },
    });
    const dispatchIndex = (type: string) =>
      wsRequests.findIndex(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && request.type === type,
      );
    try {
      await expect.element(page.getByText("Command approval requested")).toBeVisible();
      (await waitForComposerEditor()).focus();
      await userEvent.keyboard("{Enter}");

      await page.getByTestId("composer-editor").fill("Skip the second step", { timeout: 5_000 });
      await waitForComposerText("Skip the second step");
      (await waitForButtonByAriaLabel("Decline and send")).click();
      await vi.waitFor(() => {
        expect(wsRequests[dispatchIndex("thread.approval.respond")]).toMatchObject({
          requestId: "req-plan-approval",
          decision: "decline",
        });
        expect(wsRequests[dispatchIndex("thread.turn.start")]).toMatchObject({
          message: { text: expect.stringContaining("Skip the second step") },
        });
      });
      expect(dispatchIndex("thread.approval.respond")).toBeLessThan(
        dispatchIndex("thread.turn.start"),
      );
      // The empty Enter sent nothing: the one turn is the feedback.
      expect(
        wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("stops one background command through the agent from the runs list", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-stop-one-task" as MessageId,
      targetText: "stop one task target",
      sessionStatus: "ready",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                session: thread.session
                  ? { ...thread.session, pendingBackgroundTaskCount: 1 }
                  : thread.session,
                activities: [
                  ...thread.activities,
                  {
                    id: EventId.make("activity-dev-server-started"),
                    kind: "task.started",
                    tone: "info",
                    summary: "background-command task started",
                    payload: {
                      taskId: "task-dev-server",
                      taskType: "background-command",
                      detail: "Start the web dev server",
                      stoppable: true,
                    },
                    turnId: null,
                    sequence: 50,
                    createdAt: isoAt(1_050),
                  },
                ],
              }
            : thread,
        ),
      },
    });
    try {
      await page.getByRole("button", { name: "1 background run" }).click();
      await page.getByRole("button", { name: "Stop Start the web dev server" }).click();
      await vi.waitFor(() => {
        expect(
          wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.background-task.stop",
          ),
        ).toMatchObject({ threadId: THREAD_ID, taskId: "task-dev-server" });
      });
      // One task, not the session.
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.session.stop",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes a failed turn's error on the server and keeps the message's Retry", async () => {
    const offline = "API Error: Can't reach the API server (ENOTFOUND)";
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-error-close" as MessageId,
      targetText: "error close target",
      sessionStatus: "error",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID && thread.session
            ? { ...thread, session: { ...thread.session, activeTurnId: null, lastError: offline } }
            : thread,
        ),
      },
    });
    try {
      await expect.element(page.getByText(offline)).toBeVisible();
      await page.getByLabelText("Dismiss error").click();
      await vi.waitFor(() => {
        expect(
          wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.error.dismiss",
          ),
        ).toMatchObject({ threadId: THREAD_ID, lastError: offline, lastErrorAt: null });
      });
      await expect.element(page.getByText(offline)).not.toBeInTheDocument();
      await expect.element(page.getByLabelText("Retry this message")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Stop for the background work a failed turn left running", async () => {
    // A turn that died on a usage limit while two dev servers it started kept
    // going: the thread still waits on them, and the agent can't be asked to
    // stop them, so the composer has to.
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-background-stop" as MessageId,
      targetText: "background stop target",
      sessionStatus: "error",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                latestTurn: {
                  turnId: "turn-background-stop" as TurnId,
                  state: "error",
                  requestedAt: NOW_ISO,
                  startedAt: NOW_ISO,
                  completedAt: NOW_ISO,
                  assistantMessageId: null,
                },
                session: thread.session
                  ? {
                      ...thread.session,
                      activeTurnId: null,
                      lastError: "You've hit your session limit",
                      pendingBackgroundTaskCount: 2,
                      awaitedBackgroundTaskCount: 2,
                      awaitedBackgroundTasks: [
                        { kind: "command" as const, description: "Start the web dev server" },
                        { kind: "command" as const, description: "Start the test server" },
                      ],
                    }
                  : thread.session,
              }
            : thread,
        ),
      },
    });
    try {
      const stop = page.getByLabelText("Stop background work");
      await expect.element(stop).toBeVisible();
      await stop.click();
      await vi.waitFor(() => {
        expect(
          wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.session.stop",
          ),
        ).toMatchObject({ threadId: THREAD_ID });
      });
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.interrupt",
        ),
        "There is no turn to interrupt.",
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("says whose outside work limits the agent's tools until Start fresh stops it", async () => {
    // Assistants worked in this thread, so its agent's Threadlines tools only
    // read. Start fresh stops the session; the server clears the mark once
    // the agent is gone, and the notice goes with it.
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-outside-work" as MessageId,
      targetText: "outside work target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                outsideWork: [
                  {
                    participantId: null,
                    connections: [
                      {
                        connectionId: OutsideAgentConnectionId.make("connection-grok"),
                        name: "Grok Bot",
                      },
                      {
                        connectionId: OutsideAgentConnectionId.make("connection-dots"),
                        name: "dots",
                      },
                    ],
                    since: NOW_ISO,
                    version: 1,
                  },
                ],
              }
            : thread,
        ),
      },
      resolveRpc: (body) => {
        if (
          body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
          body.type !== "thread.session.stop"
        ) {
          return undefined;
        }
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: fixture.snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? { ...thread, outsideWork: [] } : thread,
          ),
        };
        queueMicrotask(() => sendShellThreadUpsert(THREAD_ID));
        return { sequence: fixture.snapshot.snapshotSequence };
      },
    });
    try {
      await expect.element(page.getByText("Grok Bot and dots worked here.")).toBeVisible();
      await expect.element(page.getByText("Tools are limited until a fresh start.")).toBeVisible();
      await page.getByRole("button", { name: "Start fresh" }).click();
      await vi.waitFor(() => {
        expect(
          wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.session.stop",
          ),
        ).toMatchObject({ threadId: THREAD_ID });
      });
      await expect
        .element(page.getByText("Grok Bot and dots worked here."))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("queues a message for after the turn, and Stop puts queued messages back in the box", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-queue-test" as MessageId,
      targetText: "queue target",
      sessionStatus: "running",
      sessionActiveTurnId: "turn-queue-test" as TurnId,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                queuedFollowUps: [
                  {
                    messageId: "msg-queued-earlier" as MessageId,
                    text: "then run the tests",
                    attachments: [],
                    runtimeMode: "full-access" as const,
                    interactionMode: "default" as const,
                    createdAt: NOW_ISO,
                  },
                ],
              }
            : thread,
        ),
      },
    });
    const dispatched = (type: string) =>
      wsRequests.find(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && request.type === type,
      );
    try {
      await expect.element(page.getByText("then run the tests"), { timeout: 5_000 }).toBeVisible();

      const editor = page.getByTestId("composer-editor");
      await editor.fill("and update the changelog", { timeout: 5_000 });
      await waitForComposerText("and update the changelog");
      await page.getByLabelText("Choose how this message is sent").click({ timeout: 5_000 });
      await page.getByRole("menuitemradio", { name: "Send when done" }).click({ timeout: 5_000 });
      await page.getByLabelText("Send when this reply finishes").click({ timeout: 5_000 });
      await vi.waitFor(() => {
        expect(dispatched("thread.follow-up.submit")).toMatchObject({
          delivery: "queue",
          message: { text: "and update the changelog" },
        });
      });

      await page.getByLabelText("Stop generation").click({ timeout: 5_000 });
      await vi.waitFor(() => {
        expect(dispatched("thread.follow-up.unqueue")).toMatchObject({
          messageId: "msg-queued-earlier",
        });
        expect(dispatched("thread.turn.interrupt")).toBeDefined();
      });
      await waitForComposerText("then run the tests");
    } finally {
      updateSettings({ followUpDelivery: "steer" });
      await mounted.cleanup();
    }
  });

  it("names the agent on the working row while its program starts", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-launching-agent" as MessageId,
      targetText: "launching agent target",
      sessionStatus: "starting",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID && thread.session
            ? {
                ...thread,
                session: {
                  ...thread.session,
                  startup: {
                    phase: "launching",
                    providerInstanceId: ProviderInstanceId.make("codex"),
                  },
                },
              }
            : thread,
        ),
      },
    });

    try {
      await vi.waitFor(
        () => {
          const anchor = document.querySelector<HTMLElement>('[data-turn-working-anchor="true"]');
          expect(
            anchor?.querySelector('[data-turn-working-label="true"]')?.textContent?.trim(),
          ).toMatch(/^Starting Codex/);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset =
        initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;
      const initialImplementButton = await waitForButtonByTextWithin(footer, "Implement");
      const initialImplementWidth = initialImplementButton.getBoundingClientRect().width;

      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await mounted.setComposerWidth(NARROW_DESKTOP_COMPOSER_WIDTH);
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByTextWithin(footer, "Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(
        () => {
          const implementRect = implementButton.getBoundingClientRect();
          const implementActionsRect = implementActionsButton.getBoundingClientRect();
          const compactModelPicker = findComposerProviderModelPicker();
          expect(compactModelPicker).toBeTruthy();

          const compactModelPickerOffset =
            compactModelPicker!.getBoundingClientRect().left - footer.getBoundingClientRect().left;

          expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.width - initialImplementWidth)).toBeLessThanOrEqual(1);
          expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the wide desktop follow-up layout expanded when the footer still fits", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex-spark",
        },
        planMarkdown:
          "# Imaginary Long-Range Plan: Threadlines Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer).toBeTruthy();
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the footer on one row when a wide desktop follow-up layout starts overflowing", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex-spark",
        },
        planMarkdown:
          "# Imaginary Long-Range Plan: Threadlines Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await mounted.setContainerSize({
        width: 804,
        height: WIDE_FOOTER_VIEWPORT.height,
      });

      await expectComposerActionsContained();

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("true");
          expect(footer).toBeTruthy();
          expect(footer!.scrollWidth).toBeLessThanOrEqual(footer!.clientWidth + 1);
          const leftActions = footer!.querySelector<HTMLElement>(
            '[data-chat-composer-actions="left"]',
          );
          expect(leftActions).toBeTruthy();
          expect(leftActions!.scrollWidth).toBeLessThanOrEqual(leftActions!.clientWidth + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
