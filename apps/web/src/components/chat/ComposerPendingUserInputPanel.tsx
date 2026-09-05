import { type ApprovalRequestId } from "@threadlines/contracts";
import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  /** True while the timeline is scrolled away from the bottom; auto-collapses the panel. */
  isTimelineScrolledAway?: boolean;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
  onPrevious: () => void;
  onCustomAnswerChange: (questionId: string, value: string) => void;
  isUnavailable?: boolean;
  isAgentRunning: boolean;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  isTimelineScrolledAway = false,
  onToggleOption,
  onAdvance,
  onPrevious,
  onCustomAnswerChange,
  isUnavailable = false,
  isAgentRunning,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      isTimelineScrolledAway={isTimelineScrolledAway}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onPrevious={onPrevious}
      onCustomAnswerChange={onCustomAnswerChange}
      isUnavailable={isUnavailable}
      isAgentRunning={isAgentRunning}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  isTimelineScrolledAway,
  onToggleOption,
  onAdvance,
  onPrevious,
  onCustomAnswerChange,
  isUnavailable,
  isAgentRunning,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  isTimelineScrolledAway: boolean;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
  onPrevious: () => void;
  onCustomAnswerChange: (questionId: string, value: string) => void;
  isUnavailable: boolean;
  isAgentRunning: boolean;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  // Collapsed lets the user read the conversation above before answering. Scrolling
  // away from the timeline bottom auto-collapses; returning re-expands. A manual
  // toggle wins until the next scroll boundary change. State lives in this card
  // (keyed by requestId), so each prompt re-derives from the current scroll state.
  const [isCollapsed, setIsCollapsed] = useState(isTimelineScrolledAway);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const restoreToggleFocusRef = useRef(false);
  const toggleCollapsed = () => {
    restoreToggleFocusRef.current = true;
    setIsCollapsed((collapsed) => !collapsed);
  };
  useLayoutEffect(() => {
    if (restoreToggleFocusRef.current) {
      collapseButtonRef.current?.focus({ preventScroll: true });
      restoreToggleFocusRef.current = false;
    }
  }, [isCollapsed]);
  useEffect(() => {
    setIsCollapsed(isTimelineScrolledAway);
  }, [isTimelineScrolledAway]);
  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    onToggleOption(questionId, optionLabel);
  });

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Answers are only sent by the explicit submit action.
  useEffect(() => {
    if (!activeQuestion || isResponding || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, isCollapsed]);

  if (!activeQuestion) {
    return null;
  }

  if (isCollapsed) {
    return (
      <button
        type="button"
        aria-expanded={false}
        aria-label="Expand questions"
        ref={collapseButtonRef}
        onClick={toggleCollapsed}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 sm:px-5"
      >
        {prompt.questions.length > 1 ? (
          <span className="flex h-5 shrink-0 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] font-semibold tracking-widest text-muted-foreground/70 uppercase">
          {activeQuestion.header}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
          {activeQuestion.question}
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-muted-foreground/80" />
      </button>
    );
  }

  return (
    // The data attribute lets ChatView measure the expanded height to derive the
    // scroll distance at which auto-collapse becomes safe (no layout feedback).
    <div
      data-composer-questions-expanded="true"
      className="max-h-[50dvh] overflow-y-auto overscroll-contain px-4 py-2.5 sm:px-5"
    >
      <button
        type="button"
        aria-expanded={true}
        aria-label="Collapse questions"
        ref={collapseButtonRef}
        onClick={toggleCollapsed}
        className="group/header -mx-1.5 -my-1 flex w-[calc(100%+0.75rem)] cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/40"
      >
        <div className="flex min-w-0 items-center gap-2">
          {prompt.questions.length > 1 ? (
            <span className="flex h-5 shrink-0 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] font-semibold tracking-widest text-muted-foreground/70 uppercase">
            {activeQuestion.header}
          </span>
          {activeQuestion.multiSelect ? (
            <span className="truncate text-[11px] text-muted-foreground/70">
              · select one or more
            </span>
          ) : null}
        </div>
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/70 transition-colors group-hover/header:text-muted-foreground/80">
          <ChevronsDownUpIcon className="size-3.5" />
        </span>
      </button>
      <p className="mt-1 text-sm text-foreground/90">{activeQuestion.question}</p>
      {prompt.isBlocking === false ? (
        <p
          className="mt-0.5 text-[11px] leading-4 text-muted-foreground/70"
          data-composer-question-nonblocking="true"
        >
          {isAgentRunning
            ? "The agent keeps working while you answer."
            : "The agent finished. Your answer starts a follow-up."}
        </p>
      ) : (
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground/70">
          Waiting for your answer.
        </p>
      )}
      <div className="mt-2 space-y-0.5">
        {activeQuestion.options.map((option, index) => {
          const isSelected = progress.selectedOptionLabels.includes(option.label);
          const shortcutKey = index < 9 ? index + 1 : null;
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              aria-pressed={isSelected}
              onClick={() => handleOptionSelection(activeQuestion.id, option.label)}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-all duration-150",
                isSelected
                  ? "border-primary/40 bg-primary/8 text-foreground"
                  : "border-transparent bg-muted/20 text-foreground/80 hover:bg-muted/40 hover:border-border/40",
                isResponding && "opacity-50 cursor-not-allowed",
              )}
            >
              {shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-4.5 shrink-0 items-center justify-center rounded text-[10px] font-medium tabular-nums transition-colors duration-150",
                    isSelected
                      ? "bg-primary/20 text-primary-readable"
                      : "bg-muted/40 text-muted-foreground/70 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="min-w-0 flex-1 leading-snug">
                <span className="text-[13px] font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-xs text-muted-foreground/70">
                    {option.description}
                  </span>
                ) : null}
              </div>
              {isSelected ? (
                <CheckIcon className="size-3.5 shrink-0 text-primary-readable" />
              ) : null}
            </button>
          );
        })}
      </div>
      <textarea
        aria-label="Custom answer"
        placeholder="Or write your own answer..."
        value={progress.customAnswer}
        onChange={(event) => onCustomAnswerChange(activeQuestion.id, event.target.value)}
        disabled={isResponding}
        rows={2}
        className="mt-2 block max-h-32 min-h-14 w-full resize-y rounded-md border border-border/65 bg-background/55 px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-ring"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        {questionIndex > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onPrevious}
            disabled={isResponding}
          >
            Previous
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={onAdvance}
          disabled={
            isUnavailable ||
            isResponding ||
            (progress.isLastQuestion ? !progress.isComplete : !progress.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact: false,
            isLastQuestion: progress.isLastQuestion,
            isResponding,
            questionIndex,
          })}
        </Button>
      </div>
    </div>
  );
});
