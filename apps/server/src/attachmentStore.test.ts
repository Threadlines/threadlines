// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatAttachmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadlines-attachment-store-"));
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = path.join(attachmentsDir, `${attachmentId}.png`);
      fs.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("builds storage paths for file attachments from their canonical extension", () => {
    expect(
      attachmentRelativePath({
        type: "file",
        kind: "pdf",
        id: "thread-1-file" as ChatAttachmentId,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }),
    ).toBe("thread-1-file.pdf");
    expect(
      attachmentRelativePath({
        type: "file",
        kind: "text",
        id: "thread-1-notes" as ChatAttachmentId,
        name: "notes.markdown",
        mimeType: "text/markdown",
        sizeBytes: 10,
      }),
    ).toBe("thread-1-notes.md");
  });

  it("resolves file attachment paths by id", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadlines-attachment-store-"));
    try {
      const attachmentId = "thread-1-doc";
      const pdfPath = path.join(attachmentsDir, `${attachmentId}.pdf`);
      fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pdfPath);
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("stores any other file under its own extension and finds it by id", () => {
    const attachment = {
      type: "file",
      kind: "other",
      id: "thread-1-brief" as ChatAttachmentId,
      name: "Brief.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 10,
    } as const;
    expect(attachmentRelativePath(attachment)).toBe("thread-1-brief.docx");

    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadlines-attachment-store-"));
    try {
      const docxPath = path.join(attachmentsDir, "thread-1-brief.docx");
      fs.writeFileSync(docxPath, Buffer.from("PK"));
      // Another attachment whose id starts the same way is not this one.
      fs.writeFileSync(path.join(attachmentsDir, "thread-1-brief-2.xlsx"), Buffer.from("PK"));

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: "thread-1-brief" })).toBe(
        docxPath,
      );
      expect(
        resolveAttachmentPathById({ attachmentsDir, attachmentId: "thread-1-bri" }),
      ).toBeNull();
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadlines-attachment-store-"));
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
