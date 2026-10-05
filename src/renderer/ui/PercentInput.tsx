import { NumberInput } from './NumberInput.tsx';
import type { NumberInputProps } from './NumberInput.tsx';

export interface PercentInputProps extends Omit<NumberInputProps, 'suffix' | 'grouping'> {
  /** Default 2. */
  decimals?: number;
}

/** Percentage (18 means 18%). Defaults: 2 decimals, min 0, no grouping, '%' suffix. */
export function PercentInput({ decimals = 2, min = 0, ...rest }: PercentInputProps) {
  return <NumberInput {...rest} decimals={decimals} min={min} grouping={false} suffix="%" />;
}
