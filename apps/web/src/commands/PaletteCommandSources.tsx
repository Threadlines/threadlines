/**
 * The palette's own command sources: features whose commands need only stores
 * and navigation, so nothing registers them while the palette is closed. Each
 * hook lives in its feature's folder and sits in its own component here, so
 * one feature's state changing re-runs only that feature's rules.
 */
import { useFleetCommands } from "../components/fleet/fleetCommands";
import { useThemeCommands } from "../components/theme/ui/themeCommands";
import { useNavigationCommands } from "./navigationCommands";
import { useProjectCommands } from "./projectCommands";
import { useThreadCommands, useThreadInboxCommands } from "./threadCommands";

function NavigationCommands() {
  useNavigationCommands();
  return null;
}

function ProjectCommands() {
  useProjectCommands();
  return null;
}

function ThreadCommands() {
  useThreadCommands();
  return null;
}

function FleetCommands() {
  useFleetCommands();
  return null;
}

function ThemeCommands() {
  useThemeCommands();
  return null;
}

export function PaletteCommandSources() {
  return (
    <>
      <NavigationCommands />
      <ProjectCommands />
      <ThreadCommands />
      <FleetCommands />
      <ThemeCommands />
    </>
  );
}

/**
 * Wrap up, Reopen and the lead commands. Their rule reads the inbox, which
 * re-derives on every streamed token, so this source is mounted beside the
 * palette rather than inside it: the palette's own rows and its other sources
 * commit nothing while a reply streams.
 */
export function PaletteInboxCommandSource() {
  useThreadInboxCommands();
  return null;
}
