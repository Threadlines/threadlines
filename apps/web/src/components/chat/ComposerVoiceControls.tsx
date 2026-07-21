import type { ProviderRealtimeOutputModality } from "@threadlines/contracts";
import {
  MessageSquareTextIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  Volume2Icon,
} from "lucide-react";
import type { RealtimeVoiceState } from "../../realtimeVoiceState";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface ComposerVoiceControlsProps {
  readonly supported: boolean;
  readonly canStart: boolean;
  readonly disabledReason: string | null;
  readonly projectedActive: boolean;
  readonly state: RealtimeVoiceState;
  readonly onStart: () => void;
  readonly onToggleMute: () => void;
  readonly onStop: () => void;
  readonly onModalityChange: (modality: ProviderRealtimeOutputModality) => void;
}

export function ComposerVoiceControls(props: ComposerVoiceControlsProps) {
  if (!props.supported) {
    return null;
  }

  if (props.state.status === "starting") {
    return (
      <span
        role="status"
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-2 text-[11px] font-medium text-primary-readable sm:h-6"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        Starting voice…
      </span>
    );
  }

  if (props.state.status === "active" && props.projectedActive) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <span
          role="status"
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/8 px-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 sm:h-6"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
          Voice active
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(props.state.muted && "bg-muted text-foreground")}
          aria-label={props.state.muted ? "Unmute microphone" : "Mute microphone"}
          tooltip={props.state.muted ? "Unmute microphone" : "Mute microphone"}
          onClick={props.onToggleMute}
        >
          {props.state.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-destructive hover:text-destructive"
          aria-label="End voice mode"
          tooltip="End voice mode"
          onClick={props.onStop}
        >
          <PhoneOffIcon />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Select
        value={props.state.modality}
        onValueChange={(value) => props.onModalityChange(value as ProviderRealtimeOutputModality)}
      >
        <SelectTrigger
          variant="ghost"
          size="sm"
          className="max-w-32 px-2 text-muted-foreground"
          aria-label="Voice replies"
          title="Choose spoken or text replies when voice mode starts"
        >
          {props.state.modality === "audio" ? (
            <Volume2Icon className="size-3.5" />
          ) : (
            <MessageSquareTextIcon className="size-3.5" />
          )}
          <SelectValue>
            {props.state.modality === "audio" ? "Voice replies" : "Text replies"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} side="top">
          <SelectItem value="audio">
            <span className="inline-flex items-center gap-1.5">
              <Volume2Icon className="size-3.5 text-muted-foreground" />
              Voice replies
            </span>
          </SelectItem>
          <SelectItem value="text">
            <span className="inline-flex items-center gap-1.5">
              <MessageSquareTextIcon className="size-3.5 text-muted-foreground" />
              Text replies
            </span>
          </SelectItem>
        </SelectPopup>
      </Select>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={!props.canStart}
        aria-label="Start voice mode"
        tooltip={props.disabledReason ?? "Start voice mode"}
        onClick={props.onStart}
      >
        <MicIcon />
      </Button>
    </div>
  );
}
