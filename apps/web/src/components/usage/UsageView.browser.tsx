import "../../index.css";

import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageBucket,
  type UsageDay,
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

function summaryFor(
  input: UsageSummaryInput,
  buckets: (days: readonly string[]) => readonly UsageBucket[],
): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: new Date().toISOString(),
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets: buckets(enumerateDays(input.sinceDay, input.untilDay)),
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

function renderWithProviders(children: ReactNode) {
  const rootRoute = createRootRoute({ component: () => children });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetPrimaryEnvironmentDescriptorForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  __resetEnvironmentApiOverridesForTests();
});

afterEach(() => {
  resetPrimaryEnvironmentDescriptorForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  __resetEnvironmentApiOverridesForTests();
});

describe("UsageView", () => {
  it("renders the hero, the stat band, the priced models, and the silent machine", async () => {
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

    // The one display-size figure on the page, asterisked to its footnote.
    await expect.element(page.getByTestId("usage-total-cost")).toHaveTextContent("$17.00*");
    await expect
      .element(page.getByText("* if billed at full API rates. Subscription plans bill separately."))
      .toBeInTheDocument();

    const providerRows = page.getByTestId("usage-provider-row").elements();
    expect(providerRows).toHaveLength(2);
    expect(providerRows[0]?.textContent).toContain("Claude Code");
    expect(providerRows[0]?.textContent).toContain("$12.50");
    expect(providerRows[0]?.textContent).toContain("73.5% of cost · 2M tokens");

    const stats = page.getByTestId("usage-stat").elements();
    expect(stats.map((stat) => stat.textContent)).toEqual([
      // Compact figures here: the stat band is one-off numbers, not a column.
      "Processed tokens2.4M2.4M per active day",
      "Cached input1.2M50.0% of observed input",
      "Uncached input1.2M0 cache writes",
      "Output0",
      "Cache savings$3.000.2x the API-equivalent cost",
    ]);

    const modelRows = page.getByTestId("usage-model-row").elements();
    expect(modelRows).toHaveLength(2);
    // Sorted by cost, so the expensive model leads.
    expect(modelRows[0]?.textContent).toContain("claude-fable-5");
    expect(modelRows[1]?.textContent).toContain("gpt-5.6-sol");

    const machineRows = page.getByTestId("usage-machine-row").elements();
    expect(machineRows).toHaveLength(2);
    const laptopRow = machineRows.find((row) => row.textContent?.includes("Laptop"));
    expect(laptopRow?.textContent).toContain("Not reporting");
    const studioRow = machineRows.find((row) => row.textContent?.includes("Studio Mac"));
    expect(studioRow?.textContent).toContain("/Users/dev/.claude");
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

    // Narrowing and widening are arithmetic on the scan already in hand.
    expect(summary).toHaveBeenCalledTimes(1);
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
