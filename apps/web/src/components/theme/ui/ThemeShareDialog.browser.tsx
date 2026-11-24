import "../../../index.css";

import {
  type EnvironmentId,
  THEME_FILE_FORMAT,
  type ThemeManifest,
  type ThemeShowcaseEntry,
  ThemeShowcaseError,
  type ThemeShowcasePreparation,
  type ThemeShowcaseSlug,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../../../lib/testPage.browser-harness";

const showcase = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  takeBack: vi.fn(),
  entries: vi.fn<() => Promise<ReadonlyArray<ThemeShowcaseEntry>>>(() => Promise.resolve([])),
  nextId: 1,
}));
vi.mock("~/themeLibrary/themeShowcase", () => ({
  newShowcaseSubmissionId: () => `share0000000${showcase.nextId++}`,
  prepareShowcaseShare: showcase.prepare,
  submitShowcaseShare: showcase.submit,
  takeBackShowcaseShare: showcase.takeBack,
  readShowcaseEntries: showcase.entries,
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

const listedHarbor: ThemeShowcaseEntry = {
  id: "harbor-night",
  name: "Harbor Night",
  base: "dark",
  hasArt: false,
  colors: { background: "#0b1420", foreground: "#e6eef8", accent: "#4cc2ff" },
  credits: { author: "Octo", license: "CC0-1.0" },
  sharedBy: "octocat",
  featured: false,
  addedAt: "2026-11-09",
  hash: "a".repeat(64),
  file: {
    path: "themes/harbor-night/theme.threadlines-theme",
    sha256: "b".repeat(64),
    bytes: 512,
  },
  thumbnail: {
    path: "themes/harbor-night/thumbnail.png",
    sha256: "c".repeat(64),
    bytes: 1024,
  },
};

const open = (
  options: {
    readonly keepsEmailPrivate?: boolean;
    readonly supportsUpdate?: boolean;
    readonly listedSlug?: ThemeShowcaseSlug;
  } = {},
) =>
  render(
    <ThemeShareDialog
      environmentId={"env-1" as EnvironmentId}
      keepsEmailPrivate={options.keepsEmailPrivate ?? true}
      supportsUpdate={options.supportsUpdate ?? true}
      {...(options.listedSlug !== undefined ? { listedSlug: options.listedSlug } : {})}
      entryId="entry-1"
      name="Harbor Night"
      manifest={harbor}
      onClose={() => {}}
    />,
  );

describe("ThemeShareDialog", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    showcase.entries.mockResolvedValue([]);
    showcase.nextId = 1;
    localStorage.removeItem("threadlines:theme-export-credits");
    await resetTestPage();
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

    await open({ keepsEmailPrivate: false });
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

  it("defaults to updating a matching Showcase theme owned by the signed-in account, and allows sharing as new", async () => {
    showcase.prepare.mockResolvedValue(ready());
    showcase.entries.mockResolvedValue([listedHarbor]);
    showcase.submit.mockResolvedValue({
      submissionId: "share00000001",
      entryId: "entry-1",
      sourceHash: "a".repeat(64),
      publishedHash: "b".repeat(64),
      slug: "harbor-night",
      login: "octocat",
      pullRequestUrl: "https://github.com/Threadlines/themes/pull/14",
      state: "inReview",
      isUpdate: true,
      createdAt: "2026-11-24T12:00:00.000Z",
    });

    const first = await open();
    await expect.element(page.getByText("Update Harbor Night in the Showcase")).toBeVisible();
    await expect.element(page.getByPlaceholder("Your name")).toHaveValue("Octo");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect
      .element(page.getByText("Harbor Night's update goes into the Showcase"))
      .toBeVisible();
    expect(showcase.submit.mock.calls[0]?.[1]).toMatchObject({
      login: "octocat",
      updateSlug: "harbor-night",
      credits: { author: "Octo", license: "CC0-1.0" },
    });
    await first.unmount();

    // Switching the Showcase picker to "Share as a new theme" omits updateSlug.
    showcase.submit.mockResolvedValueOnce({
      submissionId: "share00000003",
      entryId: "entry-1",
      sourceHash: "a".repeat(64),
      publishedHash: "b".repeat(64),
      slug: "harbor-night-2",
      login: "octocat",
      pullRequestUrl: "https://github.com/Threadlines/themes/pull/15",
      state: "inReview",
      createdAt: "2026-11-24T12:01:00.000Z",
    });
    await open();
    await expect.element(page.getByText("Update Harbor Night in the Showcase")).toBeVisible();
    await page.getByRole("combobox", { name: "Showcase target" }).click();
    await page.getByRole("option", { name: "Share as a new theme" }).click();
    await expect.element(page.getByText("Share Harbor Night to the Showcase")).toBeVisible();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect.element(page.getByText("Harbor Night goes into the Showcase")).toBeVisible();
    expect(showcase.submit.mock.calls[1]?.[1]).not.toHaveProperty("updateSlug");
  });

  it("can manually select an existing Showcase theme whose slug is 'new'", async () => {
    showcase.prepare.mockResolvedValue(ready());
    showcase.entries.mockResolvedValue([{ ...listedHarbor, id: "new", name: "New" }]);
    showcase.submit.mockResolvedValue({
      submissionId: "share00000002",
      entryId: "entry-1",
      sourceHash: "a".repeat(64),
      publishedHash: "b".repeat(64),
      slug: "new",
      login: "octocat",
      pullRequestUrl: "https://github.com/Threadlines/themes/pull/16",
      state: "inReview",
      isUpdate: true,
      createdAt: "2026-11-24T12:02:00.000Z",
    });

    await open();
    await expect.element(page.getByText("Share Harbor Night to the Showcase")).toBeVisible();
    await page.getByRole("combobox", { name: "Showcase target" }).click();
    await page.getByRole("option", { name: "Update New" }).click();
    await expect.element(page.getByText("Update New in the Showcase")).toBeVisible();
    await page.getByRole("button", { name: "Update", exact: true }).click();
    expect(showcase.submit.mock.calls[0]?.[1]).toMatchObject({ updateSlug: "new" });
  });

  it("hides update controls on older servers that don't support themeShowcaseUpdate", async () => {
    showcase.prepare.mockResolvedValue(ready());
    showcase.entries.mockResolvedValue([listedHarbor]);
    await open({ supportsUpdate: false, listedSlug: "harbor-night" });
    await expect.element(page.getByText("Share Harbor Night to the Showcase")).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Showcase target" }))
      .not.toBeInTheDocument();
  });

  it("uses update wording in the take-back dialog for an update pull request", async () => {
    await render(
      <ThemeTakeBackDialog
        environmentId={"env-1" as EnvironmentId}
        name="Harbor Night"
        submission={{
          submissionId: "share00000001",
          entryId: "entry-1",
          sourceHash: "a".repeat(64),
          publishedHash: "b".repeat(64),
          slug: "harbor-night",
          login: "octocat",
          pullRequestUrl: "https://github.com/Threadlines/themes/pull/14",
          state: "inReview",
          isUpdate: true,
          createdAt: "2026-11-24T12:00:00.000Z",
        }}
        onClose={() => {}}
      />,
    );
    await expect.element(page.getByText("Take back update to Harbor Night?")).toBeVisible();
    await expect.element(page.getByText("The current version stays in the Showcase")).toBeVisible();
  });
});
