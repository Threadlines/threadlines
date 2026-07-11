import { describe, expect, it } from "vite-plus/test";

import {
  fileAttachmentExtension,
  fileAttachmentMimeTypeForExtension,
  resolveFileAttachmentType,
  sniffFileAttachmentBytes,
} from "./fileAttachments.ts";

describe("resolveFileAttachmentType", () => {
  it("resolves supported MIME types to their canonical kind and extension", () => {
    expect(resolveFileAttachmentType({ mimeType: "application/pdf" })).toEqual({
      kind: "pdf",
      mimeType: "application/pdf",
      extension: ".pdf",
    });
    expect(resolveFileAttachmentType({ mimeType: "text/markdown" })?.kind).toBe("text");
    expect(resolveFileAttachmentType({ mimeType: "text/csv" })?.extension).toBe(".csv");
    expect(resolveFileAttachmentType({ mimeType: "TEXT/PLAIN; charset=utf-8" })?.extension).toBe(
      ".txt",
    );
  });

  it("falls back to the file name extension for missing or generic MIME types", () => {
    expect(resolveFileAttachmentType({ mimeType: "", fileName: "notes.md" })?.mimeType).toBe(
      "text/markdown",
    );
    expect(
      resolveFileAttachmentType({
        mimeType: "application/octet-stream",
        fileName: "REPORT.PDF",
      })?.kind,
    ).toBe("pdf");
    expect(resolveFileAttachmentType({ fileName: "doc.markdown" })?.extension).toBe(".md");
  });

  it("rejects unsupported files", () => {
    expect(
      resolveFileAttachmentType({ mimeType: "application/zip", fileName: "a.zip" }),
    ).toBeNull();
    expect(resolveFileAttachmentType({ mimeType: "", fileName: "binary.exe" })).toBeNull();
    // A concrete (non-generic) MIME type wins over a supported-looking name.
    expect(
      resolveFileAttachmentType({ mimeType: "application/zip", fileName: "a.pdf" }),
    ).toBeNull();
    expect(resolveFileAttachmentType({})).toBeNull();
  });
});

describe("fileAttachmentExtension", () => {
  it("returns .bin for unsupported types", () => {
    expect(fileAttachmentExtension({ mimeType: "application/zip" })).toBe(".bin");
    expect(fileAttachmentExtension({ mimeType: "application/pdf" })).toBe(".pdf");
  });
});

describe("fileAttachmentMimeTypeForExtension", () => {
  it("maps stored extensions back to canonical MIME types", () => {
    expect(fileAttachmentMimeTypeForExtension(".pdf")).toBe("application/pdf");
    expect(fileAttachmentMimeTypeForExtension(".md")).toBe("text/markdown");
    expect(fileAttachmentMimeTypeForExtension(".csv")).toBe("text/csv");
    expect(fileAttachmentMimeTypeForExtension(".exe")).toBeNull();
  });
});

describe("sniffFileAttachmentBytes", () => {
  it("requires the PDF magic for pdf attachments", () => {
    expect(sniffFileAttachmentBytes("pdf", Buffer.from("%PDF-1.7 rest"))).toBe(true);
    expect(sniffFileAttachmentBytes("pdf", Buffer.from("not a pdf"))).toBe(false);
    expect(sniffFileAttachmentBytes("pdf", Buffer.from("%PDF-"))).toBe(false);
  });

  it("rejects NUL bytes in text attachments", () => {
    expect(sniffFileAttachmentBytes("text", Buffer.from("plain text\nline two"))).toBe(true);
    expect(sniffFileAttachmentBytes("text", Buffer.from([104, 105, 0, 106]))).toBe(false);
  });
});
