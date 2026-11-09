import type { ProviderInteractionMode, RuntimeMode } from "@threadlines/contracts";
import { type ReactNode, useLayoutEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { interactionModeConfig } from "../../interactionModeOptions";
import { formatShortcutLabel } from "../../keybindings";
import { runtimeModeConfig, type RuntimeModeOption } from "../../runtimeModeOptions";
import { subscribeThemeFontsLoaded } from "../../theme/themeStore";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { DropdownChevron } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The chat's Build/Plan mode, where the agent has a Plan mode. */
export interface ComposerModeControl {
  readonly value: ProviderInteractionMode;
  readonly onChange: (mode: ProviderInteractionMode) => void;
}

/** The access level the next message runs at, as the agent it goes to offers it. */
export interface ComposerAccessControl {
  /** The level the chat runs at, which can differ from the one picked. */
  readonly value: RuntimeMode;
  readonly options: ReadonlyArray<RuntimeModeOption>;
  readonly onChange: (mode: RuntimeMode) => void;
  /** Plan turns don't edit; the level applies once the agent builds. */
  readonly planning: boolean;
}

export const ACCESS_WHILE_PLANNING_NOTE =
  "Plan turns don't edit files. This access level applies when you build.";

/** Shift+Tab in the prompt switches Build and Plan (ChatComposer's command keys). */
const SWITCH_MODE_SHORTCUT = {
  key: "tab",
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
  modKey: false,
} as const;

/** Marks the words these buttons set aside, and measure, when the row runs short. */
const WORD_ATTRIBUTE = "data-run-control-word";

/**
 * On the controls' wrapper, `data-words="aside"` sets their words aside: out
 * of the row's flow and unseen, but still laid out, so their width can be
 * measured to tell when they fit again. The button clips them.
 */
const WORD_CLASS_NAME =
  "group-data-[words=aside]/run-controls:pointer-events-none group-data-[words=aside]/run-controls:invisible group-data-[words=aside]/run-controls:absolute";

/** Plain until hover, like the model button beside them; the hover eases in. */
const TRIGGER_CLASS_NAME =
  "shrink-0 gap-1.5 overflow-hidden px-2 text-muted-foreground/70 transition-[color,background-color,border-color,box-shadow] duration-150 hover:text-foreground/80 [&_svg]:mx-0";

const px = (value: string) => Number.parseFloat(value) || 0;

/** The model button beside these controls, whose name and effort they never cut. */
const MODEL_BUTTON_SELECTOR = '[data-chat-provider-model-picker="true"]';

/** The row's items in flow, looking through `display: contents` wrappers. */
function flowItems(parent: Element): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    if (style.display === "contents") items.push(...flowItems(child));
    else if (
      style.display !== "none" &&
      style.position !== "absolute" &&
      style.position !== "fixed"
    )
      items.push(child);
  }
  return items;
}

/**
 * How much wider the row needs to be to draw these buttons' words with the
 * model button uncut (negative while it has room to spare). It counts the
 * model button's labels (its name, its effort) at their whole text, and a word
 * set aside at its width plus the gap it takes beside its icon, so it reads
 * the same whichever way the row is drawn. Other items count as drawn: a
 * fallback chip is capped on purpose and never grows into its whole text.
 */
function runControlWordsShortfall(row: HTMLElement): number {
  const style = getComputedStyle(row);
  const items = flowItems(row);
  let needed =
    px(style.paddingLeft) + px(style.paddingRight) + px(style.columnGap) * (items.length - 1);
  for (const item of items) {
    needed += item.getBoundingClientRect().width;
    if (item.matches(MODEL_BUTTON_SELECTOR)) {
      for (const label of item.querySelectorAll<HTMLElement>(".truncate")) {
        needed += Math.max(0, label.scrollWidth - label.clientWidth);
      }
    }
    for (const word of item.querySelectorAll<HTMLElement>(`[${WORD_ATTRIBUTE}]`)) {
      if (getComputedStyle(word).position !== "absolute") continue;
      needed += word.getBoundingClientRect().width + px(getComputedStyle(item).columnGap);
    }
  }
  return needed - row.clientWidth;
}

/**
 * Sets the words aside where the row is short of room for them, and brings
 * them back where it has room. The words show only while the row keeps a
 * pixel to spare: a full row means something is squeezed, however the
 * browser rounds a cut label's widths. They come back only with two pixels
 * to spare, so a row right at the edge doesn't flicker between the two.
 */
function fitWords(wrapper: HTMLElement): void {
  const row = wrapper.parentElement;
  if (!row) return;
  const shortfall = runControlWordsShortfall(row);
  const aside = wrapper.dataset.words === "aside";
  const next = aside ? shortfall > -2 : shortfall > -1;
  if (next !== aside) wrapper.dataset.words = next ? "aside" : "shown";
}

/**
 * Build/Plan and the access level, beside the model button on the composer's
 * row. They show their words while the row fits them with the model name and
 * effort uncut, and keep just their icons where it doesn't: a long model name
 * or access level turns them to icons sooner than a short one.
 */
