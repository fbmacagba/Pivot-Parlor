/** Server markup of the chatbot model card: current-choice line and picker. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatbotModelCard } from "./ChatbotModelCard";
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
    expect(html).not.toContain('data-testid="picker-effort"');
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

  it("names an unknown saved id rather than hiding it", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard models={MODELS} savedModelId="x-ai/grok-9" savedAt={null} defaultModelId="google/gemini-3.1-flash-lite-preview" onSave={noop} />,
    );
    expect(html).toContain("Current: x-ai/grok-9");
  });
});
