import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { useDraftHeroCapable, useDraftHeroComposerSlide } from "./useDraftHero";

interface ViewState {
  /** Which chat view is mounted: the draft's, or the server thread's that replaces it. */
  view: "draft" | "server";
  heroShown: boolean;
  heroCapable: boolean;
}

/** The chat column in miniature: a timeline slot that holds the hero marker, then the input bar. */
function View({ threadKey, state }: { threadKey: string; state: ViewState }) {
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  const [inputBar, setInputBar] = useState<HTMLDivElement | null>(null);
  useDraftHeroComposerSlide({
    column,
    inputBar,
    threadKey,
    isLocalDraft: state.view === "draft",
    heroCapable: state.heroCapable,
  });
  return (
    <div
      ref={setColumn}
      data-chat-column=""
      style={{ display: "flex", flexDirection: "column", height: 600 }}
    >
      <div style={state.heroShown ? { flex: "none", marginTop: 200 } : { flex: "1 1 0%" }}>
        {state.heroShown ? <div data-draft-hero="">What's next?</div> : null}
      </div>
      <div ref={setInputBar} data-testid="input-bar">
        <div>composer</div>
      </div>
    </div>
  );
}

function Harness({
  threadKey,
  onApi,
}: {
  threadKey: string;
  onApi: (set: (next: Partial<ViewState>) => void) => void;
}) {
  const [state, setState] = useState<ViewState>({
    view: "draft",
    heroShown: true,
    heroCapable: true,
  });
  onApi((next) => setState((current) => ({ ...current, ...next })));
  // Keyed by view: promotion swaps the chat view for another instance.
  return <View key={state.view} threadKey={threadKey} state={state} />;
}

async function mount(threadKey: string) {
  let set: (next: Partial<ViewState>) => void = () => undefined;
  const screen = await render(
    <Harness
      threadKey={threadKey}
      onApi={(next) => {
        set = next;
      }}
    />,
  );
  const inputBar = () => screen.getByTestId("input-bar").element();
  const slides = () =>
    inputBar()
      .getAnimations()
      .filter((animation) => animation.playState === "running");
  return { set: (next: Partial<ViewState>) => set(next), inputBar, slides };
}

describe("useDraftHeroComposerSlide", () => {
  it("slides the composer down on the first send and carries the slide into the view that replaces the draft's", async () => {
    const view = await mount("env:carry");
    const draftInputBar = view.inputBar();
    expect(view.slides()).toHaveLength(0);

    view.set({ heroShown: false });
    await expect.poll(() => view.slides().length).toBe(1);
    const fromTransform = (view.slides()[0]!.effect as KeyframeEffect).getKeyframes()[0]!.transform;
    // It starts where the composer was: above where it now sits.
    expect(fromTransform).toMatch(/^translateY\(-\d/);

    // The server thread's view mounts in the draft's place mid-slide.
    view.set({ view: "server" });
    await expect.poll(() => view.inputBar() !== draftInputBar).toBe(true);
    expect(view.slides()).toHaveLength(1);
    expect(Number(view.slides()[0]!.currentTime)).toBeGreaterThan(0);
  });

  it("does not slide when the hero leaves because the pane lost its room", async () => {
    const view = await mount("env:relayout");

    view.set({ heroShown: false, heroCapable: false });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(view.slides()).toHaveLength(0);
  });

  it("drops the slide when a failed send puts the hero back", async () => {
    const view = await mount("env:rollback");

    view.set({ heroShown: false });
    await expect.poll(() => view.slides().length).toBe(1);

    view.set({ heroShown: true });
    await expect.poll(() => view.slides().length).toBe(0);
  });
});

/**
 * A pane just over the hero's minimum width whose scrollbar takes up room.
 * The test browser hides scrollbars, so a border stands in for one: both sit
 * outside the client box and inside the pane's own size.
 */
function CapablePane() {
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  const capable = useDraftHeroCapable(column, true);
  return (
    <>
      <div
        ref={setColumn}
        data-testid="pane"
        style={{
          boxSizing: "border-box",
          width: 565,
          height: 640,
          borderRight: "12px solid transparent",
        }}
      />
      <span data-testid="capable">{String(capable)}</span>
    </>
  );
}

describe("useDraftHeroCapable", () => {
  it("does not lose the hero to the scrollbar the hero itself brings", async () => {
    await page.viewport(1_200, 900);
    const screen = await render(<CapablePane />);
    const pane = screen.getByTestId("pane").element() as HTMLElement;

    // The room inside the pane is under the minimum. Deciding by that would
    // drop the hero, which removes the scrollbar, which brings the hero back:
    // the pane's own size is what has to be measured.
    expect(pane.clientWidth).toBeLessThan(560);
    await expect.element(screen.getByTestId("capable")).toHaveTextContent("true");
  });
});
