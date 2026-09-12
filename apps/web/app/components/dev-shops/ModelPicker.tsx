// Cascaded Provider -> vendor -> model -> effort picker. OpenRouter shows a
// vendor step; the direct providers (OpenAI API, Anthropic API) go straight to
// the model. Pass live models (from /api/ai/models) when available, else the
// static snapshot from staticPickerModels().
import type { ReactNode } from "react";
import { EFFORT_OPTIONS } from "./constants";
import {
  defaultModelForGroup,
  effortLevelsFor,
  groupByRoute,
  modelPriceLabel,
  type PickerModel,
} from "./modelPicker.helpers";

const SELECT_CLASS =
  "flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-white/80">{label}</label>
      {children}
    </div>
  );
}

export function ModelPicker({
  label,
  models,
  value,
  onChange,
  effort,
  onEffortChange,
  disabled = false,
}: {
  label: string;
  models: PickerModel[];
  value: string;
  onChange: (id: string) => void;
  /** Current effort ("" = model decides). Omit both effort props to hide the effort select (image models, chatbot). */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  disabled?: boolean;
}) {
  const routes = groupByRoute(models);
  const selected = models.find((m) => m.id === value);
  const routeId = selected?.provider ?? routes[0]?.id ?? "";
  const route = routes.find((r) => r.id === routeId);
  const showVendors = routeId === "openrouter" && (route?.vendors.length ?? 0) > 0;
  const vendorId = selected?.vendor ?? route?.vendors[0]?.id ?? "";
  const vendor = route?.vendors.find((v) => v.id === vendorId);
  const modelOptions = showVendors ? (vendor?.models ?? []) : (route?.models ?? []);
  const levels = effortLevelsFor(selected);
  const effortVisible = onEffortChange !== undefined && levels.length > 0;
  const effortOptions = EFFORT_OPTIONS.filter((o) => o.value === "" || levels.includes(o.value));

  function pick(next: PickerModel | undefined) {
    if (!next) return;
    onChange(next.id);
    onEffortChange?.("");
  }

  return (
    <div className="space-y-3">
      <Field label={`${label} provider`}>
        <select
          value={routeId}
          onChange={(e) => {
            const r = routes.find((g) => g.id === e.target.value);
            pick(r ? defaultModelForGroup(r) : undefined);
          }}
          disabled={disabled}
          className={SELECT_CLASS}
          data-testid="picker-provider"
        >
          {routes.map((r) => (
            <option key={r.id} value={r.id} className="bg-dark">
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      {showVendors && (
        <Field label={`${label} vendor`}>
          <select
            value={vendorId}
            onChange={(e) => {
              const v = route?.vendors.find((g) => g.id === e.target.value);
              pick(v ? defaultModelForGroup(v) : undefined);
            }}
            disabled={disabled}
            className={SELECT_CLASS}
            data-testid="picker-vendor"
          >
            {route?.vendors.map((v) => (
              <option key={v.id} value={v.id} className="bg-dark">
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={`${label} model`}>
        <select
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onEffortChange?.("");
          }}
          disabled={disabled}
          className={SELECT_CLASS}
          data-testid="picker-model"
        >
          {!selected && (
            <option value="" disabled className="bg-dark">
              Select a model
            </option>
          )}
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id} className="bg-dark">
              {m.name}
              {m.recommended ? " ★" : ""} · {modelPriceLabel(m)}
            </option>
          ))}
        </select>
      </Field>
      {effortVisible && (
        <Field label="Reasoning effort">
          <select
            value={effort ?? ""}
            onChange={(e) => onEffortChange?.(e.target.value)}
            disabled={disabled}
            className={SELECT_CLASS}
            data-testid="picker-effort"
          >
            {effortOptions.map((o) => (
              <option key={o.value} value={o.value} className="bg-dark">
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}
