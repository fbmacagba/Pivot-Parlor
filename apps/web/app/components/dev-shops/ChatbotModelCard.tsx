// Platform-wide chatbot model and effort (one choice for every shop's visitor
// chatbot). Presentational apart from the save state; the route owns the request.
import { useMemo, useState } from "react";
import { chatbotEffortLevels } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { EFFORT_OPTIONS } from "./constants";
import { ModelPicker } from "./ModelPicker";
import { effortLevelsFor, effortToSend, type PickerModel } from "./modelPicker.helpers";

/** The models with their effort levels cut to what the chatbot may use (up to medium). */
export function chatbotPickerModels(models: PickerModel[]): PickerModel[] {
  return models.map((m) => {
    const levels = chatbotEffortLevels(effortLevelsFor(m));
    return { ...m, effortLevels: levels, supportsEffort: levels.length > 0 };
  });
}

/** "low" -> "low", "xhigh" -> "extra high": the option label's first part, lower case. */
function effortLabel(effort: string): string {
  return EFFORT_OPTIONS.find((o) => o.value === effort)?.label.split(" - ")[0]?.toLowerCase() ?? effort;
}

export function ChatbotModelCard({
  models,
  savedModelId,
  savedEffort = null,
  savedAt,
  defaultModelId,
  onSave,
}: {
  models: PickerModel[];
  /** Value stored by the platform, null until the first save. */
  savedModelId: string | null;
  /** Saved effort level, null when the model decides. */
  savedEffort?: string | null;
  savedAt: string | null;
  /** The chatbot worker's code default, used until a choice is saved. */
  defaultModelId: string;
  /** effort is "" when the model decides. */
  onSave: (modelId: string, effort: string) => Promise<void>;
}) {
  const chatbotModels = useMemo(() => chatbotPickerModels(models), [models]);
  const effectiveId = savedModelId ?? defaultModelId;
  const [choice, setChoice] = useState(effectiveId);
  const [effort, setEffort] = useState(savedEffort ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const selected = chatbotModels.find((m) => m.id === choice);
  // An unlisted saved model keeps its saved level as is, so it never reads as an edit.
  const effortSent = selected ? effortToSend(selected, effort) : effort;
  const dirty = choice !== effectiveId || effortSent !== (savedEffort ?? "");

  async function handleSave() {
    if (!dirty || state === "saving") return;
    setState("saving");
    setError("");
    try {
      await onSave(choice, effortSent);
      setState("saved");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save the chatbot model.");
      setState("error");
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-white/10 bg-dark-100 p-4" aria-labelledby="chatbot-model-heading">
      <h2 id="chatbot-model-heading" className="font-heading text-lg font-bold text-white">
        Shop chatbot model
      </h2>
      <p className="text-xs text-white/60">
        One choice for every shop&apos;s visitor chatbot. Visitors wait for each reply, so effort goes up to Medium;
        None or Low answers fastest.
      </p>
      <p className="text-sm text-white/70" data-testid="chatbot-model-current">
        {savedModelId
          ? `Current: ${nameOf(savedModelId)}${savedEffort ? `, ${effortLabel(savedEffort)} effort` : ""}${savedAt ? `, saved ${savedAt.slice(0, 10)}` : ""}`
          : `Using the code default until saved: ${nameOf(defaultModelId)}`}
      </p>
      <ModelPicker
        label="Chatbot"
        models={chatbotModels}
        value={choice}
        onChange={(id) => {
          setChoice(id);
          setState("idle");
        }}
        effort={effort}
        onEffortChange={(next) => {
          setEffort(next);
          setState("idle");
        }}
        disabled={state === "saving"}
      />
      <Button onClick={handleSave} disabled={!dirty || state === "saving"} className="w-full">
        {state === "saving" ? "Saving…" : "Save chatbot model"}
      </Button>
      <div aria-live="polite">
        {state === "saved" && (
          <p className="text-xs text-emerald-400">Saved. New conversations use this model from now on.</p>
        )}
        {state === "error" && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
