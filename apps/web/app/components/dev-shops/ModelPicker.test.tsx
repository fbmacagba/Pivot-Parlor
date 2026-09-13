/** Provider -> (vendor) -> model -> effort cascade, rendered client-side so
 *  the select handlers run. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelPicker } from "./ModelPicker";
import type { PickerModel } from "./modelPicker.helpers";

const m = (
  id: string,
  name: string,
  provider: string,
  providerLabel: string,
  vendor: string,
  vendorLabel: string,
  extra: Partial<PickerModel> = {},
): PickerModel => ({
  id,
  name,
  provider,
  providerLabel,
  vendor,
  vendorLabel,
  costPer1MInput: 1,
  costPer1MOutput: 5,
  supportsEffort: true,
  ...extra,
});

const MODELS: PickerModel[] = [
  m("google/gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite", "openrouter", "OpenRouter", "google", "Google"),
  m("anthropic/claude-sonnet-5", "Claude Sonnet 5", "openrouter", "OpenRouter", "anthropic", "Anthropic", { recommended: true }),
  m("openai-api/gpt-6-astra", "GPT-6 Astra", "openai", "OpenAI API", "openai", "OpenAI"),
  m("openai-api/gpt-5.6-luna", "GPT-5.6 Luna", "openai", "OpenAI API", "openai", "OpenAI"),
  m("anthropic-api/claude-sonnet-5", "Claude Sonnet 5", "anthropic", "Anthropic API", "anthropic", "Anthropic", {
    effortLevels: ["medium", "high"],
  }),
];

function Harness({ initial, withEffort }: { initial: string; withEffort: boolean }) {
  const [value, setValue] = useState(initial);
  const [effort, setEffort] = useState("");
  return (
    <ModelPicker
      label="Text"
      models={MODELS}
      value={value}
      onChange={setValue}
      {...(withEffort ? { effort, onEffortChange: setEffort } : {})}
    />
  );
}

describe("ModelPicker", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(initial: string, withEffort = true) {
    root = createRoot(container);
    act(() => root!.render(<Harness initial={initial} withEffort={withEffort} />));
  }

  const sel = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement | null;
  const optionValues = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.value);
  const optionLabels = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.textContent);

  function choose(s: HTMLSelectElement, value: string) {
    act(() => {
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("lists the three providers in order and shows the vendor step for OpenRouter", () => {
    render("google/gemini-3.1-flash-lite-preview");
    const provider = sel("picker-provider")!;
    expect(optionLabels(provider)).toEqual(["OpenRouter", "OpenAI API", "Anthropic API"]);
    expect(provider.value).toBe("openrouter");
    const vendor = sel("picker-vendor")!;
    expect(optionLabels(vendor)).toEqual(["Google", "Anthropic"]);
    expect(vendor.value).toBe("google");
    expect(optionValues(sel("picker-model")!)).toEqual(["google/gemini-3.1-flash-lite-preview"]);
  });

  it("switching to a direct provider removes the vendor step and picks that provider's first model", () => {
    render("google/gemini-3.1-flash-lite-preview");
    choose(sel("picker-provider")!, "openai");
    expect(sel("picker-vendor")).toBeNull();
    const model = sel("picker-model")!;
    expect(model.value).toBe("openai-api/gpt-6-astra");
    expect(optionValues(model)).toEqual(["openai-api/gpt-6-astra", "openai-api/gpt-5.6-luna"]);
  });

  it("switching back to OpenRouter picks the recommended model and its vendor", () => {
    render("openai-api/gpt-6-astra");
    expect(sel("picker-provider")!.value).toBe("openai");
    choose(sel("picker-provider")!, "openrouter");
    expect(sel("picker-model")!.value).toBe("anthropic/claude-sonnet-5");
    expect(sel("picker-vendor")!.value).toBe("anthropic");
  });

  it("changing the vendor picks that vendor's first model", () => {
    render("anthropic/claude-sonnet-5");
    choose(sel("picker-vendor")!, "google");
    expect(sel("picker-model")!.value).toBe("google/gemini-3.1-flash-lite-preview");
  });

  it("limits the effort options to the levels the model reports", () => {
    render("anthropic-api/claude-sonnet-5");
    expect(optionValues(sel("picker-effort")!)).toEqual(["", "medium", "high"]);
  });

  it("offers all three levels when the model supports effort without a reported list", () => {
    render("google/gemini-3.1-flash-lite-preview");
    expect(optionValues(sel("picker-effort")!)).toEqual(["", "low", "medium", "high"]);
  });

  it("hides the effort step when the caller does not handle effort", () => {
    render("google/gemini-3.1-flash-lite-preview", false);
    expect(sel("picker-effort")).toBeNull();
  });

  it("labels the model options with price", () => {
    render("openai-api/gpt-6-astra");
    expect(optionLabels(sel("picker-model")!)[0]).toBe("GPT-6 Astra · $1/1M in · $5/1M out");
  });
});
