/**
 * DOM helpers shared by hooks and components: focusable queries, editable detection, Enter-advance
 * targets. Uses DOM globals only inside functions (safe to import from node tests).
 */

export const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

export function isHTMLElement(x: unknown): x is HTMLElement {
  return typeof HTMLElement !== 'undefined' && x instanceof HTMLElement;
}

/** Visible enough to receive focus (not display:none / hidden / inert). */
export function isVisible(el: HTMLElement): boolean {
  if (el.hidden || el.closest('[hidden],[inert]')) return false;
  return el.getClientRects().length > 0;
}

/** Tabbable descendants in DOM order (tabindex >= 0, enabled, visible). */
export function getTabbables(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR).forEach((el) => {
    if (el.tabIndex < 0) return;
    if ((el as HTMLButtonElement).disabled) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (!isVisible(el)) return;
    if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) {
      // Only the checked radio of a group (or the first one when none is checked) is tabbable.
      const form = el.form ?? container;
      const group = el.name ? form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`) : null;
      if (group && Array.from(group).some((r) => r.checked)) return;
      if (group && group[0] !== el) return;
    }
    out.push(el);
  });
  return out;
}

/** True for text-entry targets where plain keys must not trigger hotkeys. */
export function isEditableTarget(target: unknown): boolean {
  if (!isHTMLElement(target)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    const nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'];
    return !nonText.includes(target.type) && !target.readOnly && !target.disabled;
  }
  return target.getAttribute('role') === 'combobox' || target.getAttribute('role') === 'textbox';
}

/** Buttons/links whose own Enter activation must be preserved by Enter-advance. */
export function isActivatable(el: HTMLElement): boolean {
  if (el.getAttribute('role') === 'switch') return false;
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || el.tagName === 'SUMMARY') return true;
  if (el instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image', 'file'].includes(el.type)) return true;
  const role = el.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'option' || role === 'gridcell';
}

const ENTER_TARGET_SELECTOR = [
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="file"])',
  'select',
  'textarea',
  '[role="combobox"]',
  '[role="switch"]',
  '[contenteditable="true"]',
  '[data-enter-target]',
].join(',');

/**
 * Fields that Enter moves between inside an enter-scope: editable controls (not disabled/readonly,
 * not tabindex=-1, not marked data-enter-skip) plus anything marked data-enter-target (e.g. a Save button).
 */
export function getEnterTargets(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  container.querySelectorAll<HTMLElement>(ENTER_TARGET_SELECTOR).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (el.closest('[data-enter-skip]')) return;
    if (el.tabIndex < 0) return;
    if ((el as HTMLInputElement).disabled) return;
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly) return;
    if (el.getAttribute('aria-disabled') === 'true') return;
    if (!isVisible(el)) return;
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const scope = el.form ?? container;
      const group = el.name ? Array.from(scope.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)) : [el];
      const chosen = group.find((r) => r.checked) ?? group[0];
      if (chosen !== el) return;
    }
    out.push(el);
  });
  return out;
}

/** Select the text of a text-like input (Tally overwrite-on-entry behaviour). */
export function selectAllText(el: HTMLElement): void {
  if (el instanceof HTMLInputElement) {
    const selectable = ['text', 'search', 'tel', 'url', 'email', 'password', 'number', ''];
    if (selectable.includes(el.type)) {
      try {
        el.select();
      } catch {
        /* some types throw on select() */
      }
    }
  }
}

/** Focus without scrolling the page (overlays/tables manage their own scrolling). */
export function focusElement(el: HTMLElement | null | undefined, select = false): boolean {
  if (!el) return false;
  el.focus({ preventScroll: true });
  if (select) selectAllText(el);
  return document.activeElement === el;
}

/** Does `target` sit inside an overlay rendered after `base` (i.e. a nested popup of it)? */
export function isInNewerOverlay(target: Node, base: HTMLElement | null): boolean {
  if (!base) return false;
  const overlay = target instanceof Element ? target.closest('[data-bx-overlay]') : target.parentElement?.closest('[data-bx-overlay]');
  if (!overlay || overlay === base || overlay.contains(base) || base.contains(overlay)) return false;
  return (base.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** Read a px length custom property (e.g. '--row-h') from an element; NaN when absent. */
export function readPxVar(el: Element, name: string): number {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  return raw ? Number.parseFloat(raw) : Number.NaN;
}
