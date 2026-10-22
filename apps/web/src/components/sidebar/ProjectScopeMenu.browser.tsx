// The machine section lives inside a Base UI menu, whose group parts enforce
// their context at render time — a wiring mistake there crashes the whole
// dropdown the moment a second machine exists, which no unit test can see.
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { ProjectScopeOption } from "../Sidebar.logic";
import { ProjectScopeMenu, type EnvironmentScopeOption } from "./ProjectScopeMenu";

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");

const TWO_MACHINES: EnvironmentScopeOption[] = [
  { environmentId: PRIMARY_ENVIRONMENT_ID, label: "This device", isPrimary: true },
  { environmentId: REMOTE_ENVIRONMENT_ID, label: "Windows Desktop", isPrimary: false },
];

// Only the fields the menu reads: its name, and where its icon comes from.
const PROJECTS = (["Alpha", "Beta", "Gamma"] as const).map(
  (name) =>
    ({
      projectKey: name.toLowerCase(),
      displayName: name,
      cwd: `/work/${name.toLowerCase()}`,
      environmentId: PRIMARY_ENVIRONMENT_ID,
      memberProjects: [],
    }) as unknown as SidebarProjectSnapshot,
);
const PROJECT_OPTIONS: ProjectScopeOption[] = PROJECTS.map((project) => ({
  key: project.projectKey,
  label: project.displayName,
  needsYouCount: 0,
}));
const PROJECT_BY_KEY = new Map(PROJECTS.map((project) => [project.projectKey, project] as const));

async function renderMenu(
  props: Partial<Parameters<typeof ProjectScopeMenu>[0]> = {},
  onEnvironmentScopeChange = vi.fn(),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mounted = await render(
    <QueryClientProvider client={queryClient}>
      <ProjectScopeMenu
        options={[] as ProjectScopeOption[]}
        projectByKey={new Map<string, SidebarProjectSnapshot>()}
        scopedProjectKeys={[]}
        onScopeChange={vi.fn()}
        onToggleScopeProject={vi.fn()}
        environmentOptions={TWO_MACHINES}
        scopedEnvironmentId={null}
        onEnvironmentScopeChange={onEnvironmentScopeChange}
        roomsOnly={null}
        onRoomsOnlyChange={vi.fn()}
        grouping="none"
        onGroupingChange={vi.fn()}
        onAddProject={vi.fn()}
        onNewThread={vi.fn()}
        newThreadShortcutLabel={null}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onEnvironmentScopeChange, mounted };
}

