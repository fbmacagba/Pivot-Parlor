// Cascaded Provider -> vendor -> model -> effort picker. OpenRouter shows a
// vendor step; the direct providers (OpenAI API, Anthropic API) go straight to
// the model. Pass live models (from /api/ai/models) when available, else the
// static snapshot from staticPickerModels().
import { useId } from "react";
import { Select } from "~/components/ui/Select";
import { defaultEffortLabel, EFFORT_OPTIONS } from "./constants";
import {
  defaultModelForGroup,
  effortLevelsFor,
  groupByRoute,
  modelPriceLabel,
  type PickerModel,
} from "./modelPicker.helpers";

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
  /** Current effort ("" = model decides). Omit both effort props to hide the effort select (image models). */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  disabled?: boolean;
}) {
  const uid = useId();
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
  const effortOptions = EFFORT_OPTIONS.filter((o) => o.value === "" || levels.includes(o.value)).map((o) =>
    o.value === "" ? { ...o, label: defaultEffortLabel(selected?.defaultEffort) } : o,
  );
  // A saved level this model does not take is never shown as chosen.
  const effortValue = effort && levels.includes(effort) ? effort : "";

  function pick(next: PickerModel | undefined) {
    if (!next) return;
    onChange(next.id);
    onEffortChange?.("");
  }

  return (
    <div className="space-y-3">
      <Select
          id={`${uid}-provider`}
          label={`${label} provider`}
          value={routeId}
          onChange={(e) => {
            const r = routes.find((g) => g.id === e.target.value);
            pick(r ? defaultModelForGroup(r) : undefined);
          }}
          disabled={disabled}
          data-testid="picker-provider"
        >
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      {showVendors && (
        <Select
            id={`${uid}-vendor`}
            label={`${label} vendor`}
            value={vendorId}
            onChange={(e) => {
              const v = route?.vendors.find((g) => g.id === e.target.value);
              pick(v ? defaultModelForGroup(v) : undefined);
            }}
            disabled={disabled}
            data-testid="picker-vendor"
          >
            {route?.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </Select>
      )}
      <Select
          id={`${uid}-model`}
          label={`${label} model`}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onEffortChange?.("");
          }}
          disabled={disabled}
          data-testid="picker-model"
        >
          {!selected && (
            <option value="" disabled>
              Select a model
            </option>
          )}
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.recommended ? " ★" : ""} · {modelPriceLabel(m)}
            </option>
          ))}
        </Select>
      {effortVisible && (
        <Select
            id={`${uid}-effort`}
            label="Reasoning effort"
            value={effortValue}
            onChange={(e) => onEffortChange?.(e.target.value)}
            disabled={disabled}
            data-testid="picker-effort"
          >
            {effortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
      )}
    </div>
  );
}
