/**
 * The one field style (DESIGN.md, Inputs): 5 percent white fill, 40 percent
 * white hairline, control radius, gold focus ring. Input, Select and Textarea
 * all read it, so a screen never styles its own field.
 */
export const FIELD_BASE =
  "w-full rounded-lg border border-white/40 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/60 [color-scheme:dark] " +
  "focus:outline-none focus:ring-2 focus:ring-gold focus:border-gold " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const FIELD_ERROR = "border-red-500 focus:ring-red-500";

export const FIELD_LABEL = "text-sm font-medium text-white/80";

export const FIELD_ERROR_TEXT = "text-xs text-red-400";
