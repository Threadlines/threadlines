export type AiSettingsValue = string | boolean | number | null;
export type AiSettingsIcon = 'mode' | 'build' | 'plan' | 'access' | 'speed' | 'settings';
export interface AiSettingsOption {
  value: AiSettingsValue;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
  bars?: number | undefined;
  barCount?: number | undefined;
  tone?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined;
  icon?: AiSettingsIcon | undefined;
}
export interface AiSettingsControl {
  /** True hides the value; auto shows it only when the measured row fits. Neither adds a chevron. */
  iconOnly?: boolean | 'auto' | undefined;
  id: string;
  label: string;
  value: AiSettingsValue;
  options: readonly AiSettingsOption[];
  disabled?: boolean | undefined;
  title?: string | undefined;
  bars?: number | undefined;
  barCount?: number | undefined;
  tone?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined;
  icon?: AiSettingsIcon | undefined;
  onChange(value: AiSettingsValue): unknown;
}
export interface AiSettingsConfig {
  label?: string | undefined;
  layout?: 'wrap' | 'inline' | undefined;
  placement?: 'top' | 'bottom' | 'auto' | undefined;
  modelSlot?: HTMLElement | undefined;
  controls: readonly AiSettingsControl[];
}
export interface AiSettingsHandle {
  update(config: AiSettingsConfig): void;
  destroy(): void;
}
export function createAiSettings(host: HTMLElement, config: AiSettingsConfig): AiSettingsHandle;
