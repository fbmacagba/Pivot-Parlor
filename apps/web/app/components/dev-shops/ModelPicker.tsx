// Cascaded Provider -> Model -> Effort picker (spec: cascaded dropdowns over
// the top 5 providers). Pass a live-priced list (from /api/ai/models) when
// available, else staticPickerModels() fallback pricing.
import { EFFORT_OPTIONS } from "./constants";
import {
  defaultModelForProvider,
  groupByProvider,
  modelPriceLabel,
  type PickerModel,
} from "./modelPicker.helpers";

const SELECT_CLASS =
  "flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold";

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
  const groups = groupByProvider(models);
  const selected = models.find((m) => m.id === value);
  const providerId = selected?.provider ?? groups[0]?.id ?? "";
  const providerModels = groups.find((g) => g.id === providerId)?.models ?? [];
  const effortVisible = onEffortChange !== undefined && selected?.supportsEffort === true;

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-white/80">{label} provider</label>
        <select
          value={providerId}
          onChange={(e) => {
            const group = groups.find((g) => g.id === e.target.value);
            const next = group ? defaultModelForProvider(group) : undefined;
            if (next) {
              onChange(next.id);
              onEffortChange?.("");
            }
          }}
          disabled={disabled}
          className={SELECT_CLASS}
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id} className="bg-dark">
              {g.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-medium text-white/80">{label} model</label>
        <select
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onEffortChange?.("");
          }}
          disabled={disabled}
          className={SELECT_CLASS}
        >
          {providerModels.map((m) => (
            <option key={m.id} value={m.id} className="bg-dark">
              {m.name}
              {m.recommended ? " ★" : ""} — {modelPriceLabel(m)}
            </option>
          ))}
        </select>
      </div>
      {effortVisible && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-white/80">Reasoning effort</label>
          <select
            value={effort ?? ""}
            onChange={(e) => onEffortChange?.(e.target.value)}
            disabled={disabled}
            className={SELECT_CLASS}
          >
            {EFFORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="bg-dark">
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
