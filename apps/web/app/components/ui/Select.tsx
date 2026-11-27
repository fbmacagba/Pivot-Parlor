import { clsx } from "clsx";
import * as React from "react";
import { FIELD_BASE, FIELD_ERROR, FIELD_ERROR_TEXT, FIELD_LABEL } from "./fieldStyles";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Always required: a select with no name is unusable with a screen reader. */
  label: string;
  /** Names the field for assistive tech while showing no visible label. */
  hideLabel?: boolean;
  error?: string;
}

/** A native select in the shared field style. Options are its children. */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, hideLabel = false, error, id, children, ...props }, ref) => {
    const generatedId = React.useId();
    const selectId = id ?? generatedId;
    const errorId = `${selectId}-error`;
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className={hideLabel ? "sr-only" : FIELD_LABEL}>
          {label}
        </label>
        <select
          id={selectId}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={clsx("tap-target h-10", FIELD_BASE, error && FIELD_ERROR, className)}
          {...props}
        >
          {children}
        </select>
        {error && (
          <p id={errorId} className={FIELD_ERROR_TEXT}>
            {error}
          </p>
        )}
      </div>
    );
  }
);
Select.displayName = "Select";

export { Select };
