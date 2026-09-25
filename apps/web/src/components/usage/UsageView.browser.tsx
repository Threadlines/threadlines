import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type ServerConfig,
  type ServerProvider,
  type UsageBucket,
  type UsageDay,
  type UsageHourBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@threadlines/contracts";
import { enumerateDays } from "@threadlines/shared/usageFormat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  useSavedEnvironmentRegistryStore,
} from "../../environments/runtime";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarUsageMeter } from "../sidebar/SidebarUsageMeter";
import { UsageView } from "./UsageView";

const REPORTING_ENVIRONMENT_ID = EnvironmentId.make("env-studio");
const OFFLINE_ENVIRONMENT_ID = EnvironmentId.make("env-laptop");

function tokens(total: number): UsageBucket["totals"] {
  return {
    uncachedInputTokens: Math.round(total / 2),
    cachedInputTokens: Math.round(total / 2),
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function bucket(input: {
  readonly day: string;
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly cacheSavingsUsd?: number;
}): UsageBucket {
  return {
    day: input.day as UsageDay,
    provider: input.provider,
    model: input.model,
    totals: tokens(input.totalTokens),
    costUsd: input.costUsd,
    cacheSavingsUsd: input.cacheSavingsUsd ?? 1.5,
    costSource: "modelPriced",
    records: 4,
    unpricedRecords: 0,
    sessions: 2,
  };
}

function source(
  provider: UsageProviderKind,
  resolvedHomePath: string,
): UsageSummary["sources"][number] {
  return {
    fingerprint: {
      hostId: "studio",
      provider,
      resolvedHomePath,
      volumeId: `1:${provider}`,
    },
    status: "ok",
    lastScannedAt: new Date().toISOString(),
    scannedFiles: 12,
    skippedFiles: 0,
    distinctSessions: 3,
    message: null,
  };
}

/**
 * Omitting `hourlyBuckets` models a server from before hourly usage; pass an
 * array, even an empty one, for a current server.
 */
function summaryFor(
  input: UsageSummaryInput,
  buckets: (days: readonly string[]) => readonly UsageBucket[],
  hourlyBuckets?: readonly UsageHourBucket[],
): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: new Date().toISOString(),
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets: buckets(enumerateDays(input.sinceDay, input.untilDay)),
    ...(hourlyBuckets ? { hourlyBuckets } : {}),
    sources: [source("claude", "/Users/dev/.claude"), source("codex", "/Users/dev/.codex")],
    pricing: {
      status: "cached",
      source: "litellm",
      fetchedAt: new Date().toISOString(),
      knownModels: 400,
    },
    scanDurationMs: 42,
  };
}

function registerEnvironments(summary: (input: UsageSummaryInput) => Promise<UsageSummary>): void {
  writePrimaryEnvironmentDescriptor({
    environmentId: REPORTING_ENVIRONMENT_ID,
    label: "Studio Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.1.0",
    capabilities: { repositoryIdentity: false },
  });
  // A saved backend that is not connected: the page must name it rather than
  // quietly leaving it out of the totals.
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      [OFFLINE_ENVIRONMENT_ID]: {
        environmentId: OFFLINE_ENVIRONMENT_ID,
        label: "Laptop",
        wsBaseUrl: "ws://laptop.local",
        httpBaseUrl: "http://laptop.local",
        createdAt: new Date().toISOString(),
        lastConnectedAt: null,
      },
    },
  });
  __setEnvironmentApiOverrideForTests(REPORTING_ENVIRONMENT_ID, {
    usage: { summary },
  } as never);
}

