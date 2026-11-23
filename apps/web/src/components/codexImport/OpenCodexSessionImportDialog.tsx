"use client";

import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  type ProviderExternalThreadCandidate,
  type ProviderInstanceId,
} from "@threadlines/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { useCallback, useDeferredValue, useMemo, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  requireEnvironmentConnection,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useSettings } from "../../hooks/useSettings";
import { resolveDialogReturnFocus } from "../../lib/dialogReturnFocus";
import { cn, newThreadId } from "../../lib/utils";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { useServerKeybindings, useServerProviders } from "../../rpc/serverState";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  filterCommandPaletteGroups,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import {
  Command,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import { failureNotice, stackedThreadToast, toastManager } from "../ui/toast";
import {
  finishCodexImport,
  useCodexImportStore,
  type CodexImportSession,
} from "./codexImportStore";

const EXTERNAL_SESSION_SEARCH_DEBOUNCE_MS = 180;

function externalSessionSourceLabel(source: ProviderExternalThreadCandidate["source"]): string {
  switch (source) {
    case "cli":
      return "Codex CLI";
    case "vscode":
      return "Codex app / IDE";
    case "exec":
      return "Codex exec";
    case "appServer":
      return "Codex app";
    case "unknown":
      return "Codex";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

function candidateTitle(candidate: ProviderExternalThreadCandidate): string {
  return (
    candidate.name?.trim() ||
    candidate.preview.trim().split(/\r?\n/, 1)[0] ||
    "Untitled Codex session"
  );
}

/** Says a conversation came in after the dialog that started it went away, with a button that opens it. */
function announceConversationBroughtIn(title: string, openThread: () => Promise<void>): void {
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: `Brought in ${title}`,
      actionProps: {
        children: "Open",
        onClick: () => {
          void openThread();
        },
      },
      actionVariant: "outline",
    }),
  );
}

/**
 * The open "Bring in Codex conversation" dialog: pick a Codex account when
 * there is more than one, then a conversation from the project's folder to
 * continue here. Loaded on demand by CodexSessionImportDialog; mounted once
 * per session.
 */
