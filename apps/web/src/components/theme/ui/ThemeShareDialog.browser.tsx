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
}));
vi.mock("~/themeLibrary/themeShowcase", () => ({
  newShowcaseSubmissionId: () => "share00000001",
  prepareShowcaseShare: showcase.prepare,
  submitShowcaseShare: showcase.submit,
  readShowcaseAccount: () => Promise.resolve({ status: "signedIn", login: "octocat" }),
}));

const { ThemeShareDialog } = await import("./ThemeShareDialog");

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

const open = () =>
  render(
    <ThemeShareDialog
      environmentId={"env-1" as EnvironmentId}
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
});
