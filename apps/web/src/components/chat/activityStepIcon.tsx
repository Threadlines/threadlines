import {
  AppWindowIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import type { ActivityIcon, ActivityStep } from "./activitySteps";

/** One glyph per kind of step, shared by every surface that draws steps so a
 *  read looks like a read wherever it shows up. */
const STEP_ICONS: Readonly<Record<ActivityIcon | "fail", (className: string) => ReactElement>> = {
  read: (className) => <EyeIcon className={className} aria-hidden="true" />,
  search: (className) => <SearchIcon className={className} aria-hidden="true" />,
  list: (className) => <FolderIcon className={className} aria-hidden="true" />,
  git: (className) => <GitBranchIcon className={className} aria-hidden="true" />,
  web: (className) => <GlobeIcon className={className} aria-hidden="true" />,
  browser: (className) => <AppWindowIcon className={className} aria-hidden="true" />,
  edit: (className) => <SquarePenIcon className={className} aria-hidden="true" />,
  check: (className) => <CheckIcon className={className} aria-hidden="true" />,
  fail: (className) => <XIcon className={className} aria-hidden="true" />,
  command: (className) => <TerminalIcon className={className} aria-hidden="true" />,
  tool: (className) => <WrenchIcon className={className} aria-hidden="true" />,
  image: (className) => <ImageIcon className={className} aria-hidden="true" />,
  agent: (className) => <BotIcon className={className} aria-hidden="true" />,
  question: (className) => <MessageCircleQuestionIcon className={className} aria-hidden="true" />,
  thinking: (className) => <LightbulbIcon className={className} aria-hidden="true" />,
  info: (className) => <InfoIcon className={className} aria-hidden="true" />,
  warning: (className) => <TriangleAlertIcon className={className} aria-hidden="true" />,
  error: (className) => <CircleAlertIcon className={className} aria-hidden="true" />,
};

/** A check shows its result: a tick when it passed, a cross when it failed. */
export function activityStepIcon(
  step: Pick<ActivityStep, "icon" | "tone">,
  className: string,
): ReactElement {
  return STEP_ICONS[step.icon === "check" && step.tone === "fail" ? "fail" : step.icon](className);
}
