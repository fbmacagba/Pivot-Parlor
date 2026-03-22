import type { ChatMessage } from "./types.js";

export type QuickReply = { label: string; message: string };

const FIRST: QuickReply[] = [
  { label: "Book now", message: "I'd like to book an appointment." },
  { label: "View services", message: "What services do you offer?" },
  { label: "Opening hours", message: "What are your opening hours?" },
  { label: "Prices", message: "How much do your services cost?" },
];

const BOOKING: QuickReply[] = [
  { label: "Book now", message: "I'd like to book now — what's the link?" },
  { label: "See availability", message: "What slots are available today?" },
  { label: "Which staff?", message: "Who can I book with?" },
];

const SERVICES: QuickReply[] = [
  { label: "Book this service", message: "I'd like to book one of those services." },
  { label: "See prices", message: "Can you confirm prices for those services?" },
  { label: "Other services", message: "Do you offer any other services?" },
];

const PRICES: QuickReply[] = [
  { label: "Book now", message: "I'd like to go ahead and book." },
  { label: "More info", message: "Can you tell me more about your most popular service?" },
  { label: "Contact shop", message: "How can I contact the shop directly?" },
];

const DEFAULT: QuickReply[] = [
  { label: "Book now", message: "I'd like to book an appointment." },
  { label: "Services", message: "What services do you offer?" },
  { label: "Hours", message: "What are your opening hours?" },
  { label: "Location", message: "Where are you located?" },
];

function countPriorAssistant(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === "assistant").length;
}

export function buildQuickReplies(priorMessages: ChatMessage[], lastAssistantText: string): QuickReply[] {
  if (countPriorAssistant(priorMessages) === 0) {
    return FIRST;
  }

  const t = lastAssistantText.toLowerCase();

  if (/\b(book|booking|slot|appointment|reserve)\b/i.test(lastAssistantText)) {
    return BOOKING;
  }
  if (/\b(service|treatment|cut|style|colour|color|mani|pedi|facial|massage)\b/i.test(t)) {
    return SERVICES;
  }
  if (/£|price|prices|cost|fee|how much/i.test(lastAssistantText)) {
    return PRICES;
  }

  return DEFAULT;
}
