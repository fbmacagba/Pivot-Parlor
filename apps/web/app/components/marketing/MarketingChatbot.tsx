// Marketing chatbot: Pip — Pivot Parlor brand colours (gold/dark), Messenger-style UX
// Mobile: fullscreen overlay, keyboard only appears when input is focused (FB Messenger behaviour)

import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "@remix-run/react";
import { X, Send, ThumbsUp, Smile, Scissors, ChevronDown } from "lucide-react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const WELCOME: Message = {
  role: "assistant",
  content:
    "Hi, I'm Pip, Pivot Parlor's AI assistant. Do you own or run a beauty or barber shop? 👇",
};

const CHIPS = ["Yes, I own a shop ✓", "Just browsing", "What's the cost?"];
const TEASER = "Got a shop? Let's talk ✂️";

// Pivot Parlor brand palette
const GOLD       = "#C9A84C";
const GOLD_LIGHT = "#E2C47A";
const DARK       = "#0D0D0D";
const DARK_100   = "#1a1a1a";
const DARK_200   = "#2a2a2a";
const GOLD_GRAD  = `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`;

// Original Pip icon — scissors/snip motif, fully original SVG
function PipIcon({ size = 24, color = DARK }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="5.5" cy="5.5" r="2.5" stroke={color} strokeWidth="1.8" />
      <circle cx="5.5" cy="18.5" r="2.5" stroke={color} strokeWidth="1.8" />
      <line x1="8" y1="7" x2="20" y2="13" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="8" y1="17" x2="20" y2="11" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="20" cy="12" r="1.5" fill={color} />
    </svg>
  );
}

