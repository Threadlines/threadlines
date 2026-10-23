import {
  type MessageId,
  ScheduledTaskError,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskWebhookCadence,
  type ScheduledTaskWebhookState,
  type ThreadId,
  type WebhookEventDetail,
  type WebhookEventRecord,
  WS_METHODS,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { page, userEvent } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useScheduledTasksStore } from "../lib/scheduledTasksState";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import {
  PROJECT_ID,
  THREAD_ID,
  NOW_ISO,
  rpcHarness,
  wsRequests,
  WIDE_FOOTER_VIEWPORT,
  PHONE_VIEWPORT,
  createSnapshotForTargetUser,
  clickSelectItemContainingText,
  waitForServerConfigToApply,
  mountChatView,
  registerChatViewSuiteHooks,
  type TestFixture,
  withCodexModels,
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

const TASK_ID = "task-triage" as ScheduledTaskId;
const RELAY_URL = "https://relay.threadlines.dev/v2/hooks/host-1/hook-1/mac-1";
const LOCAL_URL = "http://127.0.0.1:3773/api/hooks/hook-1/local-token";

const CADENCE: ScheduledTaskWebhookCadence = {
  kind: "webhook",
  source: "github",
  github: {
    repository: "acme/app",
    when: "issue_labeled",
    label: "agent",
    from: { kind: "people", logins: ["badcuban"] },
    ignoreBots: true,
    onePerSubject: false,
  },
  filters: [],
  includeEvent: true,
  maxLateMinutes: 1440,
  dailyRunLimit: 20,
};

const WEBHOOK_STATE: ScheduledTaskWebhookState = {
  address: "ready",
  addressChanged: false,
  github: false,
  signingSecretSet: true,
  lastEventAt: null,
};

function eventTask(webhook: Partial<ScheduledTaskWebhookState> = {}): ScheduledTask {
  return {
    id: TASK_ID,
    name: "Triage labeled issues",
    prompt: "Read the issue and propose a fix.",
    projectId: PROJECT_ID,
    checkout: "local",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    cadence: CADENCE,
    timeZone: "UTC",
    target: { kind: "new_thread" },
    status: "active",
    error: null,
    nextRunAt: null,
    lastRun: null,
    workingRuns: 0,
    originThreadId: null,
    webhook: { ...WEBHOOK_STATE, ...webhook },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  } as ScheduledTask;
}

function eventRecord(patch: Partial<WebhookEventRecord> & { eventId: string }): WebhookEventRecord {
  return {
    taskId: TASK_ID,
    receivedAt: NOW_ISO,
    source: "relay",
    status: "ran",
    reason: null,
    summary: null,
    eventName: "issues.labeled",
    sender: "badcuban",
    threadId: null,
    canReplay: false,
    ...patch,
  } as WebhookEventRecord;
}

function eventDetail(event: WebhookEventRecord, message: string | null): WebhookEventDetail {
  return {
    event,
    headers: { "x-github-event": "issues", "x-hub-signature-256": "[redacted]" },
    body: '{"action":"labeled","label":{"name":"agent"}}',
    bodyTruncated: false,
    message,
    missingFields: [],
  };
}

/** A computer that runs scheduled tasks, and event tasks unless told otherwise. */
function withScheduledCapabilities(eventTasks: boolean) {
  return (nextFixture: TestFixture) => {
    const capabilities = {
      repositoryIdentity: true,
      scheduledTasks: true,
      ...(eventTasks ? { eventTasks: true } : {}),
    } as const;
    nextFixture.serverConfig = {
      ...nextFixture.serverConfig,
      environment: { ...nextFixture.serverConfig.environment, capabilities },
    };
    nextFixture.welcome = {
      ...nextFixture.welcome,
      environment: { ...nextFixture.welcome.environment, capabilities },
    };
  };
}

const snapshot = () =>
  createSnapshotForTargetUser({
    targetMessageId: "msg-user-event-tasks" as MessageId,
    targetText: "event tasks",
  });

/** Waits for the Scheduled page's subscription, then sends the computer's tasks. */
async function sendTasks(tasks: ReadonlyArray<ScheduledTask>) {
  await waitForServerConfigToApply();
  await vi.waitFor(
    () =>
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.scheduledTasksSubscribe),
      ).toBe(true),
    { timeout: 8_000, interval: 16 },
  );
  rpcHarness.emitStreamValue(WS_METHODS.scheduledTasksSubscribe, {
    tasks,
    requests: [],
    timeZone: "UTC",
  });
}

