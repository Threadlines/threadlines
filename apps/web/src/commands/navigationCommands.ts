/**
 * Going places and app-wide commands for the palette. Registered while the
 * palette is open (PaletteCommandSources); each rule says where the command
 * would act, the same place its button lives.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useAppHistory } from "../appHistory";
import { APP_VERSION } from "../branding";
import { requestGeneralChatsReveal } from "../components/chats/generalChatsPlacement";
import { useStartGeneralChat } from "../components/chats/useGeneralChats";
import { openComputerRenameDialog, useComputerNaming } from "../components/DeviceRenameDialog";
import { openMoveThreadsDialog } from "../components/MoveThreadsDialog";
import { openReportProblemDialog } from "../components/ReportProblemDialog";
import { openConnectComputerDialog } from "../components/settings/connections/JoinComputerDialog";
import { openWhatsNewDialog } from "../components/WhatsNewDialog";
import { useMoveThreadsOffered } from "../environments/links/threadMoves";
import {
  startAssistantCode,
  useOutsideAgentsSnapshot,
} from "../environments/outsideAgents/outsideAgents";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import { usePullRequestEnvironments } from "../lib/pullRequestsReactQuery";
import { useScheduledTaskEnvironments } from "../lib/scheduledTasksState";
import { selectSidebarListShown, useUiStateStore } from "../uiStateStore";
import { useCommandHandlers } from "./commandHandlers";

export function useNavigationCommands(): void {
  const navigate = useNavigate();
  const isHomeRoute = useLocation({ select: (location) => location.pathname === "/" });
  const onTerminalsPage = useLocation({
    select: (location) => location.pathname === "/terminals",
  });
  const generalChatsPlacement = useSettings((settings) => settings.generalChatsPlacement);
  const startGeneralChat = useStartGeneralChat();
  const isMobile = useIsMobile();
  const sidebarListOpen = useUiStateStore(selectSidebarListShown);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scheduledTaskEnvironments = useScheduledTaskEnvironments();
  const pullRequestEnvironments = usePullRequestEnvironments();
  // Heard from only for this computer's owner, where its server takes outside agents.
  const managesOutsideAgents = useOutsideAgentsSnapshot() !== null;
  const thisComputerNaming = useComputerNaming(primaryEnvironmentId);
  // Clearing this computer (Part 3c): several of its threads to a linked one.
  const moveThreadsOffered = useMoveThreadsOffered(primaryEnvironmentId, null);
  const history = useAppHistory();

  useCommandHandlers({
    "navigate.home": !isHomeRoute && { run: () => navigate({ to: "/" }) },
    "chat.newGeneral": startGeneralChat !== null && { run: () => startGeneralChat() },
    "navigate.generalChats": {
      run: async () => {
        // Where the chats are a section of Threads, the shell opens it there
        // without a stop at the old page's address.
        if (generalChatsPlacement === "threads") requestGeneralChatsReveal();
        else await navigate({ to: "/chats" });
      },
    },
    "navigate.terminals": !onTerminalsPage && { run: () => navigate({ to: "/terminals" }) },
    "navigate.fleet": { run: () => navigate({ to: "/fleet" }) },
    // Only where a connected computer runs scheduled tasks, like the rail's button.
    "navigate.scheduled": scheduledTaskEnvironments.length > 0 && {
      run: () => navigate({ to: "/scheduled" }),
    },
    "scheduled.new": scheduledTaskEnvironments.length > 0 && {
      run: () => navigate({ to: "/scheduled", search: { view: "new" } }),
    },
    "computer.rename": thisComputerNaming !== null && {
      description: `Now called ${thisComputerNaming.label}`,
      run: () => openComputerRenameDialog(thisComputerNaming),
    },
    "app.whatsNew": {
      description: `The notes for v${APP_VERSION}`,
      run: () => openWhatsNewDialog(),
    },
    "app.reportProblem": { run: () => openReportProblemDialog() },
    "computer.connect": { run: () => openConnectComputerDialog() },
    "outsideAgents.connect": managesOutsideAgents && {
      run: () => navigate({ to: "/settings/connections", search: { section: "agents" } }),
    },
    "assistants.connect": managesOutsideAgents && {
      run: async () => {
        // The Assistants group shows the code, or why there isn't one.
        void startAssistantCode();
        await navigate({ to: "/settings/connections", search: { section: "assistants" } });
      },
    },
    // The thread list beside the rail; a phone shows it as a sheet instead.
    "sidebar.toggle": !isMobile && {
      title: sidebarListOpen ? "Hide sidebar" : "Show sidebar",
      run: () => useUiStateStore.getState().toggleSidebarListShown(),
    },
    // Registered only where the rail's button is: a command that lands on
    // "unsupported" is worse than one the palette never offers.
    "navigate.pullRequests": pullRequestEnvironments.length > 0 && {
      run: () => navigate({ to: "/pull-requests", search: { state: "open" } }),
    },
    "threads.moveMany": moveThreadsOffered &&
      primaryEnvironmentId !== null && {
        run: () => openMoveThreadsDialog({ sourceEnvironmentId: primaryEnvironmentId }),
      },
    // As the title row's arrows: only when there is a page that way.
    "navigate.back": history.canGoBack && { run: history.back },
    "navigate.forward": history.canGoForward && { run: history.forward },
    "navigate.usage": { run: () => navigate({ to: "/usage" }) },
    "navigate.settings": { run: () => navigate({ to: "/settings" }) },
    "navigate.setup": { run: () => navigate({ to: "/setup" }) },
    "navigate.communityAgents": {
      run: () => navigate({ to: "/settings/providers", search: { section: "community" } }),
    },
    "navigate.skills": {
      run: () => navigate({ to: "/settings/plugins", search: { tab: "skills" } }),
    },
  });
}
