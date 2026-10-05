/**
 * F10 — "Other vouchers": every voucher type with its hotkey; type to filter, Enter to open.
 * Types the company can't use right now are listed with the reason (and can't be opened).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PREDEFINED_VOUCHER_TYPES } from '../../shared/constants.ts';
import type { PredefinedVoucherType } from '../../shared/constants.ts';
import { Icon, Kbd, Modal, filterAndRank, useListNavigation } from '../ui/index.ts';
import { cx } from '../ui/lib/cx.ts';
import { useShell } from './shell.tsx';

export function VoucherPicker({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const types = useMemo(() => filterAndRank(PREDEFINED_VOUCHER_TYPES, query, (t) => ({ label: t.name, alias: t.abbreviation, keywords: [t.baseType] })).map((r) => r.item), [query]);
  const isDisabled = (i: number) => !shell.voucherAvailability(types[i].baseType).ok;
  const nav = useListNavigation({ count: types.length, defaultActiveIndex: 0, isDisabled, homeEnd: false });
  const { activeIndex, setActiveIndex } = nav;

  useEffect(() => {
    const first = types.findIndex((t) => shell.voucherAvailability(t.baseType).ok);
    setActiveIndex(first);
  }, [types, shell, setActiveIndex]);

  const pick = (t: PredefinedVoucherType) => {
    if (!shell.voucherAvailability(t.baseType).ok) return;
    onClose();
    shell.openVoucher(t.baseType);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (nav.onKeyDown(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const t = types[activeIndex];
      if (t) pick(t);
    }
  };

  return (
    <Modal open onClose={onClose} title="Other Vouchers" description="Choose the type of voucher to enter." size="sm" flush initialFocusRef={inputRef}>
      <div className="bx-goto__search">
        <Icon name="search" size="md" className="bx-goto__search-icon" />
        <input
          ref={inputRef}
          className="bx-goto__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-label="Voucher type"
          placeholder="Type to filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
      </div>
      <div className="bx-goto__results bx-goto__results--short" id={listId} role="listbox" aria-label="Voucher types">
        {types.map((t, i) => {
          const a = shell.voucherAvailability(t.baseType);
          return (
            <div
              key={t.baseType}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              aria-disabled={!a.ok || undefined}
              className={cx('bx-goto__option', i === activeIndex && 'is-active', !a.ok && 'is-disabled')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(t)}
              onMouseMove={() => a.ok && setActiveIndex(i)}
              title={a.reason}
            >
              <span className="bx-goto__label">
                {t.name}
                {!a.ok && a.reason ? <span className="bx-goto__desc">{a.reason}</span> : null}
              </span>
              {t.hotkey && t.hotkey !== 'F10' ? <Kbd keys={t.hotkey} size="sm" tone="subtle" /> : null}
            </div>
          );
        })}
        {types.length === 0 ? <p className="bx-goto__empty">No voucher type matches “{query}”.</p> : null}
      </div>
    </Modal>
  );
}
