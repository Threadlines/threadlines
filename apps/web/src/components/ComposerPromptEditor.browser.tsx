import "../index.css";

import { useRef, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

function EditorHarness(props: { recognizedSlashCommands: ReadonlyArray<string> }) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);

  return (
    <ComposerPromptEditor
      value={value}
      cursor={cursor}
      terminalContexts={[]}
      skills={[]}
      recognizedSlashCommands={props.recognizedSlashCommands}
      disabled={false}
      placeholder="Type here"
      onRemoveTerminalContext={vi.fn()}
      onChange={(nextValue, nextCursor) => {
        setValue(nextValue);
        setCursor(nextCursor);
      }}
      onPaste={vi.fn()}
      editorRef={editorRef}
    />
  );
}

async function typeIntoEditor(text: string) {
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await userEvent.keyboard(text);
}

function commandTokenText(): string | null {
  return document.querySelector(".composer-command-token")?.textContent ?? null;
}

describe("ComposerPromptEditor command token", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tints a recognized leading command and keeps arguments plain", async () => {
    const screen = await render(
      <EditorHarness recognizedSlashCommands={["goal", "plan", "default"]} />,
    );
    await typeIntoEditor("/goal ship the feature");

    await expect.poll(commandTokenText).toBe("/goal");
    expect(document.querySelectorAll(".composer-command-token")).toHaveLength(1);
    await screen.unmount();
  });

  it("demotes the token when the command stops matching", async () => {
    const screen = await render(
      <EditorHarness recognizedSlashCommands={["goal", "plan", "default"]} />,
    );
    await typeIntoEditor("/goal");
    await expect.poll(commandTokenText).toBe("/goal");

    await userEvent.keyboard("s");
    await expect.poll(commandTokenText).toBeNull();
    await screen.unmount();
  });

  it("ignores commands that are not at the start of the prompt", async () => {
    const screen = await render(
      <EditorHarness recognizedSlashCommands={["goal", "plan", "default"]} />,
    );
    await typeIntoEditor("see /goal for details");

    await expect
      .poll(() => page.getByTestId("composer-editor").query()?.textContent)
      .toContain("/goal");
    expect(commandTokenText()).toBeNull();
    await screen.unmount();
  });

  it("ignores commands the thread does not support", async () => {
    const screen = await render(<EditorHarness recognizedSlashCommands={["plan", "default"]} />);
    await typeIntoEditor("/goal ship it");

    await expect
      .poll(() => page.getByTestId("composer-editor").query()?.textContent)
      .toContain("/goal");
    expect(commandTokenText()).toBeNull();
    await screen.unmount();
  });
});
