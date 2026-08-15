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
        scopedProjectKey={null}
        onScopeChange={vi.fn()}
        environmentOptions={TWO_MACHINES}
        scopedEnvironmentId={null}
        onEnvironmentScopeChange={onEnvironmentScopeChange}
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
});
