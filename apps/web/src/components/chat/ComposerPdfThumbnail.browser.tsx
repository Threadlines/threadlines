import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../../lib/testPage.browser-harness";
import { ComposerPdfThumbnail } from "./ComposerPdfThumbnail";

/** One page that says "Hello PDF". */
const TINY_PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
  "4 0 obj<</Length 44>>stream",
  "BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET",
  "endstream endobj",
  "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");

describe("ComposerPdfThumbnail", () => {
  afterEach(async () => {
    await resetTestPage();
  });

  it("shows an attached PDF's first page, and the file's name when it can't", async () => {
    const screen = await render(
      <div style={{ width: 64, height: 64 }}>
        <ComposerPdfThumbnail
          file={new Blob([TINY_PDF], { type: "application/pdf" })}
          name="brief.pdf"
        />
        <ComposerPdfThumbnail
          file={new Blob(["not a pdf"], { type: "application/pdf" })}
          name="broken.pdf"
        />
      </div>,
    );
    try {
      await expect
        .element(page.getByRole("img", { name: "First page of brief.pdf" }), { timeout: 15_000 })
        .toBeVisible();
      await expect.element(page.getByText("broken.pdf")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
