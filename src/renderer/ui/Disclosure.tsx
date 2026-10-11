import { useId } from 'react';
import type { ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import { Kbd } from './Kbd.tsx';
import { useControllableState } from './hooks/useControllableState.ts';
import { cx } from './lib/cx.ts';
import { toAriaKeyShortcut } from './lib/hotkeys.ts';

export interface DisclosureLineProps {
  /** Visible words of the line (default "More details"). */
  label?: ReactNode;
  /** The key that toggles it, printed as plain text ("Ctrl+I"). The screen registers the key itself. */
  shortcut?: string;
  /** What is inside, shown muted after the chevron while closed ("aliases, contact, credit limit …"). */
  summary?: ReactNode;
  /** Controlled open state. */
  open?: boolean;
  /** Uncontrolled initial state (default false). */
  defaultOpen?: boolean;
  /**
   * Auto-reveal (ui/lib/disclosure.ts `shouldReveal`): open regardless of `open`, so a field with a value
   * or an error is never hidden. The line still reports toggles through `onToggle`.
   */
  forceOpen?: boolean;
  /** Called with the requested state when the line is clicked (or toggled by the caller's key). */
  onToggle?: (open: boolean) => void;
  /** The region the line opens. Omit and pass `controls` when the region is rendered elsewhere. */
  children?: ReactNode;
  /** Id of a region rendered by the caller (used when there are no children). */
  controls?: string;
  className?: string;
  regionClassName?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * The 2.1 progressive-disclosure line (SPEC-21 D17/D23): one 13 px link-style row
 * "More details  Ctrl+I  ›  summary" — a button with aria-expanded/aria-controls — and the region it
 * opens (`hidden` while closed, so Tab and Enter skip the fields inside).
 */
export function DisclosureLine({
  label = 'More details',
  shortcut,
  summary,
  open,
  defaultOpen = false,
  forceOpen = false,
  onToggle,
  children,
  controls,
  className,
  regionClassName,
  buttonRef,
}: DisclosureLineProps) {
  const regionId = useId();
  const [state, setState] = useControllableState<boolean>({ value: open, defaultValue: defaultOpen, onChange: onToggle });
  const isOpen = forceOpen || state;
  const hasRegion = children !== undefined && children !== null && children !== false;
  let aria: string | undefined;
  try {
    aria = shortcut ? toAriaKeyShortcut(shortcut) : undefined;
  } catch {
    aria = undefined;
  }
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cx('bx-disclosure', className)}
        aria-expanded={isOpen}
        aria-controls={hasRegion ? regionId : controls}
        aria-keyshortcuts={aria}
        onClick={() => setState(!isOpen)}
      >
        <span>{label}</span>
        {shortcut ? <Kbd keys={shortcut} tone="subtle" aria-hidden="true" /> : null}
        <Icon name="chevron-right" size="sm" className="bx-disclosure__chevron" />
        {!isOpen && summary ? <span className="bx-disclosure__summary">{summary}</span> : null}
      </button>
      {hasRegion ? (
        <div id={regionId} className={regionClassName} hidden={!isOpen}>
          {children}
        </div>
      ) : null}
    </>
  );
}
