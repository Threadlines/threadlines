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
}): UsageBucket {
  return {
    day: input.day as UsageDay,
    provider: input.provider,
    model: input.model,
    totals: tokens(input.totalTokens),
    costUsd: input.costUsd,
    cacheSavingsUsd: 1.5,
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
  buckets: (day: string) => readonly UsageBucket[],
): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: new Date().toISOString(),
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets: buckets(input.untilDay),
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
  it("renders merged totals, model rows, and every machine including the silent one", async () => {
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (day) => [
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
      ]),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);

    await expect.element(page.getByText("$17.00")).toBeInTheDocument();
    await expect.element(page.getByText("2.40M")).toBeInTheDocument();
    await expect
      .element(page.getByText("API list-price equivalent. Subscription plans bill separately."))
      .toBeInTheDocument();

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

  it("asks for a longer window when the day selector changes", async () => {
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (day) => [
        bucket({
          day,
          provider: "claude",
          model: "claude-fable-5",
          costUsd: 1,
          totalTokens: 1_000,
        }),
      ]),
    );
    registerEnvironments(summary);

    renderWithProviders(<UsageView />);
    await expect.element(page.getByTestId("usage-model-row").first()).toBeInTheDocument();
    expect(windowLengthOf(summary.mock.calls.at(-1)?.[0])).toBe(7);

    await page.getByTestId("usage-window-30").click();

    await vi.waitFor(() => {
      expect(windowLengthOf(summary.mock.calls.at(-1)?.[0])).toBe(30);
    });
  });
});

describe("SidebarUsageMeter", () => {
  it("shows today's compact token total once it arrives", async () => {
    const summary = vi.fn(async (input: UsageSummaryInput) =>
      summaryFor(input, (day) => [
        bucket({
          day,
          provider: "claude",
          model: "claude-fable-5",
          costUsd: 3,
          totalTokens: 2_400_000,
        }),
      ]),
    );
    registerEnvironments(summary);

    renderWithProviders(
      <SidebarProvider>
        <SidebarUsageMeter />
      </SidebarProvider>,
    );

    // Compact form: trailing zeros are table alignment, not chip copy.
    await expect.element(page.getByTestId("sidebar-usage-meter")).toHaveTextContent("2.4M today");
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
