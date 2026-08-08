import { userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ClipboardUnavailableError,
  copyTextToClipboard,
  isClipboardCopySupported,
} from "./clipboard";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "clipboard",
);
const originalExecCommand = document.execCommand;

/**
 * Insecure contexts (a phone paired over plain `http://<lan-ip>`) do not expose
 * `navigator.clipboard` at all.
 */
function removeAsyncClipboard(): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
}

function failAsyncClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error("Write permission denied.")) },
  });
}

function removeExecCommand(): void {
  Object.defineProperty(document, "execCommand", { configurable: true, value: undefined });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  if (originalClipboardDescriptor) {
    Object.defineProperty(Navigator.prototype, "clipboard", originalClipboardDescriptor);
  }
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
});

/**
 * Copies the way the app does: from a real click, because `execCommand("copy")`
 * needs user activation. Asserts on the `copy` event rather than reading the
 * clipboard back, which the test browser will not permit.
 */
async function captureCopyFromClick(value: string): Promise<string> {
  let copied = "";
  let failure: unknown = null;
  const onCopy = () => {
    copied = document.getSelection()?.toString() ?? "";
  };
  const trigger = document.createElement("button");
  trigger.textContent = "Copy";
  trigger.addEventListener("click", () => {
    void copyTextToClipboard(value).catch((error: unknown) => {
      failure = error;
    });
  });
  document.body.append(trigger);
  document.addEventListener("copy", onCopy);
  try {
    await userEvent.click(trigger);
  } finally {
    document.removeEventListener("copy", onCopy);
    trigger.remove();
  }
  if (failure) throw failure;
  return copied;
}

describe("copyTextToClipboard", () => {
  it("copies through execCommand when the async Clipboard API is missing", async () => {
    removeAsyncClipboard();

    await expect(captureCopyFromClick("http://192.168.1.213:8266/pair#token=ABC123")).resolves.toBe(
      "http://192.168.1.213:8266/pair#token=ABC123",
    );
  });

  it("falls back to execCommand when the async Clipboard API rejects", async () => {
    failAsyncClipboard();

    await expect(captureCopyFromClick("WAKYKHXBJ55Y")).resolves.toBe("WAKYKHXBJ55Y");
  });

  it("reports the value as uncopyable when no copy path exists", async () => {
    removeAsyncClipboard();
    removeExecCommand();

    expect(isClipboardCopySupported()).toBe(false);
    await expect(copyTextToClipboard("WAKYKHXBJ55Y")).rejects.toBeInstanceOf(
      ClipboardUnavailableError,
    );
  });

  it("still offers copy when only the execCommand fallback is available", () => {
    removeAsyncClipboard();

    expect(isClipboardCopySupported()).toBe(true);
  });
});
