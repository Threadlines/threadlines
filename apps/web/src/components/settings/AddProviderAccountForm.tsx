/**
 * "Add another account", inline in an agent's opened row: a name, a color for
 * the badge, and one line about what the account keeps to itself. The server
 * creates the account and its private folder (the browser may be on another
 * machine); the row it appears in then takes over with sign-in.
 *
 * @module AddProviderAccountForm
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@threadlines/contracts";
import { providerAccountFolderField } from "@threadlines/shared/providerAccounts";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { PROVIDER_ACCENT_SWATCHES } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { accountFormCopy, suggestAccountColor, suggestAccountName } from "./providerAccounts.logic";

export function AddProviderAccountForm(props: {
  readonly driverKind: ProviderDriverKind;
  /** The agent's own name, e.g. "Claude". */
  readonly agentName: string;
  /** Names and colors the agent's other accounts already use. */
  readonly existingNames: ReadonlyArray<string>;
  readonly existingColors: ReadonlyArray<string | undefined>;
  readonly onCancel: () => void;
  /** `startSignIn`: the new row should go straight on to signing in. */
  readonly onAdded: (instanceId: ProviderInstanceId, startSignIn: boolean) => void;
}) {
  const formId = useId();
  const copy = accountFormCopy(String(props.driverKind), props.agentName);
  const [name, setName] = useState(() => suggestAccountName(props.existingNames));
  const [color, setColor] = useState(() => suggestAccountColor(props.existingColors));
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderAllowed = providerAccountFolderField(String(props.driverKind)) !== null;
  const trimmedName = name.trim();
  const trimmedFolder = folder.trim();
  const canSubmit = !saving && trimmedName.length > 0 && (!choosingFolder || trimmedFolder !== "");

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const { instanceId } = await ensureLocalApi().server.addProviderAccount({
        driver: props.driverKind,
        displayName: trimmedName,
        accentColor: color,
        ...(choosingFolder ? { folder: trimmedFolder } : {}),
      });
      props.onAdded(instanceId, copy.startsSignIn);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The account could not be added.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="border-t border-border/60 px-4 py-3 sm:px-5"
      data-testid="add-provider-account-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="text-xs font-medium text-foreground">New {props.agentName} account</div>
      <div className="mt-2.5 grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
        <label htmlFor={`${formId}-name`} className="text-xs text-muted-foreground">
          Name
        </label>
        <Input
          id={`${formId}-name`}
          size="sm"
          className="max-w-64"
          value={name}
          maxLength={64}
          spellCheck={false}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">Color</span>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Badge color">
          {PROVIDER_ACCENT_SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={swatch === color}
              aria-label={`Use ${swatch}`}
              className={cn(
                "size-4.5 cursor-pointer rounded-full border border-black/10 dark:border-white/20",
                swatch === color && "ring-2 ring-ring ring-offset-1 ring-offset-background",
              )}
              style={{ backgroundColor: swatch }}
              onClick={() => setColor(swatch)}
            />
          ))}
          <span className="ml-2" aria-hidden>
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={trimmedName || "?"}
              accentColor={color}
              showBadge
              className="size-5"
              iconClassName="size-4 text-foreground/80"
              badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
            />
          </span>
        </div>
        {choosingFolder ? (
          <>
            <label htmlFor={`${formId}-folder`} className="text-xs text-muted-foreground">
              Folder
            </label>
            <Input
              id={`${formId}-folder`}
              size="sm"
              className="font-mono text-xs"
              value={folder}
              placeholder="~/claude-work"
              spellCheck={false}
              onChange={(event) => setFolder(event.target.value)}
            />
          </>
        ) : null}
      </div>
      <p className="mt-2.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
        {choosingFolder
          ? "A folder on the computer the agents run on. Threadlines creates it if it's missing, and never deletes it."
          : copy.note}
        {folderAllowed && !choosingFolder ? (
          <>
            {" "}
            <button
              type="button"
              className="cursor-pointer text-foreground hover:text-primary-readable"
              onClick={() => setChoosingFolder(true)}
            >
              Use a folder I choose
            </button>
          </>
        ) : null}
      </p>
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!canSubmit}>
          {saving ? "Adding…" : copy.submitLabel}
        </Button>
      </div>
    </form>
  );
}
