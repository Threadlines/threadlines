/**
 * "Open computer in Fleet…" for the palette: each computer's Fleet page, once
 * there is more than one to choose from. Its items are found from the main
 * search too, as "Open <name> in Fleet".
 */
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useCommandHandlers, type CommandListItem } from "../../commands/commandHandlers";
import { useAddProjectEnvironmentOptions } from "../addProject/addProjectComputers";

export function useFleetCommands(): void {
  const navigate = useNavigate();
  const computers = useAddProjectEnvironmentOptions();
  const items = useMemo<ReadonlyArray<CommandListItem>>(
    () =>
      computers.map((computer) => ({
        id: computer.environmentId,
        title: `Open ${computer.label} in Fleet`,
        // As the one row per computer the palette had: found by "fleet" and "unlink" too.
        keywords: ["fleet", "computer", "link", "unlink", computer.label],
        run: () =>
          navigate({
            to: "/fleet/$environmentId",
            params: { environmentId: computer.environmentId },
          }),
      })),
    [computers, navigate],
  );
  useCommandHandlers({
    "fleet.openComputer": computers.length > 1 && { items, placeholder: "Search computers..." },
  });
}
