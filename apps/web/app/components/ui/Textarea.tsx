import { clsx } from "clsx";
import * as React from "react";
import { FIELD_BASE, FIELD_ERROR, FIELD_ERROR_TEXT, FIELD_LABEL } from "./fieldStyles";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hideLabel?: boolean;
  error?: string;
}

/** A textarea in the shared field style. */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, hideLabel = false, error, id, rows = 3, ...props }, ref) => {
    const generatedId = React.useId();
    const areaId = id ?? generatedId;
    const errorId = `${areaId}-error`;
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={areaId} className={hideLabel ? "sr-only" : FIELD_LABEL}>
          {label}
        </label>
        <textarea
          id={areaId}
          ref={ref}
          rows={rows}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={clsx("resize-none", FIELD_BASE, error && FIELD_ERROR, className)}
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
Textarea.displayName = "Textarea";

export { Textarea };
