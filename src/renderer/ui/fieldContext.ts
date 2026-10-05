import { createContext, useContext } from 'react';

export interface FieldContextValue {
  /** id for the control (the <label for>). */
  id: string;
  labelId: string;
  /** ids of hint/error text for aria-describedby. */
  describedBy?: string;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldControlInput {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  invalid?: boolean;
  required?: boolean;
  disabled?: boolean;
}

export interface FieldControlProps {
  id: string | undefined;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  required: boolean | undefined;
  disabled: boolean | undefined;
  invalid: boolean;
}

/** Merge a control's own props with the surrounding <Field> (id, describedby, invalid, required, disabled). */
export function useFieldControl(props: FieldControlInput): FieldControlProps {
  const field = useContext(FieldContext);
  const describedBy = [props['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined;
  const ariaInvalid = props['aria-invalid'];
  const invalid = props.invalid ?? (ariaInvalid === true || ariaInvalid === 'true' ? true : field?.invalid ?? false);
  return {
    id: props.id ?? field?.id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid ? true : undefined,
    required: props.required ?? (field?.required || undefined),
    disabled: props.disabled ?? (field?.disabled || undefined),
    invalid,
  };
}
