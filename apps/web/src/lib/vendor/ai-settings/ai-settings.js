// Portable, controlled AI settings. The caller owns every value and side effect.
let nextId = 0;
const same = (left, right) => Object.is(left, right);

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ornament(document, option) {
  if (option.bars !== undefined) {
    const meter = element(document, 'span', 'ai-settings-bars');
    meter.setAttribute('aria-hidden', 'true');
    if (option.tone) meter.dataset.tone = option.tone;
    const count = Math.max(1, option.barCount ?? option.bars);
    for (let index = 0; index < count; index++) {
      const bar = element(document, 'i');
      bar.style.height = `${4 + (index / Math.max(1, count - 1)) * 12}px`;
      bar.dataset.active = String(index < option.bars);
      meter.append(bar);
    }
    return meter;
  }
  if (option.icon) {
    const glyph = element(document, 'span', 'ai-settings-icon');
    glyph.setAttribute('aria-hidden', 'true');
    // Inline SVG keeps the portable control independent of any icon framework.
    const paths = {
      mode: 'M3 4h14M3 10h10M3 16h14',
      build: 'm3 17 7-7m-1-7 2-2 6 6-2 2-2-2-2 2-4-4 2-2Z',
      plan: 'M7 4h10M7 10h10M7 16h10M2 4h1M2 10h1M2 16h1',
      access: 'M10 2 3 5v5c0 4 7 8 7 8s7-4 7-8V5Z M7 10l2 2 4-4',
      speed: 'm11 1-7 10h6l-1 8 7-11h-6Z',
      settings: 'M3 5h14M3 10h14M3 15h14 M7 3v4M13 8v4M7 13v4',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[option.icon] ?? paths.settings);
    svg.append(path);
    glyph.append(svg);
    return glyph;
  }
  return null;
}

