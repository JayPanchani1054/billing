import { NumberInput } from './NumberInput.tsx';
import type { NumberInputProps } from './NumberInput.tsx';

export interface QuantityInputProps extends Omit<NumberInputProps, 'suffix'> {
  /** Unit symbol shown after the value ('Nos', 'Kg', 'Box'). */
  unit?: string;
  /** Decimal places allowed by the unit (UQC). Default 0. */
  decimals?: number;
}

/** Quantity in the item's unit: right-aligned, unit suffix, decimals per unit, min 0 unless overridden. */
export function QuantityInput({ unit, decimals = 0, min = 0, ...rest }: QuantityInputProps) {
  return <NumberInput {...rest} decimals={decimals} min={min} suffix={unit ? <span className="bx-input__unit">{unit}</span> : undefined} />;
}