function renderWithProviders(
  children: ReactNode,
  options?: { readonly initialEntries?: readonly string[] },
) {
  const rootRoute = createRootRoute({ component: () => children });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const usageRoute = createRoute({ getParentRoute: () => rootRoute, path: "/usage" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, usageRoute]),
    history: createMemoryHistory({ initialEntries: [...(options?.initialEntries ?? ["/"])] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const rendered = render(
    <AppAtomRegistryProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppAtomRegistryProvider>,
  );
  return { ...rendered, router };
}

function serverConfigWith(providers: readonly ServerProvider[]): ServerConfig {
  return {
    environment: {
      environmentId: REPORTING_ENVIRONMENT_ID,
      label: "Studio Mac",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: false },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "threadlines_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.threadlines/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [...providers],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.threadlines/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function provider(
  driver: "claudeAgent" | "codex",
  accountUsage?: ServerProvider["accountUsage"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: driver === "codex" ? "Codex" : "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", type: driver === "codex" ? "apiKey" : "oauth" },
    ...(accountUsage ? { accountUsage } : {}),
    checkedAt: new Date().toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
  };
}

beforeEach(async () => {
  await page.viewport(1280, 720);
  resetServerStateForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  __resetEnvironmentApiOverridesForTests();
});

afterEach(() => {
  resetServerStateForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  __resetEnvironmentApiOverridesForTests();
});

describe("UsageView", () => {
  it("uses the page layout as a skeleton while usage is loading", async () => {
    let finishSummary: (() => void) | undefined;
    const summary = vi.fn(
      (input: UsageSummaryInput) =>
        new Promise<UsageSummary>((resolve) => {
          finishSummary = () => resolve(summaryFor(input, () => []));
        }),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);

    await expect.element(page.getByRole("status", { name: "Loading usage" })).toBeInTheDocument();
    const chartSkeleton = page.getByTestId("usage-chart-skeleton");
    await expect.element(chartSkeleton).toBeInTheDocument();
    const chartPlotSkeleton = page.getByTestId("usage-chart-plot-skeleton");
    const chartDataSkeleton = page.getByTestId("usage-chart-data-skeleton");
    expect(getComputedStyle(chartDataSkeleton.element()).clipPath).toContain("polygon");
    expect(chartPlotSkeleton.element().querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
    await expect.element(page.getByText("API-equivalent cost")).toBeInTheDocument();
    expect(page.getByTestId("usage-provider-row-skeleton").elements()).toHaveLength(2);
    await expect.element(page.getByText("Reading provider transcripts…")).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(10);

    finishSummary?.();

    await expect.element(page.getByTestId("usage-total-tokens")).toHaveTextContent("0");
    await expect.element(page.getByTestId("usage-total-cost")).toHaveTextContent("$0.00*");
    await expect
      .element(page.getByRole("status", { name: "Loading usage" }))
      .not.toBeInTheDocument();
  });

  it("keeps usage stats in one row without overflow, then stacks them on phones", async () => {
    await page.viewport(657, 800);
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (days) => {
        const day = days[days.length - 1] ?? input.untilDay;
        return [
          bucket({
            day,
            provider: "claude",
            model: "claude-fable-5",
            costUsd: 12,
            totalTokens: 1_000_000,
          }),
        ];
      }),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);

    await expect.element(page.getByTestId("usage-total-tokens")).toHaveTextContent("1M");
    const cells = page.getByTestId("usage-stat").elements();
    expect(cells).toHaveLength(5);
    const tops = cells.map((cell) => Math.round(cell.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
    const band = page.getByTestId("usage-stats-band").element();
    expect(band.scrollWidth).toBeLessThanOrEqual(band.clientWidth);

    await page.viewport(390, 800);
    await vi.waitFor(() => {
      const mobileTops = cells.map((cell) => Math.round(cell.getBoundingClientRect().top));
      expect(mobileTops.every((top, index) => index === 0 || top > mobileTops[index - 1]!)).toBe(
        true,
      );
      expect(band.scrollWidth).toBeLessThanOrEqual(band.clientWidth);
    });
  });

  it("shows a mobile back button that returns to the previous route", async () => {
    await page.viewport(390, 800);
    const summary = vi.fn(
      async () =>
        new Promise<UsageSummary>(() => {
          // Keep the route stable; this test is about navigation chrome.
        }),
    );
    registerEnvironments(summary);

    const mounted = renderWithProviders(<UsageView />, { initialEntries: ["/", "/usage"] });

    const backButton = page.getByTestId("usage-mobile-back");
    await expect.element(backButton).toBeVisible();
    await backButton.click();
    await vi.waitFor(() => {
      expect(mounted.router.state.location.pathname).toBe("/");
    });
  });

  it("leads with tokens and renders the stat band, the models, and the silent machine", async () => {
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (days) => {
        const day = days[days.length - 1] ?? input.untilDay;
        return [
          bucket({
            day,
            provider: "claude",
            model: "claude-fable-5",
            costUsd: 12.5,
            totalTokens: 2_000_000,
          }),
          bucket({
            day,
            provider: "codex",
            model: "gpt-5.6-sol",
            costUsd: 4.5,
            totalTokens: 400_000,
          }),
          // Placeholder rows carry records but no tokens and no cost; the table
          // has nothing to say about them.
          bucket({
            day,
            provider: "codex",
            model: "<synthetic>",
            costUsd: 0,
            totalTokens: 0,
            cacheSavingsUsd: 0,
          }),
        ];
      }),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);

    // The one display-size figure on the page is tokens; cost trails with its caveat.
    await expect.element(page.getByTestId("usage-total-tokens")).toHaveTextContent("2.4M");
    await expect
      .element(page.getByTestId("usage-new-tokens"))
      .toHaveTextContent("1.2M new tokens, not counting cache reads");
    await expect.element(page.getByTestId("usage-total-cost")).toHaveTextContent("$17.00*");
    await expect
      .element(page.getByText("* if billed at full API rates. Subscription plans bill separately."))
      .toBeInTheDocument();

    const mixRows = page.getByTestId("usage-token-mix-row").elements();
    expect(mixRows.map((row) => row.textContent)).toEqual([
      "Cache reads · re-read from cache1.2M50%",
      "Cache writes00%",
      "Fresh input1.2M50%",
      "Output00%",
    ]);

    const providerRows = page.getByTestId("usage-provider-row").elements();
    expect(providerRows.map((row) => row.textContent)).toEqual([
      "Claude Code2M83%",
      "Codex400K17%",
    ]);

    const stats = page.getByTestId("usage-stat").elements();
    expect(stats.map((stat) => stat.textContent)).toEqual([
      "Daily average2.4M1 of 30 days active",
      expect.stringMatching(/^Busiest day2\.4M[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/),
      "Today so far2.4M100% of an average day",
      "Cache hit rate50.0%of input came from cache",
      "vs previous 30 daysn/aNo activity in the 30 days before",
    ]);

    const modelRows = page.getByTestId("usage-model-row").elements();
    expect(modelRows).toHaveLength(2);
    // Sorted by tokens, so the heaviest model leads.
    expect(modelRows[0]?.textContent).toContain("claude-fable-5");
    expect(modelRows[1]?.textContent).toContain("gpt-5.6-sol");

    const machineRows = page.getByTestId("usage-machine-row").elements();
    expect(machineRows).toHaveLength(2);
    const laptopRow = machineRows.find((row) => row.textContent?.includes("Laptop"));
    expect(laptopRow?.textContent).toContain("Not reporting");
    const studioRow = machineRows.find((row) => row.textContent?.includes("Studio Mac"));
    expect(studioRow?.textContent).toContain("/Users/dev/.claude");

    // Hovering today's bar lists its models, heaviest first, then the total.
    await page.getByTestId("usage-chart-day").nth(29).hover();
    const card = page.getByTestId("usage-chart-card");
    await expect.element(card).toBeVisible();
    const cardText = card.element().textContent ?? "";
    expect(cardText).toContain("today so far");
    expect(cardText.indexOf("claude-fable-5")).toBeLessThan(cardText.indexOf("gpt-5.6-sol"));
    expect(cardText).toContain("400K");
    expect(cardText).toContain("Total2.4M");
  });

  it("splits the chart and each day by model, and switches the split", async () => {
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (days) => {
        const day = days[days.length - 1] ?? input.untilDay;
        return [
          bucket({
            day,
            provider: "claude",
            model: "claude-fable-5",
            costUsd: 12.5,
            totalTokens: 2_000_000,
          }),
          bucket({
            day,
            provider: "codex",
            model: "gpt-5.6-sol",
            costUsd: 4.5,
            totalTokens: 400_000,
          }),
        ];
      }),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);
    await expect.element(page.getByTestId("usage-total-tokens")).toHaveTextContent("2.4M");
    const legend = () =>
      page
        .getByTestId("usage-chart-legend-item")
        .elements()
        .map((item) => item.textContent);
    expect(legend()).toEqual(["claude-fable-5", "gpt-5.6-sol"]);

    // Only the day with activity earns a row; opening it lists its models.
    const dayRows = page.getByTestId("usage-period-row");
    expect(dayRows.elements()).toHaveLength(1);
    expect(dayRows.first().element().textContent).toContain("Today");
    expect(page.getByTestId("usage-period-model").elements()).toHaveLength(0);
    await dayRows.first().getByRole("button").click();
    const dayModels = page.getByTestId("usage-period-model").elements();
    expect(dayModels).toHaveLength(2);
    expect(dayModels[0]?.textContent).toContain("claude-fable-5");
    expect(dayModels[0]?.textContent).toContain("83% of the day");

    await page.getByTestId("usage-chart-group-providers").click();
    await vi.waitFor(() => expect(legend()).toEqual(["Claude Code", "Codex"]));

    // Token kinds, then without cache reads: half of every bucket is cached.
    await page.getByTestId("usage-chart-group-kinds").click();
    await vi.waitFor(() => expect(legend()).toEqual(["Fresh input", "Cache reads"]));
    await page.getByTestId("usage-include-cache-reads").click();
    await vi.waitFor(() => expect(legend()).toEqual(["Fresh input"]));
    await expect.element(page.getByText("Daily tokens, without cache reads")).toBeInTheDocument();

    // Cost has no split by token kind: the chart falls back to models and the
    // cache toggle goes away, since cost cannot leave cache reads out.
    await page.getByTestId("usage-chart-mode-cost").click();
    await vi.waitFor(() => expect(legend()).toEqual(["claude-fable-5", "gpt-5.6-sol"]));
    await expect.element(page.getByTestId("usage-chart-group-kinds")).toBeDisabled();
    expect(page.getByTestId("usage-include-cache-reads").elements()).toHaveLength(0);
    await page.getByTestId("usage-chart-day").nth(29).hover();
    await expect.element(page.getByTestId("usage-chart-card")).toHaveTextContent("$12.50");
  });

  it("shows each provider's plan limits, and leaves out a provider with none", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    setServerConfigSnapshot(
      serverConfigWith([
        provider("claudeAgent", {
          source: "claude-oauth-usage",
          checkedAt: new Date().toISOString(),
          limits: [
            {
              primary: { usedPercent: 62, remainingPercent: 38, resetsAt, windowDurationMins: 300 },
              secondary: {
                usedPercent: 81,
                remainingPercent: 19,
                resetsAt,
                windowDurationMins: 10_080,
              },
            },
          ],
        }),
        provider("codex"),
      ]),
    );
    registerEnvironments(async (input) => summaryFor(input, () => []));

    renderWithProviders(<UsageView />);

    const rows = page.getByTestId("usage-plan-limit-row");
    await expect.element(rows.first()).toBeVisible();
    expect(rows.elements()).toHaveLength(1);
    const text = rows.first().element().textContent ?? "";
    expect(text).toContain("Claude");
    expect(text).toContain("5h62% used");
    // Past the warning threshold the meter says so in words, not only in amber.
    expect(text).toContain("WeeklyNear limit81% used");
  });

  it("opens on 30 days and switches windows without another scan", async () => {
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (days) =>
        days.map((day) =>
          bucket({
            day,
            provider: "claude",
            model: "claude-fable-5",
            costUsd: 1,
            totalTokens: 1_000,
          }),
        ),
      ),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);

    await vi.waitFor(() => {
      expect(page.getByTestId("usage-chart-day").elements()).toHaveLength(30);
    });
    // One scan, and it covers the longest window the selector offers.
    expect(summary).toHaveBeenCalledTimes(1);
    expect(windowLengthOf(summary.mock.calls[0]?.[0])).toBe(90);

    await page.getByTestId("usage-window-7").click();
    await vi.waitFor(() => {
      expect(page.getByTestId("usage-chart-day").elements()).toHaveLength(7);
    });

    await page.getByTestId("usage-window-90").click();
    await vi.waitFor(() => {
      expect(page.getByTestId("usage-chart-day").elements()).toHaveLength(90);
    });

    // This server predates hourly usage: the 24h view still draws its hours,
    // and names the machine rather than letting its usage read as zero.
    await page.getByTestId("usage-window-24h").click();
    await vi.waitFor(() => {
      expect(page.getByTestId("usage-chart-day").elements()).toHaveLength(24);
    });
    await expect
      .element(page.getByTestId("usage-hourly-missing"))
      .toHaveTextContent(
        "Studio Mac runs an older Threadlines, so its last 24 hours are not counted here.",
      );

    // Narrowing and widening are arithmetic on the scan already in hand.
    expect(summary).toHaveBeenCalledTimes(1);
  });

  it("shows the last 24 hours by hour", async () => {
    const hourMs = 60 * 60 * 1000;
    const thisHour = Math.floor(Date.now() / hourMs) * hourMs;
    const hour = (hourStartMs: number, model: string, totalTokens: number): UsageHourBucket => ({
      hourStartMs,
      provider: "claude",
      model,
      totals: tokens(totalTokens),
      costUsd: 1,
      records: 3,
    });
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(
        input,
        (days) => [
          bucket({
            day: days[days.length - 1] ?? input.untilDay,
            provider: "claude",
            model: "claude-fable-5",
            costUsd: 3,
            totalTokens: 3_000_000,
          }),
        ],
        [
          hour(thisHour, "claude-fable-5", 2_000_000),
          hour(thisHour - hourMs, "claude-opus-5", 1_000_000),
          // The day before: only the comparison counts it.
          hour(thisHour - 30 * hourMs, "claude-fable-5", 1_500_000),
        ],
      ),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);
    await expect.element(page.getByTestId("usage-total-tokens")).toHaveTextContent("3M");
    await page.getByTestId("usage-window-24h").click();

    await expect.element(page.getByTestId("usage-date-range")).toHaveTextContent(/ to now$/);
    await expect.element(page.getByText("Hourly tokens")).toBeInTheDocument();
    expect(page.getByTestId("usage-chart-day").elements()).toHaveLength(24);
    expect(page.getByTestId("usage-hourly-missing").elements()).toHaveLength(0);
    const rows = page.getByTestId("usage-period-row").elements();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("This hour");
    const stats = page.getByTestId("usage-stat").elements();
    expect(stats[0]?.textContent).toBe("Hourly average1.5M2 of 24 hours active");
    expect(stats[4]?.textContent).toBe("vs previous 24 hours+100%1.5M in the 24 hours before");
  });
});

