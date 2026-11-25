/**
 * Find in chat: the bar over the top right of the chat list, and everything
 * behind it while it is open. Mounted by MessagesTimeline, opened through
 * chatFindStore (the chat.find keybinding, the command palette).
 *
 * The bar itself, its focus capture, and Escape handling stay eager so Cmd/Ctrl+F
 * immediately takes focus and never lets typed characters or Enter leak into
 * the composer. Only the indexing and DOM match painter (ChatFindSession) load
 * lazily after the bar opens, keeping unified/rehype-raw out of the initial
 * chat chunk.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useChatFindStore } from "../../../chatFindStore";
import { FindBar, type FindBarTally } from "../../FindBar";
import type { ChatFindProps } from "./ChatFindSession";

export { selectedChatText } from "./chatFindSelection";
export type { ChatFindProps } from "./ChatFindSession";

const LazyChatFindSession = lazy(() => import("./ChatFindSession"));

export function ChatFind(props: ChatFindProps) {
  const open = useChatFindStore((state) => state.open);
  const close = useChatFindStore((state) => state.close);
  // The bar belongs to this chat: it closes when the chat goes.
  useEffect(() => close, [close]);
  if (!open) return null;
  return <ChatFindOpen {...props} />;
}

function ChatFindOpen(props: ChatFindProps) {
  const query = useChatFindStore((state) => state.query);
  const setQuery = useChatFindStore((state) => state.setQuery);
  const close = useChatFindStore((state) => state.close);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const stepRef = useRef<((direction: 1 | -1) => void) | null>(null);
  const [sessionTally, setSessionTally] = useState<FindBarTally | null>(null);

  // Focus goes back where it was when the bar closes.
  const returnFocusRef = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current = active && active !== document.body ? active : null;
    const bar = barRef.current;
    return () => {
      // Runs before the bar leaves the page, so focus may still be in it.
      const target = returnFocusRef.current;
      const focus = document.activeElement;
      const focusGoesWithBar =
        focus === null ||
        focus === document.body ||
        !focus.isConnected ||
        (bar !== null && bar.contains(focus));
      if (focusGoesWithBar && target instanceof HTMLElement && target.isConnected) {
        target.focus({ preventScroll: true });
      }
    };
  }, []);

  // The field takes focus on opening and on every later open request (Cmd+F
  // pressed again while the bar is open).
  useEffect(() => {
    const focusField = () => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    };
    focusField();
    return useChatFindStore.subscribe((state, previous) => {
      if (state.focusRequest !== previous.focusRequest) focusField();
    });
  }, []);

  const step = useCallback((direction: 1 | -1) => {
    stepRef.current?.(direction);
  }, []);

  const tally: FindBarTally | null =
    query.trim().length === 0 ? null : (sessionTally ?? { kind: "pending" });

  return (
    <div
      ref={barRef}
      className="absolute top-2 right-3 z-20 mr-(--safe-area-right) max-w-[calc(100%-1.5rem-var(--safe-area-right))]"
    >
      <FindBar
        query={query}
        onQueryChange={setQuery}
        onStep={step}
        onClose={close}
        tally={tally}
        placeholder="Find in chat"
        inputRef={inputRef}
        testIdPrefix="chat-find"
      />
      <Suspense fallback={null}>
        <LazyChatFindSession
          {...props}
          barRef={barRef}
          stepRef={stepRef}
          onTallyChange={setSessionTally}
        />
      </Suspense>
    </div>
  );
}
