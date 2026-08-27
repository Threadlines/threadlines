import { useLayoutEffect, useRef } from "react";

import { cn } from "~/lib/utils";

/**
 * One motion per working-anchor label. The three dots never change; each
 * state is a pose (where the dots sit) plus one small loop. Styles live in
 * index.css under `.working-dots`.
 */
export type WorkingDotsState =
  | "working"
  | "thinking"
  | "sending"
  | "connecting"
  | "preparing"
  | "waiting"
  | "approval"
  | "input"
  | "reverting"
  | "agents";

const STATE_BY_LABEL: Readonly<Record<string, WorkingDotsState>> = {
  Working: "working",
  "Agent working": "agents",
  Thinking: "thinking",
  Sending: "sending",
  Connecting: "connecting",
  "Preparing turn": "preparing",
  "Preparing worktree": "preparing",
  "Waiting for model": "waiting",
  Waiting: "waiting",
  "Waiting for approval": "approval",
  "Waiting for input": "input",
  "Reverting checkpoint": "reverting",
  "Agents working": "agents",
};

/**
 * Maps the anchor's status word to its dot motion; unknown words get the
 * generic one. The word keeps describing the turn itself (with the tracker
 * beside it carrying the agent count), but live agents promote the plain
 * "Working" motion to the agents one so the dots say agents are running on
 * either provider. Specific words keep their own motion.
 */
export function workingDotsStateForLabel(label: string, liveAgentCount = 0): WorkingDotsState {
  const state = STATE_BY_LABEL[label] ?? "working";
  return state === "working" && liveAgentCount > 0 ? "agents" : state;
}

/** The agent has stopped and needs the user: the anchor turns amber. */
export function isWaitingOnUserState(state: WorkingDotsState): boolean {
  return state === "approval" || state === "input";
}

// Kept short and low: with agents running, "Working" and "Thinking" trade
// places every few seconds, and each flip moves every dot.
const HOP_MS = 380;
const HOP_STAGGER_MS = 35;
const HOP_ARC_PX = 2;

function isScriptAnimation(animation: Animation): boolean {
  return !("animationName" in animation) && !("transitionProperty" in animation);
}

/**
 * Hand-off between states. CSS cannot blend a running loop into the next one,
 * so this measures where each dot really is (pose + loop offset), switches the
 * state, then hops the pose wrapper from that spot to its new pose along a
 * small arc, one dot after another. A dot already resting on its target stays
 * put: status words flip fast at the start of a turn, and bouncing dots that
 * have nowhere to go reads as noise. Each loop has a .6s head start in CSS so
 * it never cuts in before the landing.
 */
function hopDotsToState(root: HTMLElement, state: WorkingDotsState): void {
  const box = root.getBoundingClientRect();
  const dots = Array.from(root.children).flatMap((pose) => {
    const dot = pose.firstElementChild;
    if (!(pose instanceof HTMLElement) || !(dot instanceof HTMLElement)) {
      return [];
    }
    const rect = dot.getBoundingClientRect();
    return [
      {
        pose,
        dot,
        x: rect.left - box.left,
        y: rect.top - box.top,
        opacity: getComputedStyle(dot).opacity,
      },
    ];
  });
  for (const { pose, dot, opacity } of dots) {
    dot.style.cssText = `transition:none;opacity:${opacity}`;
    for (const animation of pose.getAnimations()) {
      if (isScriptAnimation(animation)) {
        animation.cancel();
      }
    }
  }
  root.dataset.state = state;
  void root.offsetWidth;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  dots.forEach(({ pose, dot, x, y }, index) => {
    dot.style.cssText = "";
    if (reduceMotion) {
      return;
    }
    const poseStyle = getComputedStyle(pose);
    const targetX = parseFloat(poseStyle.getPropertyValue("--x"));
    const targetY = parseFloat(poseStyle.getPropertyValue("--y"));
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
      return;
    }
    if (Math.abs(targetX - x) < 0.5 && Math.abs(targetY - y) < 0.5) {
      return;
    }
    const apexX = (x + targetX) / 2;
    const apexY = Math.min(y, targetY) - HOP_ARC_PX;
    pose.animate(
      [
        { transform: `translate(${x}px, ${y}px)`, easing: "cubic-bezier(.25,.6,.4,1)" },
        {
          transform: `translate(${apexX}px, ${apexY}px)`,
          easing: "cubic-bezier(.6,0,.75,.4)",
          offset: 0.5,
        },
        { transform: `translate(${targetX}px, ${targetY}px)` },
      ],
      { duration: HOP_MS, delay: index * HOP_STAGGER_MS, fill: "backwards" },
    );
  });
}

/**
 * The working anchor's live mark: three dots whose motion says what the turn
 * is doing. The state attribute is owned imperatively after mount so a change
 * can be measured before it lands (React keeps rendering the mount-time value
 * and never overwrites it).
 */
export function WorkingAnchorDots({
  state,
  className,
}: {
  state: WorkingDotsState;
  className?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const mountState = useRef(state).current;
  const appliedState = useRef<WorkingDotsState | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    if (appliedState.current === null) {
      root.dataset.state = state;
    } else if (appliedState.current !== state) {
      hopDotsToState(root, state);
    }
    appliedState.current = state;
  }, [state]);

  return (
    <span
      ref={rootRef}
      className={cn("working-dots", className)}
      data-state={mountState}
      aria-hidden="true"
    >
      <span>
        <span />
      </span>
      <span>
        <span />
      </span>
      <span>
        <span />
      </span>
    </span>
  );
}
