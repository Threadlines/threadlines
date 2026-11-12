import "../../../index.css";

import {
  type EnvironmentId,
  THEME_FILE_FORMAT,
  type ThemeManifest,
  ThemeShowcaseError,
  type ThemeShowcasePreparation,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../../../lib/testPage.browser-harness";

const showcase = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  takeBack: vi.fn(),
}));
vi.mock("~/themeLibrary/themeShowcase", () => ({
  newShowcaseSubmissionId: () => "share00000001",
  prepareShowcaseShare: showcase.prepare,
  submitShowcaseShare: showcase.submit,
  takeBackShowcaseShare: showcase.takeBack,
  readShowcaseAccount: () => Promise.resolve({ status: "signedIn", login: "octocat" }),
}));

const { ThemeShareDialog, ThemeTakeBackDialog } = await import("./ThemeShareDialog");

const harbor: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Harbor Night",
  base: "dark",
  colors: {
    background: "#0b1420",
    foreground: "#e6eef8",
    mutedForeground: "#9fb0c4",
    accent: "#4cc2ff",
    accentForeground: "#04121f",
  },
};

const ready = (problems: string[] = []): ThemeShowcasePreparation => ({
  manifest: harbor,
  thumbnail: null,
  fonts: [],
  problems,
});

const open = (keepsEmailPrivate = true) =>
  render(
    <ThemeShareDialog
      environmentId={"env-1" as EnvironmentId}
      keepsEmailPrivate={keepsEmailPrivate}
      entryId="entry-1"
      name="Harbor Night"
      manifest={harbor}
      onClose={() => {}}
    />,
  );

describe("ThemeShareDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("threadlines:theme-export-credits");
    resetTestPage();
  });

  it("won't share while something stands in the way, and says what", async () => {
    showcase.prepare.mockResolvedValue(
      ready(["The Inter font doesn't carry its copyright notice."]),
    );
    await open();
    await expect.element(page.getByText("doesn't carry its copyright notice")).toBeVisible();
    await expect.element(page.getByText("@octocat")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Share" })).toBeDisabled();
    expect(showcase.submit).not.toHaveBeenCalled();
  });

  it("says it's public right away, and that an older computer would show the email", async () => {
    showcase.prepare.mockResolvedValue(ready());
    const current = await open();
    const terms = page.getByTestId("theme-share-terms");
    await expect.element(terms.getByText("public right away")).toBeVisible();
    await expect.element(terms.getByText("your GitHub email")).not.toBeInTheDocument();
    await current.unmount();

    await open(false);
    await expect.element(terms.getByText("also shows your GitHub email")).toBeVisible();
  });

  it("sends the same share again after GitHub didn't answer, so it can't open twice", async () => {
    showcase.prepare.mockResolvedValue(ready());
    showcase.submit
      .mockRejectedValueOnce(
        new ThemeShowcaseError({ detail: "GitHub didn't answer in time.", uncertain: true }),
      )
      .mockResolvedValueOnce({
        submissionId: "share00000001",
        entryId: "entry-1",
        sourceHash: "a".repeat(64),
        publishedHash: "b".repeat(64),
        login: "octocat",
        pullRequestUrl: "https://github.com/Threadlines/themes/pull/7",
        state: "inReview",
        createdAt: "2026-11-09T12:00:00.000Z",
      });
    await open();
    await page.getByRole("button", { name: "Share" }).click();
    await expect.element(page.getByText("GitHub didn't answer in time.")).toBeVisible();
    await page.getByRole("button", { name: "Check and share" }).click();
    await expect.element(page.getByText("Sent for review")).toBeVisible();
    expect(showcase.submit.mock.calls.map(([, input]) => input.submissionId)).toEqual([
      "share00000001",
      "share00000001",
    ]);
    expect(showcase.submit.mock.calls[0]?.[1]).toMatchObject({
      login: "octocat",
      credits: { license: "CC-BY-4.0" },
    });
  });

  it("takes a share back, and keeps the dialog open with the reason when GitHub won't", async () => {
    const onClose = vi.fn();
    showcase.takeBack
      .mockRejectedValueOnce(
        new ThemeShowcaseError({
          detail: "GitHub is now signed in as @someone-else, not @octocat.",
        }),
      )
      .mockResolvedValueOnce({ state: "notAdded", takenBack: true });
    await render(
      <ThemeTakeBackDialog
        environmentId={"env-1" as EnvironmentId}
        name="Harbor Night"
        submission={{
          submissionId: "share00000001",
          entryId: "entry-1",
          sourceHash: "a".repeat(64),
          publishedHash: "b".repeat(64),
          login: "octocat",
          pullRequestUrl: "https://github.com/Threadlines/themes/pull/7",
          state: "inReview",
          createdAt: "2026-11-09T12:00:00.000Z",
        }}
        onClose={onClose}
      />,
    );
    await page.getByRole("button", { name: "Take back" }).click();
    await expect.element(page.getByText("now signed in as @someone-else")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Take back" }).click();
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(showcase.takeBack.mock.calls.map(([, submissionId]) => submissionId)).toEqual([
      "share00000001",
      "share00000001",
    ]);
  });
});
