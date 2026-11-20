import { SmartphoneIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Spinner } from "../ui/spinner";

/** A device that is opening, connecting or failed: what it is, and one line on where it stands. */
export function DeviceLoadingView(props: {
  readonly name: string;
  readonly description?: string;
  readonly message: string;
  readonly error?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div
      role={props.error ? "alert" : "status"}
      className="flex size-full items-center justify-center bg-background px-4 py-6"
    >
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <SmartphoneIcon aria-hidden="true" className="size-5 text-muted-foreground" />
        <div className="space-y-0.5">
          <p className="text-[13.5px] font-medium text-foreground">{props.name}</p>
          {props.description ? (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          ) : null}
        </div>
        <p
          className={
            props.error
              ? "text-xs whitespace-pre-line text-destructive-foreground"
              : "flex items-center gap-1.5 text-xs text-muted-foreground"
          }
        >
          {props.error ? null : <Spinner className="size-3.5" />}
          {props.message}
        </p>
        {props.children}
      </div>
    </div>
  );
}
