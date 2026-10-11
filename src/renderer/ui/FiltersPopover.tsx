import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Popover } from './Popover.tsx';
import type { Placement } from './Popover.tsx';
import { activeCount, filtersLabel } from './lib/filters.ts';
import type { FilterState } from './lib/filters.ts';
import type { ControlSize } from './types.ts';

export interface FiltersPopoverProps {
  /** The filters inside, for the count on the button (ui/lib/filters.ts `activeCount`). */
  filters?: readonly FilterState[];
  /** A count the screen computed itself (wins over `filters`). */
  count?: number;
  /** The filter controls (their names and keys unchanged). */
  children: ReactNode;
  /** Optional "Clear filters" link at the bottom of the popover (shown while a filter is active; it closes the popover). */
  onClear?: () => void;
  size?: ControlSize;
  placement?: Placement;
  className?: string;
}

/**
 * One quiet "Filters ▾" button for a screen with more than one filter (2.1, SPEC-21 §1.2): the label
 * counts the active ones ("Filters (2)", accessible name "Filters, 2 active"); the popover holds the
 * controls. Esc or a click outside closes it and returns focus to the button.
 */
export function FiltersPopover({ filters, count, children, onClear, size = 'sm', placement = 'bottom-start', className }: FiltersPopoverProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const n = count ?? (filters ? activeCount(filters) : 0);
  const label = filtersLabel(n);
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size={size}
        iconRight="chevron-down"
        aria-label={label.name}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={className}
        onClick={() => setOpen((o) => !o)}
      >
        {label.text}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} placement={placement} aria-label="Filters" className="bx-filters">
        {children}
        {onClear && n > 0 ? (
          <Button
            variant="link"
            onClick={() => {
              // The link disappears with the last active filter: close and give focus back to the button.
              onClear();
              setOpen(false);
              anchorRef.current?.focus();
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </Popover>
    </>
  );
}
