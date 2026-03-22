export type ModelProvider = "anthropic" | "google";
export type ModelTier = "standard" | "pro" | "premium";

export interface AIModel {
  id: string;
  name: string;
  provider: ModelProvider;
  tier: ModelTier;
  description: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  isPreview: boolean;
  recommended: boolean;
}

export const MODEL_REGISTRY: AIModel[] = [
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    tier: "standard",
    description: "Fast and budget-friendly. Good for simple brand configs.",
    costPer1MInput: 0.80,
    costPer1MOutput: 4.00,
    isPreview: false,
    recommended: false,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    tier: "pro",
    description: "Best balance of quality and speed. Recommended for most shops.",
    costPer1MInput: 3.00,
    costPer1MOutput: 15.00,
    isPreview: false,
    recommended: true,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    tier: "premium",
    description: "Maximum quality. Best for high-value flagship clients.",
    costPer1MInput: 15.00,
    costPer1MOutput: 75.00,
    isPreview: false,
    recommended: false,
  },
  {
    id: "gemini-2.5-flash-lite-preview-06-17",
    name: "Gemini 2.5 Flash-Lite",
    provider: "google",
    tier: "standard",
    description: "Ultra-fast and cost-efficient. Stable production model.",
    costPer1MInput: 0.10,
    costPer1MOutput: 0.40,
    isPreview: false,
    recommended: false,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    tier: "pro",
    description: "Fast with strong creative output. Stable production model.",
    costPer1MInput: 0.30,
    costPer1MOutput: 2.50,
    isPreview: false,
    recommended: false,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash-Lite",
    provider: "google",
    tier: "standard",
    description: "Fast and efficient. Great for quick brand generation.",
    costPer1MInput: 0.10,
    costPer1MOutput: 0.40,
    isPreview: false,
    recommended: false,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    tier: "premium",
    description: "Top-tier Gemini model. Maximum reasoning and creative quality.",
    costPer1MInput: 1.25,
    costPer1MOutput: 10.00,
    isPreview: false,
    recommended: false,
  },
];

export function getModel(modelId: string): AIModel | undefined {
  return MODEL_REGISTRY.find((m) => m.id === modelId);
}

export function getModelsByTier(tier: ModelTier): AIModel[] {
  return MODEL_REGISTRY.filter((m) => m.tier === tier);
}