describe("SidebarUsageMeter", () => {
  it("names itself and carries today's compact total once it arrives", async () => {
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (days) =>
        days.map((day) =>
          bucket({
            day,
            provider: "claude",
            model: "claude-fable-5",
            costUsd: 3,
            totalTokens: 2_400_000,
          }),
        ),
      ),
    );
    registerEnvironments(summary);

    renderWithProviders(
      <SidebarProvider>
        <SidebarUsageMeter />
      </SidebarProvider>,
    );

    // Compact form: trailing zeros are table alignment, not chip copy.
    await expect
      .element(page.getByTestId("sidebar-usage-meter"))
      .toHaveTextContent("Usage2.4M today");
  });

  it("stays the plain label when no environment answers", async () => {
    renderWithProviders(
      <SidebarProvider>
        <SidebarUsageMeter />
      </SidebarProvider>,
    );

    await expect.element(page.getByTestId("sidebar-usage-meter")).toHaveTextContent("Usage");
  });
});

function windowLengthOf(input: UsageSummaryInput | undefined): number {
  if (!input) return 0;
  const since = Date.parse(`${input.sinceDay}T00:00:00Z`);
  const until = Date.parse(`${input.untilDay}T00:00:00Z`);
  return Math.round((until - since) / 86_400_000) + 1;
}