export function MarketingChatbot() {
  const [open, setOpen]                       = useState(false);
  const [showTeaser, setShowTeaser]           = useState(false);
  const [teaserDismissed, setTeaserDismissed] = useState(false);
  const [messages, setMessages]               = useState<Message[]>([WELCOME]);
  const [input, setInput]                     = useState("");
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState<string | null>(null);
  const [inputFocused, setInputFocused]       = useState(false);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!open) setShowTeaser(true);
    }, 4000);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- teaser delay once on mount only (not when `open` changes)

  useEffect(() => {
    if (open) { setShowTeaser(false); setTeaserDismissed(true); }
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }, [messages, open]);

  useEffect(() => {
    if (!open) {
      setInputFocused(false);
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }, [open]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const isMobile = window.innerWidth < 640;
    if (open && isMobile) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = { role: "user", content: trimmed };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply ?? "" }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  const handleMessagesAreaTap = useCallback(() => {
    if (inputFocused && inputRef.current) {
      inputRef.current.blur();
      setInputFocused(false);
    }
  }, [inputFocused]);

  function renderContent(text: string) {
    const parts = text.split(/(pivotparlor\.com\/contact|\/contact)/g);
    return parts.map((part, i) => {
      if (part === "/contact" || part === "pivotparlor.com/contact") {
        return (
          <Link key={i} to="/contact"
            style={{ color: GOLD, textDecoration: "underline", fontWeight: 600 }}
            onClick={() => setOpen(false)}>
            pivotparlor.com/contact
          </Link>
        );
      }
      return <span key={i}>{part}</span>;
    });
  }

  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const showChips = userMessageCount === 0 && !loading;

  return (
    <>
      {/* ── Teaser bubble ── */}
      {showTeaser && !teaserDismissed && !open && (
        <div className="fixed bottom-24 right-6 z-50"
          style={{ animation: "pip-slide-up 0.4s cubic-bezier(0.34,1.56,0.64,1) both" }}>
          <div
            className="relative cursor-pointer rounded-2xl rounded-br-sm px-4 py-2.5 text-sm font-semibold shadow-xl"
            style={{ background: GOLD_GRAD, color: DARK, maxWidth: 195 }}
            onClick={() => setOpen(true)}>
            {TEASER}
            <button type="button" aria-label="Dismiss"
              onClick={(e) => { e.stopPropagation(); setShowTeaser(false); setTeaserDismissed(true); }}
              className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full shadow"
              style={{ background: DARK_100, border: `1px solid ${DARK_200}` }}>
              <X className="h-3 w-3" style={{ color: GOLD }} />
            </button>
          </div>
          <div className="absolute -bottom-1.5 right-5 h-3 w-3 rotate-45"
            style={{ background: GOLD_LIGHT }} />
        </div>
      )}

      {/* ── Launcher button — hidden on mobile when chat is open ── */}
      <div className={`fixed bottom-6 right-6 z-50 ${open ? "hidden sm:block" : ""}`}>
        {!open && (
          <>
            <span className="absolute inset-0 rounded-full"
              style={{ animation: "pip-ping 2.2s cubic-bezier(0,0,0.2,1) infinite", background: GOLD, opacity: 0.35 }} />
            <span className="absolute inset-0 rounded-full"
              style={{ animation: "pip-ping 2.2s cubic-bezier(0,0,0.2,1) 0.7s infinite", background: GOLD, opacity: 0.18 }} />
          </>
        )}
        <button type="button" aria-label={open ? "Close chat" : "Chat with Pip"}
          onClick={() => setOpen((v) => !v)}
          className="relative flex h-14 w-14 items-center justify-center rounded-full outline-none transition-all hover:scale-105 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark active:scale-95"
          style={{
            background: open ? DARK_200 : GOLD_GRAD,
            boxShadow: open ? "none" : `0 4px 20px rgba(201,168,76,0.5)`,
          }}>
          {open
            ? <X className="h-6 w-6" style={{ color: GOLD }} />
            : <PipIcon size={26} color={DARK} />
          }
        </button>
      </div>

      {/* ── Chat window ── */}
      {open && (
        <div role="dialog" data-pip-chat="" aria-label="Chat with Pip, Pivot Parlor's AI assistant"
          className="
            fixed z-50 flex flex-col overflow-hidden
            inset-0
            sm:inset-auto sm:bottom-24 sm:right-6 sm:rounded-2xl
          "
          style={{
            background: DARK,
            border: "none",
            ...(typeof window !== "undefined" && window.innerWidth >= 640 ? {
              width: 400,
              border: `1px solid ${DARK_200}`,
              boxShadow: `0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(201,168,76,0.1)`,
            } : {}),
            animation: "pip-slide-up 0.3s cubic-bezier(0.34,1.56,0.64,1) both",
          }}>

          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 shrink-0"
            style={{ borderBottom: `1px solid ${DARK_200}` }}>
            <div className="relative shrink-0">
              <div className="flex h-10 w-10 items-center justify-center rounded-full"
                style={{ background: GOLD_GRAD }}>
                <PipIcon size={20} color={DARK} />
              </div>
              <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2"
                style={{ background: GOLD, borderColor: DARK }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white">Pip</p>
              <p className="text-xs" style={{ color: GOLD }}>Pivot Parlor AI · Replies instantly</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close chat"
              className="flex h-9 w-9 items-center justify-center rounded-full outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark">
              <ChevronDown className="h-5 w-5 sm:hidden" style={{ color: "rgba(255,255,255,0.6)" }} />
              <X className="h-4 w-4 hidden sm:block text-white/50" />
            </button>
          </div>

          {/* Pricing strip */}
          <div className="flex items-center justify-around px-4 py-2.5 shrink-0"
            style={{ borderBottom: `1px solid ${DARK_200}`, background: "rgba(201,168,76,0.05)" }}>
            {[
              { value: "£100", label: "one-time setup"   },
              { value: "£0",   label: "monthly fee"      },
              { value: "10%",  label: "per booking only" },
            ].map(({ value, label }) => (
              <div key={label} className="flex flex-col items-center">
                <span className="text-sm font-bold" style={{ color: GOLD }}>{value}</span>
                <span className="text-[10px] mt-0.5 text-center" style={{ color: "rgba(255,255,255,0.6)" }}>{label}</span>
              </div>
            ))}
          </div>

          {/* Messages
              minHeight: 260px — locks the window open even with a single message,
              replacing the visual height that was previously filled by the avatar block.
              maxHeight: 360px — lets the area grow as conversation gets longer.
          */}
          <div
            ref={messagesRef}
            onClick={handleMessagesAreaTap}
            className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-3"
            style={{ minHeight: 260, maxHeight: 360 }}
            aria-live="polite"
            aria-relevant="additions"
          >
            {messages.map((msg, i) => {
              const isUser        = msg.role === "user";
              const nextMsg       = messages[i + 1];
              const isLastInGroup = !nextMsg || nextMsg.role !== msg.role;

              return (
                <div key={i}
                  className={`flex items-end gap-1.5 ${isUser ? "justify-end" : "justify-start"}`}
                  style={{ animation: "pip-fade-in 0.15s ease both" }}>
                  {!isUser && (
                    <div className="shrink-0 mb-0.5" style={{ width: 28 }}>
                      {isLastInGroup && (
                        <div className="flex h-7 w-7 items-center justify-center rounded-full"
                          style={{ background: GOLD_GRAD }}>
                          <PipIcon size={14} color={DARK} />
                        </div>
                      )}
                    </div>
                  )}
                  <div className="max-w-[72%] px-3.5 py-2 text-sm leading-relaxed"
                    style={isUser
                      ? { background: GOLD_GRAD, color: DARK, fontWeight: 500, borderRadius: "18px 18px 4px 18px" }
                      : { background: DARK_200, color: "rgba(255,255,255,0.9)", borderRadius: "18px 18px 18px 4px" }
                    }>
                    {msg.role === "assistant" ? renderContent(msg.content) : msg.content}
                  </div>
                </div>
              );
            })}

            {/* Typing dots */}
            {loading && (
              <div className="flex items-end gap-1.5"
                style={{ animation: "pip-fade-in 0.15s ease both" }}>
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                  style={{ background: GOLD_GRAD }}>
                  <PipIcon size={14} color={DARK} />
                </div>
                <div className="flex items-center gap-1 px-4 py-3 rounded-full"
                  style={{ background: DARK_200 }}>
                  {[0, 1, 2].map((j) => (
                    <span key={j} className="block h-2 w-2 rounded-full"
                      style={{ background: GOLD, opacity: 0.7, animation: `pip-bounce 1.4s ease-in-out ${j * 0.2}s infinite` }} />
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-center text-xs text-red-400 mt-1">{error}</p>}
            <div ref={bottomRef} />
          </div>

          {/* Quick reply chips */}
          {showChips && (
            <div className="flex flex-wrap gap-2 px-4 pb-3 pt-2 shrink-0">
              {CHIPS.map((chip) => (
                <button key={chip} type="button" onClick={() => sendMessage(chip)}
                  className="rounded-full px-3.5 py-1.5 text-xs font-medium transition-all hover:opacity-80 active:scale-95"
                  style={{
                    border: `1px solid ${GOLD}`,
                    color: GOLD,
                    background: "rgba(201,168,76,0.08)",
                    whiteSpace: "nowrap",
                  }}>
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Input bar */}
          <div className="flex items-center gap-2 px-3 py-2.5 shrink-0"
            style={{ borderTop: `1px solid ${DARK_200}` }}>
            <button type="button" aria-label="Pip"
              className="flex h-11 min-h-[44px] w-11 min-w-[44px] shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark">
              <Scissors className="h-4 w-4" style={{ color: GOLD }} aria-hidden />
            </button>
            <div className="relative flex flex-1 items-center rounded-full px-3 py-1.5"
              style={{ background: DARK_200 }}
              onClick={() => {
                if (inputRef.current && !inputFocused) {
                  inputRef.current.readOnly = false;
                  inputRef.current.focus();
                  setInputFocused(true);
                }
              }}>
              <input
                ref={inputRef}
                type="text"
                inputMode="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                readOnly={!inputFocused}
                placeholder="Aa"
                disabled={loading}
                aria-label="Message"
                className="flex-1 rounded-md bg-transparent px-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark-200 disabled:opacity-60"
                style={{ color: "#fff", minWidth: 0 }}
              />
              <button type="button" className="ml-1 flex h-11 min-h-[44px] w-11 min-w-[44px] shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark-200"
                aria-label="Focus message field"
                onClick={() => {
                  if (inputRef.current) {
                    inputRef.current.readOnly = false;
                    inputRef.current.focus();
                    setInputFocused(true);
                  }
                }}>
                <Smile className="h-4 w-4" style={{ color: GOLD }} aria-hidden />
              </button>
            </div>
            {input.trim()
              ? (
                <button type="button" onClick={() => sendMessage(input)}
                  disabled={loading} aria-label="Send message"
                  className="flex h-11 min-h-[44px] w-11 min-w-[44px] shrink-0 items-center justify-center rounded-full outline-none transition-all hover:opacity-85 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark disabled:opacity-40 active:scale-90"
                  style={{ background: GOLD_GRAD }}>
                  <Send className="h-4 w-4" style={{ color: DARK }} aria-hidden />
                </button>
              ) : (
                <button type="button" onClick={() => sendMessage("👍")}
                  aria-label="Send thumbs up"
                  className="flex h-11 min-h-[44px] w-11 min-w-[44px] shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark active:scale-90">
                  <ThumbsUp className="h-5 w-5" style={{ color: GOLD }} aria-hidden />
                </button>
              )
            }
          </div>

          {/* Branding footer */}
          <p className="pb-2 pt-0.5 text-center text-xs shrink-0"
            style={{ color: "rgba(255,255,255,0.6)" }}>
            Powered by Pivot Parlor AI
          </p>
        </div>
      )}

      <style>{`
        @keyframes pip-ping {
          0%        { transform: scale(1);   opacity: 0.4; }
          75%, 100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes pip-slide-up {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)    scale(1); }
        }
        @keyframes pip-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pip-bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30%           { transform: translateY(-4px); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes pip-ping {
            0%, 100% { transform: scale(1); opacity: 0; }
          }
          @keyframes pip-slide-up {
            from, to { opacity: 1; transform: none; }
          }
          @keyframes pip-fade-in {
            from, to { opacity: 1; transform: none; }
          }
          @keyframes pip-bounce {
            0%, 100% { transform: none; }
          }
          @keyframes pip-mobile-in {
            from, to { transform: none; }
          }
        }
        @media (max-width: 639px) {
          [role="dialog"][data-pip-chat] {
            animation: pip-mobile-in 0.32s cubic-bezier(0.32, 0.72, 0, 1) both !important;
          }
        }
        @keyframes pip-mobile-in {
          from { transform: translateY(100%); opacity: 1; }
          to   { transform: translateY(0);    opacity: 1; }
        }
      `}</style>
    </>
  );
}