/** Mount once, update with caller-owned descriptors, destroy on unmount. */
export function createAiSettings(host, initial) {
  const document = host.ownerDocument;
  const window = document.defaultView;
  const root = element(document, 'div', 'ai-settings');
  root.setAttribute('role', 'group');
  const model = element(document, 'div', 'ai-settings-model');
  root.append(model);
  host.append(root);
  const records = new Map();
  let config = initial, opened = null, destroyed = false, typeahead = '', typeaheadTimer;
  const observer = new window.MutationObserver(() => { if (opened && !host.isConnected) close(false); });

  let adaptiveActive = false, fitFrame = null, sizeObserver;
  const sizeTargets = new Set();

  // Try real labels in place before paint, then fold them in reverse priority
  // until the measured row fits. No viewport or character-count breakpoint.
  function fitLabels() {
    if (destroyed || !adaptiveActive || root.clientWidth === 0) return;
    const adaptive = config.controls.filter(control => control.iconOnly === 'auto')
      .map(control => records.get(control.id)).filter(record => record?.value);
    const show = (record, visible) => {
      record.value.hidden = !visible;
      record.button.dataset.presentation = visible ? 'label' : 'icon';
    };
    for (const record of adaptive) show(record, true);
    const style = window.getComputedStyle(root);
    const number = value => Number.parseFloat(value) || 0;
    const available = root.clientWidth - number(style.paddingLeft) - number(style.paddingRight);
    const fits = () => {
      const nodes = [model, ...config.controls.map(control => records.get(control.id)?.section)]
        .filter(node => node && !node.hidden && node.getClientRects().length);
      let required = Math.max(0, nodes.length - 1) * number(style.columnGap);
      for (const node of nodes) {
        const spacing = window.getComputedStyle(node);
        required += node.getBoundingClientRect().width + number(spacing.marginLeft) + number(spacing.marginRight);
        // A capped button must not make a clipped label look as if it fits.
        const value = node.querySelector('.ai-settings-value');
        if (value && !value.hidden) required += Math.max(0, value.scrollWidth - value.clientWidth);
      }
      return required <= available;
    };
    for (const record of adaptive.reverse()) {
      if (fits()) break;
      show(record, false);
    }
  }

  function scheduleFit() {
    if (destroyed || !adaptiveActive || fitFrame !== null) return;
    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = null;
      fitLabels();
      if (opened) position();
    });
  }

  function syncMeasurements() {
    const active = config.controls.some(control => control.iconOnly === 'auto');
    if (active !== adaptiveActive) {
      adaptiveActive = active;
      if (active) {
        window.addEventListener('resize', scheduleFit);
        document.fonts?.addEventListener('loadingdone', scheduleFit);
        document.fonts?.ready.then(scheduleFit);
      } else {
        window.removeEventListener('resize', scheduleFit);
        document.fonts?.removeEventListener('loadingdone', scheduleFit);
        if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
        fitFrame = null;
      }
    }
    if (active && !sizeObserver && typeof window.ResizeObserver === 'function') {
      sizeObserver = new window.ResizeObserver(scheduleFit);
    }
    const next = new Set(active ? [root, model, ...config.controls.flatMap(control => {
      const record = records.get(control.id);
      return record ? [record.section, ...(control.iconOnly === 'auto' && record.value ? [record.value] : [])] : [];
    })] : []);
    for (const node of sizeTargets) if (!next.has(node)) { sizeObserver?.unobserve(node); sizeTargets.delete(node); }
    for (const node of next) if (!sizeTargets.has(node)) { sizeObserver?.observe(node); sizeTargets.add(node); }
  }

  function close(restore = true) {
    if (!opened) return;
    const {menu, button} = opened;
    opened = null;
    if (typeof menu.hidePopover === 'function' && menu.matches(':popover-open')) menu.hidePopover();
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-controls');
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', pointerdown, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('scroll', position, true);
    window.visualViewport?.removeEventListener('resize', position);
    observer.disconnect();
    if (restore && button.isConnected) button.focus();
  }

  function position() {
    if (!opened) return;
    const {menu, button} = opened;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
    const above = rect.top - top - 8;
    const below = top + height - rect.bottom - 8;
    const up = config.placement === 'top' ? above >= 80 || above > below
      : config.placement === 'bottom' ? below < 80 && above > below : above > below;
    menu.style.maxHeight = `${Math.max(0, (up ? above : below) - 6)}px`;
    const size = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - size.width - 8))}px`;
    menu.style.top = `${up ? Math.max(top + 8, rect.top - size.height - 6) : rect.bottom + 6}px`;
    menu.dataset.side = up ? 'top' : 'bottom';
  }

  function focusable() {
    return opened ? [...opened.menu.querySelectorAll('[role="menuitemradio"]:not(:disabled)')] : [];
  }

  function renderMenu(focusValue) {
    if (!opened) return;
    const {menu, id} = opened;
    const control = config.controls.find(item => item.id === id);
    if (!control || control.disabled) { close(); return; }
    const wasFocused = menu.contains(document.activeElement);
    menu.replaceChildren();
    for (const option of control.options) {
      const row = element(document, 'button', 'ai-settings-option');
      row.type = 'button';
      row.tabIndex = -1;
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-label', option.label);
      row.setAttribute('aria-checked', String(same(control.value, option.value)));
      row.disabled = Boolean(option.disabled);
      if (option.tone) row.dataset.tone = option.tone;
      const icon = ornament(document, option);
      if (icon) row.append(icon);
      const text = element(document, 'span', 'ai-settings-option-copy');
      text.append(element(document, 'span', '', option.label));
      if (option.description) {
        const description = element(document, 'small', '', option.description);
        description.id = `ai-settings-description-${++nextId}`;
        row.setAttribute('aria-describedby', description.id);
        text.append(description);
      }
      row.append(text);
      const check = element(document, 'span', 'ai-settings-check', same(control.value, option.value) ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      row.append(check);
      row.addEventListener('click', () => {
        if (row.disabled) return;
        close();
        // Selecting the displayed effective value may explicitly pin an
        // inherited setting. Only the app can decide whether it is a no-op.
        // Save status and failures belong to the adapter. Keep rejected async
        // callbacks from becoming an unhandled browser error after it renders one.
        try { Promise.resolve(control.onChange(option.value)).catch(() => {}); }
        catch { /* The caller owns error reporting and controlled rollback. */ }
      });
      menu.append(row);
      if (focusValue !== undefined && same(focusValue, option.value) && wasFocused) row.focus();
    }
    if (wasFocused && !menu.contains(document.activeElement)) focusable()[0]?.focus();
    position();
  }

  function open(id, last = false) {
    if (opened?.id === id) { close(); return; }
    close(false);
    const record = records.get(id);
    const control = config.controls.find(item => item.id === id);
    if (!record || !control || control.disabled) return;
    const menu = element(document, 'div', 'ai-settings-menu');
    menu.id = `ai-settings-menu-${++nextId}`;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', control.label);
    menu.setAttribute('popover', 'manual');
    root.append(menu);
    opened = {id, menu, button:record.button};
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointerdown, true);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    observer.observe(document.documentElement, {childList: true, subtree: true});
    record.button.setAttribute('aria-controls', menu.id);
    record.button.setAttribute('aria-expanded', 'true');
    if (typeof menu.showPopover === 'function') menu.showPopover();
    else {
      // Older webviews lack the top layer. Copy the explicit theme variables
      // while moving the menu out of clipping containers.
      const style = window.getComputedStyle(root);
      for (const key of ['foreground','muted','border','background','menu-background','hover','checked','accent','low','medium','high','xhigh','max','ultra','font-size']) {
        menu.style.setProperty(`--ai-settings-${key}`, style.getPropertyValue(`--ai-settings-${key}`));
      }
      document.body.append(menu);
    }
    renderMenu();
    const rows = focusable();
    (last ? rows.at(-1) : rows.find(row => row.getAttribute('aria-checked') === 'true') ?? rows[0])?.focus();
    if (!rows.length) { menu.tabIndex = -1; menu.focus(); }
  }

  function keydown(event) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!opened.menu.contains(event.target)) return;
    const rows = focusable(), index = rows.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = rows[(index + 1) % rows.length];
    else if (event.key === 'ArrowUp') next = rows[(index - 1 + rows.length) % rows.length];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      typeahead += event.key.toLocaleLowerCase();
      window.clearTimeout(typeaheadTimer);
      typeaheadTimer = window.setTimeout(() => { typeahead = ''; }, 500);
      next = [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(row => row.textContent.trim().toLocaleLowerCase().startsWith(typeahead));
    } else return;
    event.preventDefault(); event.stopPropagation(); next?.focus();
  }
  function pointerdown(event) {
    if (opened && !opened.menu.contains(event.target) && !opened.button.contains(event.target)) close(false);
  }
  function update(next) {
    if (destroyed) return;
    const focusedValue = opened && config.controls.find(item => item.id === opened.id)?.options[
      [...opened.menu.children].indexOf(document.activeElement)
    ]?.value;
    let restoreRemovedFocus = false;
    config = next;
    root.setAttribute('aria-label', config.label ?? 'AI settings');
    root.dataset.aiSettings = 'true';
    root.dataset.layout = config.layout ?? 'wrap';
    if (config.modelSlot) {
      if (model.firstChild !== config.modelSlot) model.replaceChildren(config.modelSlot);
      model.hidden = false;
    } else { model.replaceChildren(); model.hidden = true; }
    for (const [id, record] of records) if (!config.controls.some(control => control.id === id)) {
      if (opened?.id === id) close(false);
      restoreRemovedFocus ||= record.section.contains(document.activeElement);
      record.section.remove(); records.delete(id);
    }
    let previous = model;
    for (const control of config.controls) {
      let record = records.get(control.id);
      if (!record) {
        const section = element(document, 'div', 'ai-settings-section');
        const button = element(document, 'button', 'ai-settings-trigger');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => open(control.id));
        button.addEventListener('keydown', event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); open(control.id, event.key === 'ArrowUp');
          }
        });
        section.append(button); record = {section, button}; records.set(control.id, record);
      }
      const selected = control.options.find(option => same(option.value, control.value));
      const current = {...selected, ...control};
      const {button, section} = record;
      button.disabled = Boolean(control.disabled);
      button.title = control.title ?? (control.iconOnly ? `${control.label}: ${selected?.label ?? String(control.value ?? '')}` : selected?.description ?? control.label);
      button.dataset.presentation = control.iconOnly === true ? 'icon' : 'label';
      button.setAttribute('aria-label', `${control.label}: ${selected?.label ?? String(control.value ?? '')}`);
      button.dataset.control = control.id;
      button.dataset.aiSetting = control.id;
      if (current.tone) button.dataset.tone = current.tone; else delete button.dataset.tone;
      button.replaceChildren();
      const icon = ornament(document, current);
      if (icon) button.append(icon);
      record.value = null;
      if (control.iconOnly !== true) {
        record.value = element(document, 'span', 'ai-settings-value', selected?.label ?? String(control.value ?? ''));
        button.append(record.value);
      }
      if (!control.iconOnly) {
        const chevron = element(document, 'span', 'ai-settings-chevron');
        chevron.setAttribute('aria-hidden', 'true'); button.append(chevron);
      }
      // Moving a focused node, even back into the same parent, can blur it.
      // Passive metadata updates leave the existing order and focus untouched.
      if (previous.nextSibling !== section) root.insertBefore(section, previous.nextSibling);
      previous = section;
    }
    syncMeasurements();
    fitLabels();
    if (restoreRemovedFocus) root.querySelector('button:not(:disabled)')?.focus();
    if (opened) renderMenu(focusedValue);
  }
  update(initial);
  return {update, destroy() {
    if (destroyed) return;
    close(false); destroyed = true;
    sizeObserver?.disconnect();
    sizeTargets.clear();
    if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
    window.removeEventListener('resize', scheduleFit);
    document.fonts?.removeEventListener('loadingdone', scheduleFit);
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', pointerdown, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('scroll', position, true);
    window.visualViewport?.removeEventListener('resize', position);
    window.clearTimeout(typeaheadTimer);
    observer.disconnect();
    root.remove();
  }};
}
