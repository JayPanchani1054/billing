import { createContext, Fragment, useContext } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { cx } from './lib/cx.ts';

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  /** One quiet run of context words after the title (the period, "As on …", a plain-words subtitle). */
  subtitle?: ReactNode;
  /** Slot above the title (usually <Breadcrumbs>). */
  breadcrumbs?: ReactNode;
  /** Right-aligned actions after the command bar slot (Buttons, DropdownMenu). */
  actions?: ReactNode;
  /** State words after the subtitle in the context run ("Cancelled", "Optional"). */
  meta?: ReactNode;
  /** Accepted and ignored (2.1: no icon tile beside titles). */
  icon?: IconName;
  ref?: Ref<HTMLElement>;
}

/**
 * What the screen around a PageHeader tells it (2.1). Provided per screen by the app shell (`ScreenHost`,
 * app/nav.tsx); absent outside a full screen (dialogs, previews), where the header draws no back button,
 * no "Not saved" word and no command-bar slot.
 */
export interface TitleBarContextValue {
  /** The `‹` button, from stack depth 2: name "Back to …", tooltip = the path + Esc; click = Esc. */
  back: { label: string; tip: string; onBack: () => void } | null;
  /** The screen has unsaved changes: the context run ends with "Not saved". */
  dirty: boolean;
  /** Receives the `[data-actions-slot]` element the shell renders the command bar into. */
  slotRef: (el: HTMLElement | null) => void;
}

export const TitleBarContext = createContext<TitleBarContextValue | null>(null);

/** A part the context run shows (not empty / false / whitespace). */
function shown(part: ReactNode): boolean {
  if (part === null || part === undefined || part === false || part === true) return false;
  return typeof part !== 'string' || part.trim() !== '';
}

/**
 * The title row (2.1, SPEC-21 §1.2): `‹` back (stack depth ≥ 2), the h1, one quiet context run
 * (`subtitle` · `meta`, ellipsized first, then "Not saved" which never ellipsizes), then the empty `[data-actions-slot]` the shell
 * fills with the top screen's command bar, then any `actions` passed. One per screen; props unchanged
 * from 2.0 (`icon` is ignored).
 */
export function PageHeader({ title, subtitle, breadcrumbs, actions, meta, icon, className, ref, ...rest }: PageHeaderProps) {
  void icon;
  const bar = useContext(TitleBarContext);
  const parts: ReactNode[] = [subtitle, meta].filter(shown);
  return (
    <header ref={ref} className={cx('bx-page-header', className)} {...rest}>
      {breadcrumbs ? <div className="bx-page-header__crumbs">{breadcrumbs}</div> : null}
      <div className="bx-titlebar">
        {bar?.back ? (
          <button type="button" className="bx-titlebar__back" aria-label={bar.back.label} title={bar.back.tip} aria-keyshortcuts="Escape" onClick={bar.back.onBack}>
            <Icon name="chevron-left" size="sm" />
            {/* Shown only while Ctrl is held (html[data-keys]), like every button's key. */}
            <span className="bx-btn__kbd" aria-hidden="true">
              Esc
            </span>
          </button>
        ) : null}
        <h1 className="bx-titlebar__title">{title}</h1>
        <div className="bx-titlebar__context">
          {/* The words ellipsize; the state word after them never does (it is the one that matters). */}
          <span className="bx-titlebar__run">
            {parts.map((p, i) => (
              <Fragment key={i}>
                {i > 0 ? <span aria-hidden="true"> · </span> : null}
                {p}
              </Fragment>
            ))}
          </span>
          {bar?.dirty ? (
            <span className="bx-titlebar__state">
              {parts.length > 0 ? <span aria-hidden="true"> · </span> : null}
              Not saved
            </span>
          ) : null}
        </div>
        {bar ? <div className="bx-titlebar__actions" data-actions-slot="" ref={bar.slotRef} /> : null}
        {actions ? <div className="bx-titlebar__extra">{actions}</div> : null}
      </div>
    </header>
  );
}
