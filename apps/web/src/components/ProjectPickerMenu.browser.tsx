// The new-thread project menu: pins, search and drag order run through the
// real UI store and client settings, with the order applied the way
// `useHandleNewThread` applies it.
import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId } from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { updateSettings, useSettings } from "../hooks/useSettings";
import { resetTestPage } from "../lib/testPage.browser-harness";
import { pinnedProjectsFirst } from "../projectPickerOrder";
import { useUiStateStore } from "../uiStateStore";
import { ProjectPickerMenu, PROJECT_SEARCH_MIN_PROJECTS } from "./ProjectPickerMenu";
import { MenuTrigger } from "./ui/menu";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

// Enough projects for the search line; two live in an "apis" folder.
const PROJECTS = [
  { name: "web", cwd: "/work/web" },
  { name: "gateway", cwd: "/work/apis/gateway" },
  { name: "billing", cwd: "/work/apis/billing" },
  { name: "docs", cwd: "/work/docs" },
  { name: "mobile", cwd: "/work/mobile" },
  { name: "infra", cwd: "/work/infra" },
  { name: "design", cwd: "/work/design" },
  { name: "cli", cwd: "/work/cli" },
  { name: "scratch", cwd: "/work/scratch" },
].map((project) => ({ ...project, key: `${ENVIRONMENT_ID}:${project.cwd}` }));

function Harness(props: { onPick: (key: string) => void; trailing?: boolean }) {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const pinnedProjectCwds = useUiStateStore((store) => store.pinnedProjectCwds);
  const sortOrder = useSettings((settings) => settings.sidebarProjectSortOrder);
  const ordered =
    sortOrder === "manual"
      ? PROJECTS.toSorted((a, b) => projectOrder.indexOf(a.key) - projectOrder.indexOf(b.key))
      : PROJECTS;
  return (
    <ProjectPickerMenu
      align="start"
      label="Switch project"
      trigger={<MenuTrigger data-testid="picker-trigger">Projects</MenuTrigger>}
      rows={pinnedProjectsFirst(ordered, pinnedProjectCwds).map((project) => ({
        key: project.key,
        name: project.name,
        cwd: project.cwd,
        environmentId: ENVIRONMENT_ID,
        orderKeys: [project.key],
        cwds: [project.cwd],
        selected: false,
        trailing: props.trailing ? (
          <span data-testid={`trailing-${project.name}`} className="inline-block size-3 shrink-0" />
        ) : undefined,
      }))}
      onPick={(row) => props.onPick(row.key)}
    />
  );
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
    },
    { timeout: 4_000, interval: 16 },
  );
}

function shownNames(): string[] {
  return Array.from(document.querySelectorAll("[data-project-picker-row]")).map(
    (row) =>
      PROJECTS.find((project) => project.key === row.getAttribute("data-project-picker-row"))!.name,
  );
}

function renderHarness(
  onPick: (key: string) => void = vi.fn(),
  options?: { readonly trailing?: boolean },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness onPick={onPick} trailing={options?.trailing ?? false} />
    </QueryClientProvider>,
  );
}

describe("ProjectPickerMenu", () => {
  beforeEach(() => {
    expect(PROJECTS.length).toBeGreaterThanOrEqual(PROJECT_SEARCH_MIN_PROJECTS);
    useUiStateStore.setState({
      projectOrder: PROJECTS.map((project) => project.key),
      pinnedProjectCwds: [],
    });
    updateSettings({ sidebarProjectSortOrder: "updated_at" });
  });

  afterEach(async () => {
    await resetTestPage();
  });

  it("pins a project into its own group on top, and a search matches folders", async () => {
    const onPick = vi.fn();
    const mounted = await renderHarness(onPick);
    try {
      await page.getByTestId("picker-trigger").click();
      await userEvent.hover(page.getByRole("menuitem", { name: "docs" }));
      await page.getByRole("button", { name: "Pin docs to the top" }).click();

      await expect.element(page.getByText("Pinned", { exact: true })).toBeVisible();
      expect(shownNames()[0]).toBe("docs");
      expect(useUiStateStore.getState().pinnedProjectCwds).toEqual(["/work/docs"]);

      // Off the rows, as a hand on the keyboard is: a pointer the shrinking
      // list leaves behind takes the highlight with it (Base UI's own rule).
      await userEvent.hover(page.getByTestId("project-picker-search"));
      // Neither name says "apis"; their folder does.
      await page.getByTestId("project-picker-search").fill("apis");
      await expect.poll(shownNames).toEqual(["gateway", "billing"]);
      // Enter picks the first match once the search has highlighted it.
      await expect
        .element(page.getByRole("menuitem", { name: "gateway" }))
        .toHaveAttribute("data-highlighted");
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => onPick.mock.calls).toEqual([[PROJECTS[1]!.key]]);
    } finally {
      await mounted.unmount();
    }
  });

  it("a drag puts the project where it was dropped in the user's own order, and reset brings back the automatic one", async () => {
    const mounted = await renderHarness();
    try {
      await page.getByTestId("picker-trigger").click();
      await userEvent.dragAndDrop(
        page.getByRole("menuitem", { name: "mobile" }),
        page.getByRole("menuitem", { name: "gateway" }),
      );

      // Into gateway's place; everything else stays where it was shown.
      await expect
        .poll(shownNames)
        .toEqual([
          "web",
          "mobile",
          "gateway",
          "billing",
          "docs",
          "infra",
          "design",
          "cli",
          "scratch",
        ]);

      await page.getByTestId("project-picker-reset-order").click();
      await expect.poll(shownNames).toEqual(PROJECTS.map((project) => project.name));
      await expect.element(page.getByTestId("project-picker-reset-order")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("swapping the left icon for the pin on hover never shifts menu width or trailing glyphs, and unpins pinned rows", async () => {
    await waitForProductionStyles();
    const mounted = await renderHarness(vi.fn(), { trailing: true });
    try {
      await page.getByTestId("picker-trigger").click();
      const popup = document.querySelector<HTMLElement>('[data-slot="menu-popup"]');
      expect(popup).not.toBeNull();
      const trailing = document.querySelector<HTMLElement>('[data-testid="trailing-gateway"]');
      expect(trailing).not.toBeNull();

      const restWidth = popup!.getBoundingClientRect().width;
      const restTrailingLeft = trailing!.getBoundingClientRect().left;

      // Hover the widest row: the pin replaces the left icon in place.
      await userEvent.hover(page.getByRole("menuitem", { name: "gateway" }));
      const pinButton = page.getByRole("button", { name: "Pin gateway to the top" });
      await expect.element(pinButton).toBeVisible();
      expect(popup!.getBoundingClientRect().width).toBe(restWidth);
      expect(trailing!.getBoundingClientRect().left).toBe(restTrailingLeft);

      // Pinning moves it under "Pinned", and hovering there reveals Unpin without shifting width.
      await pinButton.click();
      await expect.element(page.getByText("Pinned", { exact: true })).toBeVisible();
      expect(useUiStateStore.getState().pinnedProjectCwds).toEqual(["/work/apis/gateway"]);

      await userEvent.hover(page.getByRole("menuitem", { name: "gateway" }));
      const unpinButton = page.getByRole("button", { name: "Unpin gateway" });
      await expect.element(unpinButton).toBeVisible();
      expect(popup!.getBoundingClientRect().width).toBe(restWidth);

      await unpinButton.click();
      expect(useUiStateStore.getState().pinnedProjectCwds).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });
});