describe("ProjectScopeMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the machine section with two machines and reports the picked one", async () => {
    const { mounted, onEnvironmentScopeChange } = await renderMenu();

    try {
      await page.getByTestId("inbox-scope-trigger").click();
      await expect.element(page.getByText("Machine", { exact: true })).toBeVisible();
      await expect.element(page.getByTestId("inbox-machine-scope-all")).toBeVisible();

      await page.getByTestId(`inbox-machine-scope-${REMOTE_ENVIRONMENT_ID}`).click();
      expect(onEnvironmentScopeChange).toHaveBeenCalledWith(REMOTE_ENVIRONMENT_ID);
    } finally {
      await mounted.unmount();
    }
  });

  it("offers no machine section while only one machine is known, and names an active filter on the trigger", async () => {
    const { mounted } = await renderMenu({
      environmentOptions: [TWO_MACHINES[0]!],
      scopedEnvironmentId: null,
    });

    try {
      await page.getByTestId("inbox-scope-trigger").click();
      await expect.element(page.getByTestId("inbox-scope-all")).toBeVisible();
      expect(document.querySelector("[data-testid='inbox-machine-scope-all']")).toBeNull();
      // Rooms off: no rooms section either.
      expect(document.querySelector("[data-testid='inbox-rooms-filter-only']")).toBeNull();
    } finally {
      await mounted.unmount();
    }

    const { mounted: scopedMounted } = await renderMenu({
      scopedEnvironmentId: REMOTE_ENVIRONMENT_ID,
    });
    try {
      await expect.element(page.getByTestId("inbox-scope-trigger")).toBeVisible();
      // Machine-only scope: the machine IS the label — no "All projects ·"
      // prefix to eat the width the name needs.
      expect(document.querySelector("[data-testid='inbox-scope-trigger']")?.textContent).toBe(
        "Windows Desktop",
      );
    } finally {
      await scopedMounted.unmount();
    }
  });

  it("toggles projects with the menu left open, and Only narrows to one and closes it", async () => {
    const onScopeChange = vi.fn();
    const onToggleScopeProject = vi.fn();
    const { mounted } = await renderMenu({
      options: PROJECT_OPTIONS,
      projectByKey: PROJECT_BY_KEY,
      scopedProjectKeys: ["alpha"],
      onScopeChange,
      onToggleScopeProject,
    });
    try {
      await page.getByTestId("inbox-scope-trigger").click();
      await page.getByTestId("inbox-scope-beta").click();
      expect(onToggleScopeProject).toHaveBeenCalledWith("beta");
      // Still open for the next pick.
      await expect.element(page.getByTestId("inbox-scope-gamma")).toBeVisible();
      // The project already showing alone offers no Only: it would do nothing.
      expect(document.querySelector("[data-testid='inbox-scope-only-alpha']")).toBeNull();

      await page.getByTestId("inbox-scope-only-gamma").click();
      expect(onScopeChange).toHaveBeenCalledWith(["gamma"]);
      // Only replaces the scope; it does not also toggle the row it sits on.
      expect(onToggleScopeProject).toHaveBeenCalledTimes(1);
      await expect.element(page.getByTestId("inbox-scope-gamma")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("names two picked projects on the trigger in pick order, and counts three", async () => {
    // The label alone: an icon without a favicon draws its project's initial.
    const triggerText = () =>
      document.querySelector("[data-testid='inbox-scope-label']")?.textContent;
    const { mounted } = await renderMenu({
      options: PROJECT_OPTIONS,
      projectByKey: PROJECT_BY_KEY,
      scopedProjectKeys: ["beta", "alpha"],
      environmentOptions: [TWO_MACHINES[0]!],
    });
    try {
      await expect.element(page.getByTestId("inbox-scope-trigger")).toBeVisible();
      expect(triggerText()).toBe("Beta, Alpha");
    } finally {
      await mounted.unmount();
    }

    const { mounted: threeMounted } = await renderMenu({
      options: PROJECT_OPTIONS,
      projectByKey: PROJECT_BY_KEY,
      scopedProjectKeys: ["alpha", "beta", "gamma"],
      environmentOptions: [TWO_MACHINES[0]!],
    });
    try {
      await expect.element(page.getByTestId("inbox-scope-trigger")).toBeVisible();
      expect(triggerText()).toBe("3 projects");
    } finally {
      await threeMounted.unmount();
    }
  });

  it("narrows to rooms from the menu and marks the trigger while it does", async () => {
    const onRoomsOnlyChange = vi.fn();
    const { mounted } = await renderMenu({ roomsOnly: false, onRoomsOnlyChange });
    try {
      expect(document.querySelector("[data-testid='inbox-rooms-filter-mark']")).toBeNull();
      await page.getByTestId("inbox-scope-trigger").click();
      await page.getByTestId("inbox-rooms-filter-only").click();
      expect(onRoomsOnlyChange).toHaveBeenCalledWith(true);
    } finally {
      await mounted.unmount();
    }

    const { mounted: filteredMounted } = await renderMenu({ roomsOnly: true, onRoomsOnlyChange });
    try {
      await expect.element(page.getByTestId("inbox-rooms-filter-mark")).toBeVisible();
      await page.getByTestId("inbox-scope-trigger").click();
      await page.getByTestId("inbox-rooms-filter-all").click();
      expect(onRoomsOnlyChange).toHaveBeenLastCalledWith(false);
    } finally {
      await filteredMounted.unmount();
    }
  });

  it("groups by project, and by computer only once there are two", async () => {
    const onGroupingChange = vi.fn();
    const { mounted } = await renderMenu({ grouping: "none", onGroupingChange });
    try {
      await page.getByTestId("inbox-scope-trigger").click();
      await expect.element(page.getByText("Group", { exact: true })).toBeVisible();
      await page.getByTestId("inbox-grouping-computer").click();
      expect(onGroupingChange).toHaveBeenCalledWith("computer");
    } finally {
      await mounted.unmount();
    }

    const { mounted: oneMachine } = await renderMenu({
      environmentOptions: [TWO_MACHINES[0]!],
      grouping: "project",
      onGroupingChange,
    });
    try {
      await page.getByTestId("inbox-scope-trigger").click();
      await expect.element(page.getByTestId("inbox-grouping-project")).toBeVisible();
      expect(document.querySelector("[data-testid='inbox-grouping-computer']")).toBeNull();
      await page.getByTestId("inbox-grouping-none").click();
      expect(onGroupingChange).toHaveBeenLastCalledWith("none");
    } finally {
      await oneMachine.unmount();
    }
  });
});
