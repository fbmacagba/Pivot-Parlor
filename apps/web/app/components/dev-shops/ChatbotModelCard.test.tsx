/** The chatbot model card: current-choice line, picker and effort (server
 *  markup), and saving (rendered client-side so the handlers run). */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatbotModelCard, chatbotPickerModels } from "./ChatbotModelCard";
import type { PickerModel } from "./modelPicker.helpers";

const MODELS: PickerModel[] = [
  {
    id: "google/gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    vendor: "google",
    vendorLabel: "Google",
    costPer1MInput: 0.25,
    costPer1MOutput: 1.5,
    supportsEffort: true,
  },
  {
    id: "openai-api/gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "openai",
    providerLabel: "OpenAI API",
    vendor: "openai",
    vendorLabel: "OpenAI",
    costPer1MInput: 10,
    costPer1MOutput: 50,
    supportsEffort: true,
  },
];

const noop = async () => {};

describe("ChatbotModelCard", () => {
  it("explains that the code default applies until a choice is saved", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard models={MODELS} savedModelId={null} savedAt={null} defaultModelId="google/gemini-3.1-flash-lite-preview" onSave={noop} />,
    );
    expect(html).toContain("Shop chatbot model");
    expect(html).toContain("Using the code default until saved: Gemini 3.1 Flash Lite");
    expect(html).toContain('data-testid="picker-provider"');
    expect(html).toContain('data-testid="picker-effort"');
  });

  it("shows the saved choice and date", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard
        models={MODELS}
        savedModelId="openai-api/gpt-6-astra"
        savedAt="2026-09-12T10:15:00.000Z"
        defaultModelId="google/gemini-3.1-flash-lite-preview"
        onSave={noop}
      />,
    );
    expect(html).toContain("Current: GPT-6 Astra, saved 2026-09-12");
    expect(html).toContain("Save chatbot model");
  });

  it("names the saved effort on the current-choice line", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard
        models={MODELS}
        savedModelId="openai-api/gpt-6-astra"
        savedEffort="low"
        savedAt="2026-11-17T10:15:00.000Z"
        defaultModelId="google/gemini-3.1-flash-lite-preview"
        onSave={noop}
      />,
    );
    expect(html).toContain("Current: GPT-6 Astra, low effort, saved 2026-11-17");
    expect(html).toContain("None or Low answers fastest");
  });

  it("names an unknown saved id rather than hiding it", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard models={MODELS} savedModelId="x-ai/grok-9" savedAt={null} defaultModelId="google/gemini-3.1-flash-lite-preview" onSave={noop} />,
    );
    expect(html).toContain("Current: x-ai/grok-9");
  });
});

describe("chatbotPickerModels", () => {
  const base = MODELS[1]!;
  it("cuts each model's effort levels to medium at most, in ladder order", () => {
    const [luna, highOnly, unreported, none] = chatbotPickerModels([
      { ...base, id: "a", effortLevels: ["none", "low", "medium", "high", "xhigh", "max"] },
      { ...base, id: "b", effortLevels: ["high", "xhigh"] },
      { ...base, id: "c" },
      { ...base, id: "d", supportsEffort: false },
    ]);
    expect(luna).toMatchObject({ effortLevels: ["none", "low", "medium"], supportsEffort: true });
    // Nothing at medium or below: the effort select is hidden for this model.
    expect(highOnly).toMatchObject({ effortLevels: [], supportsEffort: false });
    // Effort with no reported list means low, medium and high: the chatbot keeps low and medium.
    expect(unreported).toMatchObject({ effortLevels: ["low", "medium"], supportsEffort: true });
    expect(none).toMatchObject({ effortLevels: [], supportsEffort: false });
  });
});

describe("ChatbotModelCard, saving", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
  });

  function render(props: Partial<Parameters<typeof ChatbotModelCard>[0]>, onSave: (id: string, effort: string) => Promise<void>) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <ChatbotModelCard
          models={MODELS}
          savedModelId="openai-api/gpt-6-astra"
          savedAt={null}
          defaultModelId="google/gemini-3.1-flash-lite-preview"
          onSave={onSave}
          {...props}
        />,
      ),
    );
  }
  const effortSelect = () => (container.querySelector('[data-testid="picker-effort"]') as HTMLSelectElement | null)!;
  const saveButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Save"))!;

  it("offers Default, Low and Medium, and saves an effort-only change", async () => {
    const saved: Array<[string, string]> = [];
    render({}, async (id, effort) => {
      saved.push([id, effort]);
    });
    expect([...effortSelect().options].map((o) => o.value)).toEqual(["", "low", "medium"]);
    expect(saveButton().disabled).toBe(true);

    act(() => {
      effortSelect().value = "low";
      effortSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saveButton().disabled).toBe(false);
    await act(async () => {
      saveButton().click();
    });
    expect(saved).toEqual([["openai-api/gpt-6-astra", "low"]]);
  });

  it("does not read an unlisted saved model with a saved effort as an edit", () => {
    render({ savedModelId: "x-ai/grok-9", savedEffort: "low" }, noop);
    expect(saveButton().disabled).toBe(true);
  });
});
