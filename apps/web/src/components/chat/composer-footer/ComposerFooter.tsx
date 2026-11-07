import { memo, type ComponentProps, type ReactNode, type Ref } from "react";
import type { ModelPickerSettings, ModelPickerTraitsTarget } from "../ModelPickerSettings";
import { AiProviderSettings } from "../AiProviderSettings";
import "./composer-footer.css";

type Settings = ComponentProps<typeof ModelPickerSettings>;

/**
 * The footer's only integration point. The composer owns behavior and passes
 * its existing controls as slots; this folder owns their layout and pickers.
 */
export const ComposerFooter = memo(function ComposerFooter({
  primaryActionsRef,
  ...props
}: {
  attachments: ReactNode;
  modelPicker: ReactNode;
  modelNotice: ReactNode;
  hasModelNotice: boolean;
  dictation: ReactNode;
  primaryActions: ReactNode;
  primaryActionsRef: Ref<HTMLDivElement>;
  compactPrimaryActions: boolean;
  traits: ModelPickerTraitsTarget | null;
  mode: Settings["mode"];
  access: Settings["access"];
}) {
  return (
    <div className="composer-footer-container">
      <div data-chat-composer-footer="true" className="composer-footer">
        <div
          data-chat-composer-actions="left"
          data-model-fallback-chip={props.hasModelNotice ? "true" : undefined}
          className="composer-footer-controls group/composer-left @container/composer-left"
        >
          <div className="composer-footer-section composer-footer-attachments">
            {props.attachments}
          </div>
          <AiProviderSettings
            compact
            traits={props.traits}
            mode={props.mode}
            access={props.access}
            modelPicker={props.modelPicker}
          />
          {props.modelNotice}
        </div>
        <div
          ref={primaryActionsRef}
          data-chat-composer-actions="right"
          data-chat-composer-primary-actions-compact={
            props.compactPrimaryActions ? "true" : "false"
          }
          className="composer-footer-actions"
        >
          <div className="composer-footer-voice">{props.dictation}</div>
          {props.primaryActions}
        </div>
      </div>
    </div>
  );
});
