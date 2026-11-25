import { registerCustomTheme, resolveThemes } from "@pierre/diffs";

import { attachPierreCodeThemeRegistry } from "./codeTheme";

attachPierreCodeThemeRegistry(registerCustomTheme, resolveThemes);