const requestsOf = (tag: string) => wsRequests.filter((request) => request._tag === tag);

const byTestId = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** The control a select trigger is, found by its accessible name. */
async function openSelect(label: string) {
  const trigger = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    expect(element).not.toBeNull();
    return element!;
  });
  trigger.click();
}

const detailPath = `/scheduled?environment=environment-local&task=${TASK_ID}`;

describe("ChatView (full app): event tasks", () => {
  registerChatViewSuiteHooks();
  beforeEach(() => {
    useScheduledTasksStore.setState({ byEnvironment: {} });
  });

  it("creates a GitHub event task from the project's repository and the signed-in user", async () => {
    const resolveRpc = (body: NormalizedWsRpcRequestBody) => {
      if (body._tag === WS_METHODS.scheduledTasksGitHubContext) {
        return { repository: "acme/app", login: "badcuban", canConnect: true };
      }
      if (body._tag === WS_METHODS.scheduledTasksCreate) {
        return { ...eventTask(), ...body, id: TASK_ID };
      }
      return undefined;
    };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: snapshot(),
      initialPath: "/scheduled?view=new",
      configureFixture: (nextFixture) => {
        withScheduledCapabilities(true)(nextFixture);
        withCodexModels(nextFixture);
      },
      resolveRpc,
    });
    try {
      await sendTasks([]);
      // An app that shows event tasks says so, or the computer leaves them out.
      expect(requestsOf(WS_METHODS.scheduledTasksSubscribe)[0]).toMatchObject({
        supports: ["webhook"],
      });

      await userEvent.fill(page.getByTestId("scheduled-form-name"), "Triage labeled issues");
      await userEvent.fill(
        page.getByTestId("scheduled-form-prompt"),
        "Read the issue and propose a fix.",
      );
      await openSelect("Runs");
      await clickSelectItemContainingText("When something happens");

      // The repository and the only sender come from the project and gh.
      await expect.element(page.getByTestId("scheduled-event-repository")).toHaveValue("acme/app");
      await expect.element(page.getByTestId("scheduled-event-person-badcuban")).toBeVisible();
      // A new event task asks before changes.
      await expect.element(page.getByLabelText("Access")).toHaveTextContent("Supervised");
      expect(byTestId("scheduled-form-time-zone")).toBeNull();

      await userEvent.fill(page.getByTestId("scheduled-event-label"), "agent");

      // Anyone asks first, naming who could start a run.
      await page.getByTestId("scheduled-event-anyone").click();
      await expect
        .element(
          page.getByText(
            "Anyone who can comment on acme/app can start a run with this task's access.",
          ),
        )
        .toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect.element(page.getByTestId("scheduled-event-person-badcuban")).toBeVisible();
      await page.getByTestId("scheduled-event-anyone").click();
      await page.getByTestId("scheduled-event-anyone-confirm").click();
      await vi.waitFor(() => expect(byTestId("scheduled-event-people")).toBeNull());

      // Full access with anyone is said before saving.
      await openSelect("Access");
      await clickSelectItemContainingText("Full access");
      await expect
        .element(
          page.getByText("Anyone who can comment on acme/app can start a run with full access."),
        )
        .toBeVisible();
      await openSelect("Access");
      await clickSelectItemContainingText("Supervised");

      await page.getByTestId("scheduled-form-save").click();
      await vi.waitFor(() => expect(requestsOf(WS_METHODS.scheduledTasksCreate)).toHaveLength(1));
      expect(requestsOf(WS_METHODS.scheduledTasksCreate)[0]).toMatchObject({
        name: "Triage labeled issues",
        runtimeMode: "approval-required",
        target: { kind: "new_thread" },
        cadence: {
          kind: "webhook",
          source: "github",
          github: {
            repository: "acme/app",
            when: "issue_labeled",
            label: "agent",
            from: { kind: "anyone" },
            ignoreBots: true,
            onePerSubject: false,
          },
          filters: [],
          includeEvent: true,
          maxLateMinutes: 1440,
          dailyRunLimit: 20,
        },
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers only clock schedules on a computer that doesn't run event tasks", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: snapshot(),
      initialPath: "/scheduled?view=new",
      configureFixture: withScheduledCapabilities(false),
    });
    try {
      await sendTasks([]);
      await openSelect("Runs");
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[data-slot="select-item"]').length).toBeGreaterThan(0),
      );
      const items = [...document.querySelectorAll('[data-slot="select-item"]')].map(
        (item) => item.textContent,
      );
      expect(items).toContain("Weekdays");
      expect(items).not.toContain("When something happens");
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Add to GitHub, falls back to the steps by hand, and waits for the relay's address", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: snapshot(),
      initialPath: detailPath,
      configureFixture: withScheduledCapabilities(true),
      resolveRpc: (body) => {
        switch (body._tag) {
          case WS_METHODS.scheduledTasksWebhookAddress:
            return { relayUrl: RELAY_URL, localUrl: LOCAL_URL };
          case WS_METHODS.scheduledTasksGitHubContext:
            return { repository: "acme/app", login: "badcuban", canConnect: true };
          case WS_METHODS.scheduledTasksConnectGitHub:
            return Effect.fail(
              new ScheduledTaskError({ detail: "You need admin rights on acme/app." }),
            );
          case WS_METHODS.scheduledTasksListWebhookEvents:
            return { events: [], hasMore: false };
          case WS_METHODS.scheduledTasksListRuns:
            return { runs: [], hasMore: false };
          default:
            return undefined;
        }
      },
    });
    try {
      await sendTasks([eventTask()]);
      await expect.element(page.getByTestId("scheduled-event-address")).toBeVisible();
      // An event task is tried with a test event, not run by hand.
      await expect.element(page.getByTestId("scheduled-send-test-event")).toBeVisible();
      expect(byTestId("scheduled-run-now")).toBeNull();
      await expect
        .element(page.getByTestId("scheduled-event-local-url"))
        .toHaveTextContent(LOCAL_URL);
      await expect
        .element(
          page.getByText(
            "Events reach this computer through the Threadlines relay. If it's off, they wait up to a day.",
          ),
        )
        .toBeVisible();

      await page.getByTestId("scheduled-event-connect").click();
      await vi.waitFor(() =>
        expect(requestsOf(WS_METHODS.scheduledTasksConnectGitHub)).toHaveLength(1),
      );
      // Without admin rights it can still be added by hand.
      await expect.element(page.getByTestId("scheduled-event-github-steps")).toBeVisible();
      await expect
        .element(page.getByTestId("scheduled-event-relay-url"))
        .toHaveTextContent(RELAY_URL);
      await expect.element(page.getByLabelText("Copy the payload URL")).toBeVisible();
      await expect
        .element(page.getByTestId("scheduled-event-github-events"))
        .toHaveTextContent("Issues");
      await expect.element(page.getByRole("button", { name: "Reveal" })).toBeVisible();

      // Until the relay gives the task an address, it says so.
      rpcHarness.emitStreamValue(WS_METHODS.scheduledTasksSubscribe, {
        tasks: [eventTask({ address: "waiting_for_relay" })],
        requests: [],
        timeZone: "UTC",
      });
      await expect
        .element(page.getByTestId("scheduled-event-relay-url"))
        .toHaveTextContent("Getting this task's address from the relay…");

      // Connected through GitHub: the repository, and the way back out.
      rpcHarness.emitStreamValue(WS_METHODS.scheduledTasksSubscribe, {
        tasks: [eventTask({ github: true })],
        requests: [],
        timeZone: "UTC",
      });
      await expect
        .element(page.getByTestId("scheduled-event-github-connected"))
        .toMatchTextContent("acme/app");
      await expect.element(page.getByTestId("scheduled-event-disconnect")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists events with their outcome in words, and opens one to what the agent got", async () => {
    const ran = eventRecord({
      eventId: "event-ran",
      summary: "Issue #12 in acme/app labeled agent by @badcuban",
      // The run's thread, here the one the app already has.
      threadId: THREAD_ID,
      canReplay: true,
    });
    const skipped = eventRecord({
      eventId: "event-skipped",
      status: "skipped",
      reason: "Started by @someone, who isn't on this task's list.",
      summary: "Issue #13 in acme/app labeled agent by @someone",
      sender: "someone",
    });
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: snapshot(),
      initialPath: detailPath,
      configureFixture: withScheduledCapabilities(true),
      resolveRpc: (body) => {
        switch (body._tag) {
          case WS_METHODS.scheduledTasksWebhookAddress:
            return { relayUrl: RELAY_URL, localUrl: LOCAL_URL };
          case WS_METHODS.scheduledTasksGitHubContext:
            return { repository: "acme/app", login: "badcuban", canConnect: false };
          case WS_METHODS.scheduledTasksListWebhookEvents:
            return { events: [ran, skipped], hasMore: false };
          case WS_METHODS.scheduledTasksWebhookEvent:
            return eventDetail(ran, "Event task: Triage labeled issues. Read the issue.");
          case WS_METHODS.scheduledTasksRunWithWebhookEvent:
            return eventRecord({ eventId: "event-replay", source: "replay" });
          case WS_METHODS.scheduledTasksListRuns:
            return {
              runs: [
                {
                  taskId: TASK_ID,
                  slotUtc: NOW_ISO,
                  trigger: "webhook",
                  status: "started",
                  reason: null,
                  threadId: THREAD_ID,
                  summary: null,
                  event: { eventId: "event-ran", summary: ran.summary },
                  createdAt: NOW_ISO,
                  updatedAt: NOW_ISO,
                },
              ],
              hasMore: false,
            };
          default:
            return undefined;
        }
      },
    });
    try {
      await sendTasks([eventTask()]);
      await expect
        .element(page.getByTestId("scheduled-event-outcome-event-ran"))
        .toHaveTextContent("Started a run · Open thread");
      await expect
        .element(page.getByTestId("scheduled-event-outcome-event-skipped"))
        .toHaveTextContent("Skipped. Started by @someone, who isn't on this task's list.");
      // The run it started names the event in the task's run history.
      await expect
        .element(page.getByTestId(`scheduled-run-event-${NOW_ISO}`))
        .toHaveTextContent("Issue #12 in acme/app labeled agent by @badcuban");
      expect(requestsOf(WS_METHODS.scheduledTasksListRuns)[0]).toMatchObject({
        supports: ["webhook"],
      });

      await page
        .getByTestId("scheduled-event-event-ran")
        .getByRole("button", { name: /Issue #12/ })
        .click();
      await expect
        .element(page.getByTestId("scheduled-event-message"))
        .toHaveTextContent("Event task: Triage labeled issues. Read the issue.");
      await expect.element(page.getByText("x-github-event")).toBeVisible();
      await page.getByTestId("scheduled-event-replay").click();
      await vi.waitFor(() =>
        expect(requestsOf(WS_METHODS.scheduledTasksRunWithWebhookEvent)).toEqual([
          expect.objectContaining({ id: TASK_ID, eventId: "event-ran" }),
        ]),
      );

      // The event links to the thread its run started.
      await page
        .getByTestId("scheduled-event-outcome-event-ran")
        .getByRole("button", { name: "Open thread" })
        .click();
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(`/environment-local/${THREAD_ID}`),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends a test event as a dry run, showing the message, then starts a run with it", async () => {
    const tested = eventRecord({
      eventId: "event-test",
      source: "test",
      summary: "Issue #1 in acme/app labeled agent by @badcuban",
    });
    const message =
      "Event task: Triage labeled issues. GitHub sent a issues.labeled event.\n\nRead the issue and propose a fix.";
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: snapshot(),
      initialPath: detailPath,
      configureFixture: withScheduledCapabilities(true),
      resolveRpc: (body) => {
        switch (body._tag) {
          case WS_METHODS.scheduledTasksWebhookAddress:
            return { relayUrl: RELAY_URL, localUrl: LOCAL_URL };
          case WS_METHODS.scheduledTasksGitHubContext:
            return { repository: "acme/app", login: "badcuban", canConnect: true };
          case WS_METHODS.scheduledTasksTestWebhook:
            return eventDetail(
              body.startRun === true
                ? { ...tested, threadId: "thread-test-run" as ThreadId }
                : tested,
              message,
            );
          case WS_METHODS.scheduledTasksListWebhookEvents:
            return { events: [], hasMore: false };
          case WS_METHODS.scheduledTasksListRuns:
            return { runs: [], hasMore: false };
          default:
            return undefined;
        }
      },
    });
    try {
      await sendTasks([eventTask()]);
      await page.getByTestId("scheduled-send-test-event").click();
      await expect
        .element(page.getByTestId("scheduled-event-test-outcome"))
        .toHaveTextContent("It passes every check, and would start a run.");
      await expect
        .element(page.getByTestId("scheduled-event-test").getByTestId("scheduled-event-message"))
        .toMatchTextContent("Read the issue and propose a fix.");
      expect(requestsOf(WS_METHODS.scheduledTasksTestWebhook)).toEqual([
        expect.objectContaining({ id: TASK_ID, startRun: false }),
      ]);

      await page.getByTestId("scheduled-event-test-start").click();
      await vi.waitFor(() =>
        expect(requestsOf(WS_METHODS.scheduledTasksTestWebhook).at(-1)).toMatchObject({
          startRun: true,
        }),
      );
      await expect
        .element(page.getByTestId("scheduled-event-test-outcome"))
        .toHaveTextContent("Started a run");
      await expect.element(page.getByRole("button", { name: "Open thread" })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("fits an event task's page and form on a phone", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: snapshot(),
      initialPath: detailPath,
      configureFixture: withScheduledCapabilities(true),
      resolveRpc: (body) => {
        switch (body._tag) {
          case WS_METHODS.scheduledTasksWebhookAddress:
            return { relayUrl: RELAY_URL, localUrl: LOCAL_URL };
          case WS_METHODS.scheduledTasksGitHubContext:
            return { repository: "acme/app", login: "badcuban", canConnect: false };
          case WS_METHODS.scheduledTasksListWebhookEvents:
            return { events: [], hasMore: false };
          case WS_METHODS.scheduledTasksListRuns:
            return { runs: [], hasMore: false };
          default:
            return undefined;
        }
      },
    });
    const fits = () => {
      const view = byTestId("scheduled-view")!;
      const scroller = view.querySelector<HTMLElement>(".overflow-y-auto")!;
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
    };
    try {
      await sendTasks([eventTask()]);
      await expect.element(page.getByTestId("scheduled-event-github-steps")).toBeVisible();
      fits();

      await page.getByTestId("scheduled-edit").click();
      await expect.element(page.getByTestId("scheduled-event-repository")).toBeVisible();
      await page.getByTestId("scheduled-event-more").click();
      await page.getByRole("button", { name: "Add filter" }).click();
      await expect.element(page.getByTestId("scheduled-event-filter-0")).toBeVisible();
      fits();
    } finally {
      await mounted.cleanup();
    }
  });
});
