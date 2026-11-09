import { Switch } from "../../ui/switch";

/** "Include the prompt", with the prompt under it; nothing when the theme has none. */
export function ThemePromptSwitch({
  prompt,
  checked,
  onCheckedChange,
}: {
  readonly prompt: string | undefined;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  if (!prompt?.trim()) return null;
  return (
    <div className="grid gap-1.5">
      <label className="flex items-center justify-between gap-3 text-xs font-medium text-foreground">
        Include the prompt
        <Switch checked={checked} onCheckedChange={(next) => onCheckedChange(Boolean(next))} />
      </label>
      <p className="line-clamp-3 text-xs text-muted-foreground">{prompt}</p>
    </div>
  );
}
