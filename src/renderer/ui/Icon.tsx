import { useId } from 'react';
import type { Ref, SVGProps } from 'react';
import { ICONS } from './icons.ts';
import type { IconDef, IconName } from './icons.ts';
import { cx } from './lib/cx.ts';

export type { IconName } from './icons.ts';
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;

const SIZE_PX: Readonly<Record<Exclude<IconSize, number>, number>> = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 };

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'ref' | 'children' | 'size' | 'label'> {
  name: IconName;
  /** 'xs' 12 · 'sm' 14 · 'md' 16 (default) · 'lg' 20 · 'xl' 24, or px. */
  size?: IconSize;
  /** Accessible name. Omit for decorative icons (then aria-hidden). */
  label?: string;
  ref?: Ref<SVGSVGElement>;
}

/** Inline SVG icon — inherits `color`; decorative unless `label` is given. */
export function Icon({ name, size = 'md', label, className, strokeWidth = 1.75, ref, ...rest }: IconProps) {
  const def: IconDef = ICONS[name];
  const px = typeof size === 'number' ? size : SIZE_PX[size];
  const titleId = useId();
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      className={cx('bx-icon', className)}
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
      aria-labelledby={label ? titleId : undefined}
      data-icon={name}
      {...rest}
    >
      {label ? <title id={titleId}>{label}</title> : null}
      {def.d.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {def.fill?.map((d, i) => (
        <path key={`f${i}`} d={d} fill="currentColor" stroke="none" />
      ))}
    </svg>
  );
}
