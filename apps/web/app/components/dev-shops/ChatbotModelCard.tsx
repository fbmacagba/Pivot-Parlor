// Platform-wide chatbot model (one choice for every shop's visitor chatbot).
// Presentational apart from the save state; the route owns the request.
import { useState } from "react";
import { Button } from "~/components/ui/Button";
import { ModelPicker } from "./ModelPicker";
import type { PickerModel } from "./modelPicker.helpers";

export function ChatbotModelCard({
  models,
  savedModelId,
  savedAt,
  defaultModelId,
  onSave,
}: {
  models: PickerModel[];
  /** Value stored by the platform, null until the first save. */
  savedModelId: string | null;
  savedAt: string | null;
  /** The chatbot worker's code default, used until a choice is saved. */
  defaultModelId: string;
  onSave: (modelId: string) => Promise<void>;
}) {
  const effectiveId = savedModelId ?? defaultModelId;
  const [choice, setChoice] = useState(effectiveId);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const dirty = choice !== effectiveId;

  async function handleSave() {
    if (!dirty || state === "saving") return;
    setState("saving");
    setError("");
    try {
      await onSave(choice);
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
      <p className="text-xs text-white/50">
        One choice for every shop&apos;s visitor chatbot. Reasoning effort is never sent to the chatbot.
      </p>
      <p className="text-sm text-white/70" data-testid="chatbot-model-current">
        {savedModelId
          ? `Current: ${nameOf(savedModelId)}${savedAt ? `, saved ${savedAt.slice(0, 10)}` : ""}`
          : `Using the code default until saved: ${nameOf(defaultModelId)}`}
      </p>
      <ModelPicker
        label="Chatbot"
        models={models}
        value={choice}
        onChange={(id) => {
          setChoice(id);
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
        {state === "error" && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </section>
  );
}
