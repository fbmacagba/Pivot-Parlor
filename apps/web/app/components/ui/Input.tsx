import { clsx } from "clsx";
import * as React from "react";
import { FIELD_BASE, FIELD_ERROR, FIELD_ERROR_TEXT, FIELD_LABEL } from "./fieldStyles";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  /** Names the field for assistive tech while showing no visible label. */
  hideLabel?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, label, error, id, hideLabel = false, ...props }, ref) => {
    // A generated id, so two fields with the same label on one page (a list
    // of rows, a dialog over a form) never share one.
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className={hideLabel ? "sr-only" : FIELD_LABEL}>
            {label}
          </label>
        )}
        <input
          id={inputId}
          type={type}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={clsx("flex h-10", FIELD_BASE, error && FIELD_ERROR, className)}
          {...props}
        />
        {error && (
          <p id={errorId} className={FIELD_ERROR_TEXT}>
            {error}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
