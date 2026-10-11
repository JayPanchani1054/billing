/**
 * F10 — "Other vouchers": every voucher type — predefined ones with their hotkey, then the
 * company's own types (Masters › Voucher Types, e.g. "Sales - Export") under their base type.
 * Type to filter, Enter to open. Types the company can't use right now are listed with the reason
 * (and can't be opened); deactivated types are not listed (lib/voucherTypes.ts).
 * 2.1 (SPEC-21 D4): keys as plain text, as in Go To (whose styles it shares, styles/gateway.css).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon, Modal, filterAndRank, useListNavigation } from '../ui/index.ts';
import { cx } from '../ui/lib/cx.ts';
import { useVoucherChoices } from './hooks/useVoucherChoices.ts';
import type { VoucherChoice } from './lib/voucherTypes.ts';
import { useShell } from './shell.tsx';

export function VoucherPicker({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const all = useVoucherChoices();
  const types = useMemo(
    () => filterAndRank(all, query, (t) => ({ label: t.name, alias: t.abbreviation ?? t.alias, keywords: [t.baseType, t.baseName, t.alias ?? ''] })).map((r) => r.item),
    [all, query],
  );
  const isDisabled = (i: number) => !shell.voucherAvailability(types[i].baseType).ok;
  const nav = useListNavigation({ count: types.length, defaultActiveIndex: 0, isDisabled, homeEnd: false });
  const { activeIndex, setActiveIndex } = nav;

  useEffect(() => {
    const first = types.findIndex((t) => shell.voucherAvailability(t.baseType).ok);
    setActiveIndex(first);
  }, [types, shell, setActiveIndex]);

  const pick = (t: VoucherChoice) => {
    if (!shell.voucherAvailability(t.baseType).ok) return;
    onClose();
    shell.openVoucher(t.baseType, t.voucherTypeId !== undefined ? { voucherTypeId: t.voucherTypeId } : {});
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
    <Modal open onClose={onClose} title="Other Vouchers" size="sm" flush initialFocusRef={inputRef}>
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
          const detail = !a.ok && a.reason ? a.reason : t.custom ? `${t.baseName} voucher` : null;
          return (
            <div
              key={t.key}
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
                {detail ? <span className="bx-goto__desc">{detail}</span> : null}
              </span>
              {t.hotkey && t.hotkey !== 'F10' ? <span className="bx-goto__key">{t.hotkey}</span> : null}
            </div>
          );
        })}
        {types.length === 0 ? <p className="bx-goto__empty">No voucher type matches “{query}”.</p> : null}
      </div>
    </Modal>
  );
}
