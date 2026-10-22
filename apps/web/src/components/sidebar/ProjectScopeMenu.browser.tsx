// The project and View menus are Base UI menus, whose group and filter parts
// enforce their context at render time -- a wiring mistake there crashes the
// whole dropdown the moment a second computer exists, which no unit test can see.
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId } from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { ProjectScopeOption } from "../Sidebar.logic";
import type { EnvironmentScopeOption } from "./InboxViewMenu";
import { ProjectScopeMenu } from "./ProjectScopeMenu";

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");

const TWO_MACHINES: EnvironmentScopeOption[] = [
  { environmentId: PRIMARY_ENVIRONMENT_ID, label: "This device", isPrimary: true },
  { environmentId: REMOTE_ENVIRONMENT_ID, label: "Windows Desktop", isPrimary: false },
];

// Only the fields the menu reads: its name, and where its icon comes from.
function fakeProjects(names: readonly string[]) {
  const projects = names.map(
    (name) =>
      ({
        projectKey: name.toLowerCase(),
        displayName: name,
        cwd: `/work/${name.toLowerCase()}`,
        environmentId: PRIMARY_ENVIRONMENT_ID,
        memberProjects: [],
      }) as unknown as SidebarProjectSnapshot,
  );
  return {
    options: projects.map((project): ProjectScopeOption => ({
      key: project.projectKey,
      label: project.displayName,
      needsYouCount: 0,
    })),
    projectByKey: new Map(projects.map((project) => [project.projectKey, project] as const)),
  };
}
const { options: PROJECT_OPTIONS, projectByKey: PROJECT_BY_KEY } = fakeProjects([
  "Alpha",
  "Beta",
  "Gamma",
]);

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

  it("opens the computer section from the View button with two computers and reports the pick", async () => {
    const { mounted, onEnvironmentScopeChange } = await renderMenu();

    try {
      await page.getByTestId("inbox-view-trigger").click();
      await expect.element(page.getByText("Computer", { exact: true })).toBeVisible();
      await expect.element(page.getByTestId("inbox-machine-scope-all")).toBeVisible();

      await page.getByTestId(`inbox-machine-scope-${REMOTE_ENVIRONMENT_ID}`).click();
      expect(onEnvironmentScopeChange).toHaveBeenCalledWith(REMOTE_ENVIRONMENT_ID);
    } finally {
      await mounted.unmount();
    }
  });

  it("offers no computer section with one computer, and lights the View button only while a filter narrows the list", async () => {
    const { mounted } = await renderMenu({
      environmentOptions: [TWO_MACHINES[0]!],
      scopedEnvironmentId: null,
    });

    try {
      await page.getByTestId("inbox-view-trigger").click();
      await expect.element(page.getByTestId("inbox-grouping-none")).toBeVisible();
      expect(document.querySelector("[data-testid='inbox-machine-scope-all']")).toBeNull();
      // Rooms off: no Show section either.
      expect(document.querySelector("[data-testid='inbox-rooms-filter-only']")).toBeNull();
    } finally {
      await mounted.unmount();
    }

    const viewTrigger = () => document.querySelector("[data-testid='inbox-view-trigger']");
    const { mounted: scopedMounted } = await renderMenu({
      scopedEnvironmentId: REMOTE_ENVIRONMENT_ID,
    });
    try {
      await expect.element(page.getByTestId("inbox-view-trigger")).toBeVisible();
      // The project picker speaks for projects only; the View button says a
      // computer narrows the list, and which.
      expect(document.querySelector("[data-testid='inbox-scope-label']")?.textContent).toBe(
        "All projects",
      );
      expect(viewTrigger()?.getAttribute("data-filtered")).toBe("true");
      expect(viewTrigger()?.getAttribute("aria-label")).toContain("Windows Desktop");
    } finally {
      await scopedMounted.unmount();
    }

    // Grouping hides nothing, so it never lights the button.
    const { mounted: groupedMounted } = await renderMenu({ grouping: "project" });
    try {
      await expect.element(page.getByTestId("inbox-view-trigger")).toBeVisible();
      expect(viewTrigger()?.hasAttribute("data-filtered")).toBe(false);
    } finally {
      await groupedMounted.unmount();
    }
  });

  it("searches a long project list for projects only, and Enter toggles the one it finds", async () => {
    const onToggleScopeProject = vi.fn();
    const onScopeChange = vi.fn();
    const many = fakeProjects([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
      "Zeta",
      "Eta",
      "Theta",
      "Iota",
    ]);
    const { mounted } = await renderMenu({
      options: many.options,
      projectByKey: many.projectByKey,
      onToggleScopeProject,
      onScopeChange,
    });
    try {
      await page.getByTestId("inbox-scope-trigger").click();
      // "al" also reads as All projects: a search finds projects, so Enter
      // lands on Alpha, not on clearing the scope.
      await page.getByTestId("inbox-scope-search").fill("al");
      await expect.element(page.getByTestId("inbox-scope-beta")).not.toBeInTheDocument();
      await expect.element(page.getByTestId("inbox-scope-all")).not.toBeInTheDocument();
      await expect.element(page.getByTestId("inbox-scope-alpha")).toBeVisible();
      await userEvent.keyboard("{Enter}");
      expect(onToggleScopeProject).toHaveBeenCalledWith("alpha");
      expect(onScopeChange).not.toHaveBeenCalled();

      // Nor Add project.
      await page.getByTestId("inbox-scope-search").fill("add");
      await expect.element(page.getByText("No matching projects")).toBeVisible();

      // Enter on a row's Only presses Only, not the row under it.
      await page.getByTestId("inbox-scope-search").fill("gam");
      (await page.getByTestId("inbox-scope-only-gamma").element()).focus();
      await userEvent.keyboard("{Enter}");
      expect(onScopeChange).toHaveBeenCalledWith(["gamma"]);
      expect(onToggleScopeProject).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.unmount();
    }

    // A short list fits at a glance: no search line to look past.
    const { mounted: fewMounted } = await renderMenu({
      options: PROJECT_OPTIONS,
      projectByKey: PROJECT_BY_KEY,
    });
    try {
      await page.getByTestId("inbox-scope-trigger").click();
      await expect.element(page.getByTestId("inbox-scope-alpha")).toBeVisible();
      expect(document.querySelector("[data-testid='inbox-scope-search']")).toBeNull();
    } finally {
      await fewMounted.unmount();
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

  it("narrows to rooms from the View button and lights it while it does", async () => {
    const onRoomsOnlyChange = vi.fn();
    const { mounted } = await renderMenu({ roomsOnly: false, onRoomsOnlyChange });
    try {
      await expect
        .element(page.getByTestId("inbox-view-trigger"))
        .not.toHaveAttribute("data-filtered");
      await page.getByTestId("inbox-view-trigger").click();
      await page.getByTestId("inbox-rooms-filter-only").click();
      expect(onRoomsOnlyChange).toHaveBeenCalledWith(true);
    } finally {
      await mounted.unmount();
    }

    const { mounted: filteredMounted } = await renderMenu({ roomsOnly: true, onRoomsOnlyChange });
    try {
      await expect
        .element(page.getByTestId("inbox-view-trigger"))
        .toHaveAttribute("data-filtered", "true");
      await page.getByTestId("inbox-view-trigger").click();
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
      await page.getByTestId("inbox-view-trigger").click();
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
      await page.getByTestId("inbox-view-trigger").click();
      await expect.element(page.getByTestId("inbox-grouping-project")).toBeVisible();
      expect(document.querySelector("[data-testid='inbox-grouping-computer']")).toBeNull();
      await page.getByTestId("inbox-grouping-none").click();
      expect(onGroupingChange).toHaveBeenLastCalledWith("none");
    } finally {
      await oneMachine.unmount();
    }
  });
});
