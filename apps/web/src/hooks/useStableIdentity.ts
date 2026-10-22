import { useInsertionEffect, useMemo, useRef, useState } from "react";
import { shallow } from "zustand/vanilla/shallow";

/**
 * `value`, or the one kept from an earlier render while `same` says both hold
 * the same things, so a value an owner rebuilds on every update keeps one
 * identity for memoized children and context readers.
 */
export function useKept<T>(value: T, same: (kept: T, next: T) => boolean): T {
  const [kept, setKept] = useState(value);
  if (kept === value || same(kept, value)) {
    return kept;
  }
  setKept(value);
  return value;
}

/** Marks a field that holds a function in useStableHandlers' description. */
const HANDLER = Symbol("handler");

/**
 * `value` with each function in it swapped for a stand-in that keeps its
 * identity and always calls the newest function passed under that name. The
 * result keeps its identity while the other fields hold the same things (by
 * `Object.is`) and the same names hold functions; null and undefined pass
 * through. A component that hands callbacks to many memoized children,
 * through props or context, passes these on, so an owner that rebuilds its
 * callbacks on every update does not redraw every child. Call the stand-ins
 * from events and effects, not while rendering.
 */
export function useStableHandlers<T extends object | null | undefined>(value: T): T {
  const latest = useRef(value);
  // Before any layout effect, so a child that calls one as it mounts reaches
  // the function of the render it mounted in.
  useInsertionEffect(() => {
    latest.current = value;
  });
  const fields = useKept(
    value == null
      ? null
      : Object.fromEntries(
          Object.entries(value).map(([name, field]) => [
            name,
            typeof field === "function" ? HANDLER : (field as unknown),
          ]),
        ),
    (kept, next) => kept === next || (kept !== null && next !== null && shallow(kept, next)),
  );
  const stable = useMemo(
    () =>
      fields === null
        ? null
        : Object.fromEntries(
            Object.entries(fields).map(([name, field]) => [
              name,
              field === HANDLER
                ? (...args: unknown[]) => {
                    const handler = (
                      latest.current as Record<string, unknown> | null | undefined
                    )?.[name];
                    return typeof handler === "function"
                      ? (handler as (...handlerArgs: unknown[]) => unknown)(...args)
                      : undefined;
                  }
                : field,
            ]),
          ),
    [fields],
  );
  return (value == null ? value : stable) as T;
}