export function ComposerRunControls(props: {
  mode: ComposerModeControl | null;
  access: ComposerAccessControl;
  /** Puts the cursor back in the prompt after an access pick. */
  focusComposer: () => void;
}) {
  const wrapperRef = useRef<HTMLSpanElement>(null);

  // Measured before paint whenever the row's width changes, anything on it
  // changes what it shows (the model, its effort, a room's agents, these
  // labels), or fonts finish loading, and set straight on the wrapper, so the
  // row is never drawn cut. Setting the words aside changes neither the row's
  // width nor its contents, so the measuring never sets itself off.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const row = wrapper?.parentElement;
    if (!wrapper || !row) return;
    const fit = () => fitWords(wrapper);
    fit();
    const resizes = new ResizeObserver(fit);
    resizes.observe(row);
    const changes = new MutationObserver(fit);
    changes.observe(row, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: ["class"],
    });
    const stopThemeFonts = subscribeThemeFontsLoaded(fit);
    document.fonts?.addEventListener("loadingdone", fit);
    return () => {
      resizes.disconnect();
      changes.disconnect();
      stopThemeFonts();
      document.fonts?.removeEventListener("loadingdone", fit);
    };
  }, []);

  return (
    <span
      ref={wrapperRef}
      className="group/run-controls contents"
      data-composer-run-controls="true"
    >
      {props.mode ? <ModeButton mode={props.mode} /> : null}
      <AccessMenu access={props.access} focusComposer={props.focusComposer} />
    </span>
  );
}

/** The access option a control shows: the one offered, else the level's own words. */
export function currentAccessOption(access: ComposerAccessControl): RuntimeModeOption {
  return (
    access.options.find((option) => option.mode === access.value) ?? {
      mode: access.value,
      ...runtimeModeConfig[access.value],
    }
  );
}

/**
 * One access level in a list: its icon and name, then what it lets the agent
 * do, or why this agent can't run at it. The name takes the row's own color,
 * so a menu's resting, picked and pointed-at rows keep their treatment.
 */
export function AccessOptionContent(props: { option: RuntimeModeOption }) {
  const Icon = props.option.icon;
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        {props.option.label}
      </span>
      <span className="text-muted-foreground text-xs leading-4">
        {props.option.disabled && props.option.disabledReason
          ? props.option.disabledReason
          : props.option.description}
      </span>
    </div>
  );
}

/** A button's word, drawn or set aside with the others. */
function Word(props: { className?: string; children: ReactNode }) {
  return (
    <span data-run-control-word="true" className={cn(props.className, WORD_CLASS_NAME)}>
      {props.children}
    </span>
  );
}

/**
 * Build or Plan: one click switches to the other mode and puts the cursor
 * back in the prompt. Plan shows in its color.
 */
function ModeButton(props: { mode: ComposerModeControl }) {
  const { mode } = props;
  const planning = mode.value === "plan";
  const current = interactionModeConfig[mode.value];
  const next: ProviderInteractionMode = planning ? "default" : "plan";
  const Icon = current.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Mode: ${current.label}`}
            data-chat-composer-mode={mode.value}
            className={cn(
              TRIGGER_CLASS_NAME,
              planning && "text-primary-readable hover:text-primary-readable",
            )}
            onClick={() => mode.onChange(next)}
          />
        }
      >
        <Icon aria-hidden="true" className="size-3.5" />
        <Word {...(planning ? { className: "font-medium" } : {})}>{current.label}</Word>
      </TooltipTrigger>
      <TooltipPopup side="top" className="flex items-center gap-2">
        Switch to {interactionModeConfig[next].label}
        <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px] pointer-coarse:hidden">
          {formatShortcutLabel(SWITCH_MODE_SHORTCUT)}
        </Kbd>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The access level, opening the list of levels the agent offers. Full access
 * shows in the warning color. A pick returns the cursor to the prompt;
 * closing without one returns focus to the button.
 */
function AccessMenu(props: { access: ComposerAccessControl; focusComposer: () => void }) {
  const { access } = props;
  const current = currentAccessOption(access);
  const fullAccess = access.value === "full-access";
  const picked = useRef(false);
  const Icon = current.icon;
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) picked.current = false;
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Access level: ${current.label}`}
                  data-chat-composer-access={access.value}
                  className={cn(
                    TRIGGER_CLASS_NAME,
                    fullAccess && "text-warning-foreground hover:text-warning-foreground",
                  )}
                />
              }
            />
          }
        >
          <Icon aria-hidden="true" className="size-3.5" />
          <Word>{current.label}</Word>
          <Word className="flex">
            <DropdownChevron solid={false} />
          </Word>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
          {access.planning ? ACCESS_WHILE_PLANNING_NOTE : current.description}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="start"
        side="top"
        className="min-w-64"
        finalFocus={() => {
          if (!picked.current) return true;
          props.focusComposer();
          return false;
        }}
      >
        <MenuRadioGroup value={access.value}>
          {access.options.map((option) => (
            <MenuRadioItem
              key={option.mode}
              value={option.mode}
              disabled={option.disabled === true}
              data-access-option={option.mode}
              className="py-2"
              // A click, not a value change: the level shown can differ from
              // the one picked, and picking the shown one pins it.
              onClick={() => {
                if (option.disabled === true) return;
                picked.current = true;
                access.onChange(option.mode);
              }}
            >
              <AccessOptionContent option={option} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