export function OpenCodexSessionImportDialog({ session }: { session: CodexImportSession }) {
  const navigate = useNavigate();
  const keybindings = useServerKeybindings();
  const settings = useSettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerProviders = useServerProviders();
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const { project } = session;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  // One account goes straight to its conversations; more show a picker first.
  const [providerInstanceId, setProviderInstanceId] = useState<ProviderInstanceId | null>(
    session.accounts.length === 1 ? session.accounts[0]!.instanceId : null,
  );
  const [importingProviderThreadId, setImportingProviderThreadId] = useState<string | null>(null);
  const canGoBack = providerInstanceId !== null && session.accounts.length > 1;
  const closeDialog = useCallback(() => {
    useCodexImportStore.getState().closeSession(session.id);
  }, [session.id]);

  // The project's computer's agents and settings pick the model a brought-in
  // conversation continues on.
  const environmentProviders = useMemo(
    () =>
      project.environmentId === primaryEnvironmentId
        ? primaryServerProviders
        : (savedEnvironmentRuntimeById[project.environmentId]?.serverConfig?.providers ?? []),
    [
      primaryEnvironmentId,
      primaryServerProviders,
      project.environmentId,
      savedEnvironmentRuntimeById,
    ],
  );
  const environmentSettings = useMemo(() => {
    const environmentServerSettings =
      project.environmentId !== primaryEnvironmentId
        ? savedEnvironmentRuntimeById[project.environmentId]?.serverConfig?.settings
        : null;
    return environmentServerSettings ? { ...settings, ...environmentServerSettings } : settings;
  }, [primaryEnvironmentId, project.environmentId, savedEnvironmentRuntimeById, settings]);

  const [externalSessionSearchQuery] = useDebouncedValue(
    providerInstanceId ? deferredQuery : "",
    { wait: EXTERNAL_SESSION_SEARCH_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const externalSessionsQuery = useInfiniteQuery({
    queryKey: [
      "externalCodexSessions",
      project.environmentId,
      providerInstanceId,
      project.cwd,
      externalSessionSearchQuery.trim(),
    ],
    queryFn: async ({ pageParam }) => {
      if (!providerInstanceId) {
        return { data: [] };
      }
      return requireEnvironmentConnection(
        project.environmentId,
      ).client.server.listExternalProviderThreads({
        providerInstanceId,
        cwd: project.cwd,
        limit: 20,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        ...(externalSessionSearchQuery.trim().length > 0
          ? { searchTerm: externalSessionSearchQuery.trim() }
          : {}),
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: providerInstanceId !== null,
  });

  const importExternalCodexSession = useCallback(
    async (candidate: ProviderExternalThreadCandidate): Promise<void> => {
      if (!providerInstanceId || importingProviderThreadId !== null) {
        return;
      }
      const model = resolveAppModelSelectionForInstance(
        providerInstanceId,
        environmentSettings,
        environmentProviders,
        null,
      );
      if (!model) {
        throw new Error("No usable model is available for this Codex account.");
      }

      setImportingProviderThreadId(candidate.providerThreadId);
      try {
        const connection = requireEnvironmentConnection(project.environmentId);
        const result = await connection.client.server.importExternalProviderThread({
          providerInstanceId,
          providerThreadId: candidate.providerThreadId,
          projectId: project.projectId,
          threadId: newThreadId(),
          modelSelection: {
            instanceId: providerInstanceId,
            model,
          },
          runtimeMode: session.runtimeMode,
        });
        const threadRef = scopeThreadRef(project.environmentId, result.threadId);
        await finishCodexImport({
          sessionId: session.id,
          threadRef,
          openThread: async () => {
            await navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            });
          },
          announce: (open) => announceConversationBroughtIn(candidateTitle(candidate), open),
        });
      } finally {
        setImportingProviderThreadId(null);
      }
    },
    [
      environmentProviders,
      environmentSettings,
      importingProviderThreadId,
      navigate,
      project.environmentId,
      project.projectId,
      providerInstanceId,
      session.id,
      session.runtimeMode,
    ],
  );

  const accountGroups = useMemo<ReadonlyArray<CommandPaletteGroup>>(
    () => [
      {
        value: "codex-accounts",
        label: "Codex accounts",
        items: session.accounts.map((account) => ({
          kind: "action" as const,
          value: `external-codex-account:${account.instanceId}`,
          searchTerms: [account.displayName, account.instanceId, "codex", "account"],
          title: account.displayName,
          description: "Sessions stored by this Codex account",
          icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            setHighlightedItemValue(null);
            setQuery("");
            setProviderInstanceId(account.instanceId);
          },
        })),
      },
    ],
    [session.accounts],
  );

  const externalCodexSessionGroups = useMemo<ReadonlyArray<CommandPaletteGroup>>(() => {
    if (!providerInstanceId) {
      return [];
    }
    const candidates = externalSessionsQuery.data?.pages.flatMap((page) => page.data) ?? [];
    const items: CommandPaletteActionItem[] = candidates.map((candidate) => {
      const title = candidateTitle(candidate);
      const source = externalSessionSourceLabel(candidate.source);
      const isImporting = importingProviderThreadId === candidate.providerThreadId;
      return {
        kind: "action",
        value: `external-codex-session:${candidate.providerThreadId}`,
        searchTerms: [title, candidate.preview, source, candidate.cliVersion],
        title,
        description: candidate.unavailableReason ?? `${source} · ${candidate.preview}`,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        timestampAt: candidate.updatedAt,
        disabled: !candidate.canImport || importingProviderThreadId !== null,
        ...(isImporting
          ? {
              titleTrailingContent: (
                <span className="ml-auto text-[10px] text-muted-foreground">Importing…</span>
              ),
            }
          : {}),
        keepOpen: true,
        run: async () => {
          await importExternalCodexSession(candidate);
        },
      };
    });

    if (externalSessionsQuery.hasNextPage) {
      items.push({
        kind: "action",
        value: "external-codex-session:load-more",
        searchTerms: ["load more", "older", "sessions"],
        title: externalSessionsQuery.isFetchingNextPage ? "Loading more…" : "Load more sessions",
        description: "Fetch the next 20 conversations",
        icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
        disabled: externalSessionsQuery.isFetchingNextPage || importingProviderThreadId !== null,
        keepOpen: true,
        run: async () => {
          await externalSessionsQuery.fetchNextPage();
        },
      });
    }

    return items.length > 0
      ? [
          {
            value: "external-codex-sessions",
            label: `Other Codex conversations in ${project.projectName}`,
            items,
          },
        ]
      : [];
  }, [
    providerInstanceId,
    externalSessionsQuery.data?.pages,
    externalSessionsQuery.fetchNextPage,
    externalSessionsQuery.hasNextPage,
    externalSessionsQuery.isFetchingNextPage,
    importExternalCodexSession,
    importingProviderThreadId,
    project.projectName,
  ]);

  const filteredAccountGroups = useMemo(
    () =>
      filterCommandPaletteGroups({
        activeGroups: accountGroups,
        query: deferredQuery,
        isInSubmenu: true,
        projectSearchItems: [],
        threadSearchItems: [],
      }),
    [accountGroups, deferredQuery],
  );

  function goBack(): void {
    if (!canGoBack) return;
    setHighlightedItemValue(null);
    setQuery("");
    setProviderInstanceId(null);
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled || item.kind !== "action") {
      return;
    }
    void item.run().catch((error: unknown) => {
      toastManager.add(
        failureNotice({
          title: "Couldn't run the command",
          error,
        }),
      );
    });
  }

  return (
    <CommandDialogPopup
      aria-label="Bring in Codex conversation"
      className="overflow-hidden p-0"
      data-testid="codex-import-dialog"
      finalFocus={() => resolveDialogReturnFocus(session.returnFocus)}
      onBackdropPointerDown={closeDialog}
    >
      <Command
        key={providerInstanceId ?? "no-codex-account"}
        aria-label="Bring in Codex conversation"
        autoHighlight="always"
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={(nextQuery) => {
          setHighlightedItemValue(null);
          setQuery(nextQuery);
        }}
        value={query}
      >
        <CommandInput
          placeholder={
            providerInstanceId
              ? `Search other Codex conversations in ${project.projectName}...`
              : "Choose a Codex account..."
          }
          wrapperClassName={
            canGoBack ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto" : undefined
          }
          startAddon={
            canGoBack ? (
              <button
                type="button"
                className="flex cursor-pointer items-center"
                aria-label="Back"
                onClick={goBack}
              >
                <ArrowLeftIcon />
              </button>
            ) : (
              <MessagesSquareIcon />
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Backspace" && query === "" && canGoBack) {
              event.preventDefault();
              goBack();
            }
          }}
        />
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          <CommandPaletteResults
            groups={providerInstanceId ? externalCodexSessionGroups : filteredAccountGroups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            isLoading={providerInstanceId !== null && externalSessionsQuery.isPending}
            keybindings={keybindings}
            query={deferredQuery}
            onExecuteItem={executeItem}
            emptyStateMessage={
              !providerInstanceId
                ? "No matching Codex accounts."
                : externalSessionsQuery.isPending
                  ? "Loading other Codex conversations…"
                  : externalSessionsQuery.isError
                    ? `Could not load Codex conversations: ${errorMessage(externalSessionsQuery.error)}`
                    : deferredQuery.trim().length > 0
                      ? "No matching external Codex conversations in this project."
                      : "No other Codex conversations were found. Conversations already in Threadlines are hidden."
            }
          />
        </CommandPanel>
        <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span className={cn("text-muted-foreground/80")}>Navigate</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Enter</Kbd>
              <span className={cn("text-muted-foreground/80")}>Select</span>
            </KbdGroup>
            {canGoBack ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Backspace</Kbd>
                <span className={cn("text-muted-foreground/80")}>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className={cn("text-muted-foreground/80")}>Close</span>
            </KbdGroup>
          </div>
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
