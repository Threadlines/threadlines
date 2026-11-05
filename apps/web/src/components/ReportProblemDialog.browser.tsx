import "../index.css";

import {
  type LocalApi,
  type ReportProblemAccount,
  ReportProblemError,
} from "@threadlines/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { __resetLocalApiForTests } from "../localApi";
import { resetSourceControlDiscoveryStateForTests } from "../lib/sourceControlDiscoveryState";
import { resetTestPage } from "../lib/testPage.browser-harness";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { openReportProblemDialog, ReportProblemDialogHost } from "./ReportProblemDialog";
import { resetReportProblemForTests } from "./ReportProblemDialogContent";

vi.mock("../branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../branding")>()),
  APP_VERSION: "0.9.0",
}));

let mounted: Awaited<ReturnType<typeof render>> | null = null;

/** This computer's server as the form sees it: who `gh` is signed in as, and the post. */
function stubServer(account: ReportProblemAccount, reportProblem = vi.fn()) {
  resetSourceControlDiscoveryStateForTests();
  const openExternal = vi.fn(async () => {});
  window.nativeApi = {
    server: {
      getSourceControlSetup: async () => ({
        tools: [],
        githubAuth: { status: "idle", verificationUrl: null, userCode: null, message: null },
      }),
      getReportProblemAccount: async () => account,
      reportProblem,
    },
    shell: { openExternal },
  } as unknown as LocalApi;
  return { openExternal, reportProblem };
}

async function mountAndOpen() {
  const rootRoute = createRootRoute({
    component: () => (
      <AppAtomRegistryProvider>
        <ReportProblemDialogHost />
      </AppAtomRegistryProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  mounted = await render(<RouterProvider router={router} />);
  openReportProblemDialog();
  await expect.element(page.getByRole("dialog", { name: "Report a problem" })).toBeVisible();
}

async function fillRequired() {
  await page.getByLabelText("Summary").fill("Changing the access level opens another chat");
  await page.getByLabelText("What happened?").fill("The chat jumped.");
  await page.getByLabelText("How can we make it happen?").fill("1. Change the access level");
}

describe("Report a problem", () => {
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    resetReportProblemForTests();
    Reflect.deleteProperty(window, "nativeApi");
    await resetTestPage();
    await __resetLocalApiForTests();
    resetAppAtomRegistryForTests();
    vi.restoreAllMocks();
  });

  it("posts the report from the signed-in GitHub account and links the new issue", async () => {
    const issueUrl = "https://github.com/Threadlines/threadlines/issues/812";
    const { reportProblem, openExternal } = stubServer(
      { status: "signedIn", login: "octocat" },
      vi.fn(async () => ({ number: 812, url: issueUrl })),
    );
    await mountAndOpen();

    await expect
      .element(page.getByTestId("report-problem-account"))
      .toHaveTextContent("Posting as @octocat");
    const post = page.getByRole("button", { name: "Post report" });
    await expect.element(post).toBeDisabled();

    await fillRequired();
    await post.click();

    await expect.element(page.getByText("Posted as issue #812")).toBeVisible();
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(reportProblem).toHaveBeenCalledWith(
      expect.objectContaining({
        login: "octocat",
        title: "Changing the access level opens another chat",
        whatHappened: "The chat jumped.",
        steps: "1. Change the access level",
        version: "0.9.0",
      }),
    );
    await page.getByRole("button", { name: "Open issue" }).click();
    expect(openExternal).toHaveBeenCalledWith(issueUrl);
  });

  it("keeps a report GitHub may have taken as sent until posting again settles it", async () => {
    const reportProblem = vi
      .fn()
      .mockRejectedValueOnce(
        new ReportProblemError({
          reason:
            "GitHub didn't answer in time, so the report may have posted anyway. Posting again checks for it first.",
          uncertain: true,
        }),
      )
      .mockResolvedValueOnce({
        number: 813,
        url: "https://github.com/Threadlines/threadlines/issues/813",
      });
    stubServer({ status: "signedIn", login: "octocat" }, reportProblem);
    await mountAndOpen();

    await fillRequired();
    await page.getByRole("button", { name: "Post report" }).click();
    await expect.element(page.getByText("may have posted anyway", { exact: false })).toBeVisible();
    await expect.element(page.getByLabelText("Summary")).toBeDisabled();

    await page.getByRole("button", { name: "Post again" }).click();
    await expect.element(page.getByText("Posted as issue #813")).toBeVisible();
    const [first, second] = reportProblem.mock.calls.map(([input]) => input.submissionId);
    expect(second).toBe(first);
  });

  it("offers GitHub sign-in when signed out, and carries the report to GitHub's form", async () => {
    const { reportProblem, openExternal } = stubServer({ status: "signedOut" });
    await mountAndOpen();

    await expect.element(page.getByText("Sign in to GitHub to post from here.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in to GitHub" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Post report" })).not.toBeInTheDocument();

    await fillRequired();
    await page.getByRole("button", { name: "Finish on GitHub" }).click();

    await expect.poll(() => openExternal.mock.calls.length).toBe(1);
    const opened = new URL((openExternal.mock.calls[0] as unknown as [string])[0]);
    expect(opened.searchParams.get("title")).toBe(
      "[Bug]: Changing the access level opens another chat",
    );
    expect(opened.searchParams.get("actual")).toBe("The chat jumped.");
    expect(opened.searchParams.get("version")).toBe("0.9.0");
    expect(reportProblem).not.toHaveBeenCalled();
  });
});
