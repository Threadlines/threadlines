/**
 * Whether the composer's /theme strip is open: the trial bar (always
 * mounted) hides while it is, so this stays tiny and loads at startup.
 */
import { create } from "zustand";

/** Whether the /theme strip is open: it handles its own keys and hides the bar. */
export const useThemePickerOpenStore = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));
