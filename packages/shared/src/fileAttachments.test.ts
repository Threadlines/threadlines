import { describe, expect, it } from "vite-plus/test";

import {
  classifyFileAttachmentBytes,
  fileAttachmentExtension,
  fileAttachmentMimeTypeForExtension,
  resolveFileAttachmentType,
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

  it("takes any other file as one the agent opens from disk", () => {
    expect(
      resolveFileAttachmentType({
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "Brief.DOCX",
      }),
    ).toEqual({
      kind: "other",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: ".docx",
    });
    expect(resolveFileAttachmentType({ mimeType: "", fileName: "tool.exe" })).toEqual({
      kind: "other",
      mimeType: "application/octet-stream",
      extension: ".exe",
    });
    expect(resolveFileAttachmentType({})).toEqual({
      kind: "other",
      mimeType: "application/octet-stream",
      extension: ".bin",
    });
    // A concrete (non-generic) MIME type wins over a PDF-looking name.
    expect(resolveFileAttachmentType({ mimeType: "application/zip", fileName: "a.pdf" }).kind).toBe(
      "other",
    );
  });

  it("knows text files by their type or their own extension, as a type older builds know", () => {
    const plainText = { kind: "text", mimeType: "text/plain", extension: ".txt" };
    expect(resolveFileAttachmentType({ mimeType: "application/json", fileName: "a.json" })).toEqual(
      plainText,
    );
    expect(resolveFileAttachmentType({ mimeType: "text/x-python", fileName: "a.py" })).toEqual(
      plainText,
    );
    expect(resolveFileAttachmentType({ mimeType: "", fileName: "main.go" })).toEqual(plainText);
    // Browsers call a .ts file an MPEG video and a .csv on Windows an Excel file.
    expect(resolveFileAttachmentType({ mimeType: "video/mp2t", fileName: "a.ts" }).kind).toBe(
      "text",
    );
    expect(
      resolveFileAttachmentType({ mimeType: "application/vnd.ms-excel", fileName: "rows.csv" }),
    ).toEqual({ kind: "text", mimeType: "text/csv", extension: ".csv" });
  });
});

describe("fileAttachmentExtension", () => {
  it("keeps the fixed extension of canonical types and the name's own otherwise", () => {
    // Stored before any file was allowed: the path follows the type alone.
    expect(fileAttachmentExtension({ mimeType: "text/plain", fileName: "notes.log" })).toBe(".txt");
    expect(fileAttachmentExtension({ mimeType: "text/markdown", fileName: "a.markdown" })).toBe(
      ".md",
    );
    expect(fileAttachmentExtension({ mimeType: "application/zip", fileName: "a.zip" })).toBe(
      ".zip",
    );
    expect(fileAttachmentExtension({ mimeType: "application/zip" })).toBe(".bin");
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

describe("classifyFileAttachmentBytes", () => {
  const settle = (input: { mimeType?: string; fileName: string }, bytes: Uint8Array) =>
    classifyFileAttachmentBytes(resolveFileAttachmentType(input), input.fileName, bytes);

  it("requires the PDF signature from a PDF", () => {
    expect(settle({ fileName: "a.pdf" }, Buffer.from("%PDF-1.7 rest"))?.kind).toBe("pdf");
    expect(settle({ fileName: "a.pdf" }, Buffer.from("not a pdf"))).toBeNull();
    expect(settle({ fileName: "a.pdf" }, Buffer.from("%PDF-"))).toBeNull();
  });

  it("hands text that does not read as text to the agent as a file", () => {
    expect(settle({ fileName: "a.txt" }, Buffer.from("plain text\nline two"))?.kind).toBe("text");
    // UTF-16 text from Windows carries NUL bytes.
    expect(settle({ fileName: "a.txt" }, Buffer.from([104, 0, 105, 0]))).toEqual({
      kind: "other",
      mimeType: "text/plain",
      extension: ".txt",
    });
    expect(settle({ fileName: "a.txt" }, Buffer.from([0xc3, 0x28, 0x41]))?.kind).toBe("other");
  });

  it("reads a file with no known type as text when its bytes are text", () => {
    expect(settle({ fileName: "Dockerfile" }, Buffer.from("FROM node:22\n"))).toEqual({
      kind: "text",
      mimeType: "text/plain",
      extension: ".txt",
    });
    expect(
      settle({ mimeType: "application/rtf", fileName: "a.rtf" }, Buffer.from("{\\rtf1 hi}")),
    ).toEqual({ kind: "text", mimeType: "text/plain", extension: ".txt" });
    // A Word document is a zip: binary, so it stays a file to open.
    expect(
      settle({ fileName: "a.docx" }, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])),
    ).toEqual({ kind: "other", mimeType: "application/octet-stream", extension: ".docx" });
  });

  it("does not split a character cut off at the end of the sniffed window", () => {
    const text = Buffer.from(`${"a".repeat(8_191)}é and more`);
    expect(settle({ fileName: "a.txt" }, text)?.kind).toBe("text");
  });
});
