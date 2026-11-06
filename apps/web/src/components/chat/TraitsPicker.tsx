import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderModel,
} from "@threadlines/contracts";
import { memo, useEffect, useRef } from "react";
import { AiProviderSettings } from "./AiProviderSettings";
import type { ProviderOptions, TraitsPersistence } from "./traitControls";

export interface TraitsPickerProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  triggerClassName?: string;
  /** Options to leave out of the menu, such as Ultracode where it makes no sense. */
  omitOptionIds?: ReadonlyArray<string>;
}

/** Existing Settings and review callers share the same descriptor-driven control. */
export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  omitOptionIds,
  triggerClassName,
  ...persistence
}: TraitsPickerProps & TraitsPersistence) {
  return (
    <div className={triggerClassName} style={{ minWidth: 0, maxWidth: "100%", flexShrink: 1 }}>
      <AiProviderSettings
        traits={{
          provider,
          ...(instanceId ? { instanceId } : {}),
          models,
          model,
          modelOptions,
          ...(omitOptionIds ? { omitOptionIds } : {}),
          ...persistence,
        }}
        mode={null}
        access={null}
        placement="auto"
      />
    </div>
  );
});

const ULTRACODE_GLINT_INTERVAL_MS = 2000;
const ULTRACODE_GLINT_KEYFRAMES: Keyframe[] = [
  { transform: "translateX(-120%)", opacity: 0 },
  { opacity: 1, offset: 0.15 },
  { opacity: 1, offset: 0.85 },
  { transform: "translateX(120%)", opacity: 0 },
];
const ULTRACODE_GLINT_TIMING: KeyframeAnimationOptions = {
  duration: 900,
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
};

/**
 * Sends a band of light across the Ultracode trigger: once when Ultracode
 * turns on, then every 2s while Claude works. A timer starts each pass, so
 * the trigger is still between passes and nothing moves while Claude is
 * idle, the window is hidden, or the system asks for less motion.
 */
export function useUltracodeGlint(active: boolean, working: boolean) {
  const bandRef = useRef<HTMLSpanElement>(null);
  const wasActive = useRef(active);
  useEffect(() => {
    const turnedOn = active && !wasActive.current;
    wasActive.current = active;
    if (!active || (!turnedOn && !working)) {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let current: Animation | undefined;
    const pass = () => {
      if (document.hidden || reducedMotion.matches) return;
      current?.cancel();
      current = bandRef.current?.animate(ULTRACODE_GLINT_KEYFRAMES, ULTRACODE_GLINT_TIMING);
    };
    pass();
    const interval = working ? window.setInterval(pass, ULTRACODE_GLINT_INTERVAL_MS) : undefined;
    return () => {
      window.clearInterval(interval);
      current?.cancel();
    };
  }, [active, working]);
  return bandRef;
}
