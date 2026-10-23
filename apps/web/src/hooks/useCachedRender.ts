import { useEffect, useEffectEvent, useState } from "react";

import type { LRUCache } from "../lib/lruCache";

/**
 * Something a reply draws through a library loaded on demand (a formula, a
 * diagram), drawn once per key and kept in `cache`: the timeline recycles rows
 * as it scrolls, and a row coming back shows its drawing at once instead of
 * its source. Null until the drawing lands, and while `key` is null.
 *
 * `drawNow` answers during render once the library is already loaded, so a
 * new formula doesn't flash its source for a frame; it must be pure.
 */
export function useCachedRender<T>(options: {
  readonly cache: LRUCache<T>;
  readonly key: string | null;
  readonly draw: () => Promise<T>;
  readonly drawNow?: () => T | null;
  readonly sizeOf: (value: T) => number;
}): T | null {
  const { cache, key } = options;
  const cached = key === null ? null : cache.get(key);
  const [landed, setLanded] = useState<{ key: string; value: T } | null>(null);
  const drawNow = key === null || cached !== null ? null : (options.drawNow?.() ?? null);
  const draw = useEffectEvent(options.draw);
  const sizeOf = useEffectEvent(options.sizeOf);

  useEffect(() => {
    if (key === null || cache.get(key) !== null) return;
    let cancelled = false;
    draw().then(
      (value) => {
        cache.set(key, value, sizeOf(value));
        if (!cancelled) setLanded({ key, value });
      },
      // The library failed to load (offline, a stale build): the source stays
      // on screen, and the next mount tries again.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [cache, key]);

  if (key === null) return null;
  return cached ?? drawNow ?? (landed?.key === key ? landed.value : null);
}
