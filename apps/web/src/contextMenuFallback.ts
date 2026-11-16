import type { ContextMenuItem } from "@threadlines/contracts";

function clampMenuPosition(menu: HTMLDivElement, preferredLeft: number, preferredTop: number) {
  const rect = menu.getBoundingClientRect();
  const left = Math.min(
    Math.max(4, preferredLeft),
    Math.max(4, window.innerWidth - rect.width - 4),
  );
  const top = Math.min(
    Math.max(4, preferredTop),
    Math.max(4, window.innerHeight - rect.height - 4),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Supports nested submenus and resolves with the clicked leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";

    const menuStack: HTMLDivElement[] = [];
    // A finger needs rows it can hit: a phone or tablet gets taller rows and
    // body-size text; a mouse keeps the compact menu.
    const coarse = window.matchMedia?.("(pointer: coarse)").matches === true;
    const itemSize = coarse ? "px-4 py-2.5 text-sm" : "px-3 py-1.5 text-[11px]";
    // A menu opened by holding a finger down sits under that finger, and
    // lifting it sends a click. On a touch screen an item answers only once
    // a press has started on the menu itself, or to a keyboard's Enter or
    // Space (a click with no press: `detail` 0).
    let pressedOnMenu = !coarse;
    // Focus goes into the menu, so a keyboard can reach its items, and back
    // to whatever opened it once it closes.
    const opener = document.activeElement as HTMLElement | null;
    // Each open menu's items that take a press, in order, for the arrow keys.
    const itemsByMenu = new Map<HTMLDivElement, HTMLButtonElement[]>();
    // An item that opens a submenu, and what that submenu lists.
    const childrenOf = new Map<HTMLButtonElement, readonly ContextMenuItem<T>[]>();

    const cleanup = (result: T | null) => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      for (const menu of menuStack) {
        menu.remove();
      }
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const focused = document.activeElement as HTMLButtonElement | null;
      // The open menu that has focus (an item of it, or itself); the top one if none.
      const focusedLevel = Math.max(
        0,
        menuStack.findIndex(
          (menu) =>
            (menu as unknown) === focused ||
            (focused !== null && (itemsByMenu.get(menu) ?? []).includes(focused)),
        ),
      );
      if (event.key === "Escape" || event.key === "ArrowLeft") {
        // In a submenu: back to the item that opened it. In the menu: Escape closes.
        if (focusedLevel > 0) {
          event.preventDefault();
          const parent = openedBy.get(focusedLevel) ?? null;
          closeMenusFromLevel(focusedLevel);
          parent?.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cleanup(null);
        }
        return;
      }
      if (event.key === "ArrowRight") {
        const children = focused === null ? undefined : childrenOf.get(focused);
        if (focused !== null && children) {
          event.preventDefault();
          openSubmenu(focused, children, focusedLevel + 1, { focusFirst: true });
        }
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      // Up and down walk the items of the menu that has focus (the top one).
      const menu = menuStack[focusedLevel];
      const items = menu ? (itemsByMenu.get(menu) ?? []) : [];
      if (items.length === 0) return;
      event.preventDefault();
      const at = focused === null ? -1 : items.indexOf(focused);
      const next =
        at === -1
          ? event.key === "ArrowDown"
            ? 0
            : items.length - 1
          : (at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items[next]?.focus({ preventScroll: true });
    };

    const closeMenusFromLevel = (level: number) => {
      while (menuStack.length > level) {
        menuStack.pop()?.remove();
      }
    };

    // The item, one level up, whose submenu is open at a level.
    const openedBy = new Map<number, HTMLButtonElement>();

    /** Opens `button`'s submenu beside it; opened from the keyboard, its first item takes focus. */
    const openSubmenu = (
      button: HTMLButtonElement,
      children: readonly ContextMenuItem<T>[],
      level: number,
      options: { readonly focusFirst: boolean },
    ) => {
      const rect = button.getBoundingClientRect();
      openMenu(children, rect.right + 4, rect.top, level);
      openedBy.set(level, button);
      const childMenu = menuStack[level];
      if (!childMenu) return;
      const childRect = childMenu.getBoundingClientRect();
      if (childRect.right > window.innerWidth) {
        clampMenuPosition(childMenu, rect.left - childRect.width - 4, rect.top);
      }
      if (options.focusFirst) itemsByMenu.get(childMenu)?.[0]?.focus({ preventScroll: true });
    };

    const openMenu = (
      entries: readonly ContextMenuItem<T>[],
      preferredLeft: number,
      preferredTop: number,
      level: number,
    ) => {
      closeMenusFromLevel(level);

      const menu = document.createElement("div");
      menu.className = `fixed z-[10000] ${coarse ? "min-w-[200px]" : "min-w-[160px]"} rounded-md border border-border bg-popover py-1 shadow-xl outline-none animate-in fade-in zoom-in-95`;
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);
      menu.tabIndex = -1;
      const focusable: HTMLButtonElement[] = [];
      itemsByMenu.set(menu, focusable);

      for (const item of entries) {
        // A new group gets a divider above it, never at the top of the menu.
        if (item.separatorBefore === true && menu.childElementCount > 0) {
          const divider = document.createElement("div");
          divider.className = "my-1 h-px bg-border";
          divider.setAttribute("role", "separator");
          menu.appendChild(divider);
        }
        const button = document.createElement("button");
        button.type = "button";
        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const isDisabled = item.disabled === true;
        button.disabled = isDisabled;
        button.className = isDisabled
          ? `flex w-full items-center gap-2 ${itemSize} text-left text-muted-foreground/60 cursor-not-allowed`
          : `flex w-full items-center gap-2 ${itemSize} text-left text-popover-foreground hover:bg-accent focus-visible:bg-accent outline-none cursor-default`;

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        button.appendChild(label);

        if (hasChildren) {
          const chevron = document.createElement("span");
          chevron.className = "shrink-0 text-muted-foreground/70";
          chevron.textContent = "›";
          button.appendChild(chevron);
        }

        if (!isDisabled) {
          focusable.push(button);
          if (hasChildren) {
            const children = item.children!;
            childrenOf.set(button, children);
            button.addEventListener("mouseenter", () => {
              openSubmenu(button, children, level + 1, { focusFirst: false });
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
              // Enter or Space (a click with no press) opens it from the keyboard.
              if (event.detail === 0) {
                openSubmenu(button, children, level + 1, { focusFirst: true });
              }
            });
          } else {
            button.addEventListener("mouseenter", () => {
              closeMenusFromLevel(level + 1);
            });
            button.addEventListener("click", (event) => {
              if (pressedOnMenu || event.detail === 0) cleanup(item.id);
            });
          }
        }

        menu.appendChild(button);
      }

      menu.addEventListener("mouseenter", () => {
        closeMenusFromLevel(level + 1);
      });
      menu.addEventListener("pointerdown", () => {
        pressedOnMenu = true;
      });

      document.body.appendChild(menu);
      menuStack[level] = menu;

      requestAnimationFrame(() => {
        clampMenuPosition(menu, preferredLeft, preferredTop);
      });
      // The menu itself takes focus, not an item: nothing looks picked under a
      // mouse, and the arrows or Tab go on to the items.
      if (level === 0) menu.focus({ preventScroll: true });
    };

    // A new press outside closes the menu. On a touch screen that is a
    // pointerdown: the finger that opened the menu sends mouse events only as
    // it lifts.
    overlay.addEventListener(coarse ? "pointerdown" : "mousedown", () => cleanup(null));
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);
    openMenu(items, position?.x ?? 0, position?.y ?? 0, 0);
  });
}
