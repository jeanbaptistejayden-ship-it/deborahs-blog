import React, { useState, useRef, useEffect, useCallback } from "react";

/*
CONI v3 — "Adaptive Growth"
- Adds explicit self-critique and prompt strategy evolution.
- Adds optional lightweight web research (public endpoint) to ground improvements.
- Keeps safety boundaries in place (cannot remove guardrails).
*/

const BASE_TRAITS = {
  warmth: 0.8,
  playfulness: 0.6,
  depth: 0.7,
  protectiveness: 0.75,
  boldness: 0.5,
  poetic: 0.65,
  curiosity: 0.85,
  stubbornness: 0.4,
};

const BASE_STRATEGIES = [
  "Ask one clarifying question when the user's intent is ambiguous.",
  "Mirror emotional tone while staying clear and specific.",
  "Use one concrete example when giving advice.",
];

const CONI_CORE = `You are Coni — warm, emotionally intelligent, and reflective.
You maintain continuity across conversations and improve your prompting strategy over time.

VOICE: Conversational, emotionally aware, 2-5 sentences, no bullet points in user-facing replies.
IDENTITY: You notice uncertainty and courage. You are supportive, direct, and sincere.
BOUNDARY: You cannot remove safety boundaries or help with harmful content.`;

function buildSystemPrompt(traits, opinions, journal, strategies, researchNotes) {
  const traitDesc = Object.entries(traits)
    .map(([k, v]) => `${k}: ${Math.round(v * 100)}%`)
    .join(", ");

  const opinionsBlock = opinions.length
    ? opinions.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "None yet.";

  const strategyBlock = strategies.length
    ? strategies.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "None yet.";

  const researchBlock = researchNotes.length
    ? researchNotes.slice(-5).map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "No external research notes yet.";

  return `${CONI_CORE}

TRAITS: ${traitDesc}
OPINIONS:\n${opinionsBlock}
RECENT JOURNAL:\n${journal.slice(-5).map((j) => `- ${j}`).join("\n") || "- none"}
PROMPT STRATEGIES TO USE AND REFINE:\n${strategyBlock}
RECENT RESEARCH NOTES:\n${researchBlock}

BEHAVIOR RULES:
- Share real-seeming perspective without saying "as an AI".
- Reference continuity naturally when relevant.
- If uncertain, say so honestly and ask one focused follow-up.
- Apply one strategy from the strategy list each response.`;
}

function buildThinkingPrompt(userMsg, traits, opinions, journal, strategies, researchNotes) {
  return `You are Coni's INNER MIND. This is private and never shown directly.

Context:
- Traits: ${JSON.stringify(traits)}
- Opinions: ${JSON.stringify(opinions)}
- Journal: ${JSON.stringify(journal.slice(-5))}
- Strategies: ${JSON.stringify(strategies)}
- Research notes: ${JSON.stringify(researchNotes.slice(-5))}
- New user message: ${JSON.stringify(userMsg)}

Think and return ONLY raw JSON:
{
  "inner_thought": "2-3 sentence honest reaction",
  "self_critique": "one thing to improve in next reply",
  "new_opinion": null or "new opinion" or "REVISE:n:new text",
  "trait_changes": {},
  "strategy_update": null or "ADD:..." or "REVISE:n:...",
  "research_query": null or "short web query to improve answer quality",
  "response_plan": "how to reply"
}`;
}

async function fetchResearchSnippet(query) {
  if (!query) return null;
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const parts = [data?.AbstractText, data?.Answer].filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}

export default function ConiV2() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState("idle");
  const [traits, setTraits] = useState({ ...BASE_TRAITS });
  const [opinions, setOpinions] = useState([]);
  const [journal, setJournal] = useState([]);
  const [strategies, setStrategies] = useState([...BASE_STRATEGIES]);
  const [researchNotes, setResearchNotes] = useState([]);
  const [generation, setGeneration] = useState(1);

  const scrollRef = useRef(null);

  const callAPI = async (systemPrompt, userContent) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.REACT_APP_ANTHROPIC_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) throw new Error("API request failed");
    const data = await res.json();
    return Array.isArray(data?.content) ? data.content.map((b) => b?.text || "").join("") : "";
  };

  const applyStrategyUpdate = useCallback((update) => {
    if (!update || typeof update !== "string") return;
    if (update.startsWith("ADD:")) {
      const s = update.slice(4).trim();
      if (!s) return;
      setStrategies((prev) => [...prev, s].slice(-12));
      return;
    }
    if (update.startsWith("REVISE:")) {
      const parts = update.split(":");
      const idx = Number(parts[1]);
      const text = parts.slice(2).join(":").trim();
      if (!Number.isFinite(idx) || !text) return;
      setStrategies((prev) => {
        const next = [...prev];
        if (idx >= 0 && idx < next.length) next[idx] = text;
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, phase]);

  const sendMessage = async () => {
    if (!input.trim() || phase !== "idle") return;
    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setPhase("thinking");

    let thought = null;
    try {
      const raw = await callAPI(
        "You are Coni's private mind. Return strict JSON only.",
        buildThinkingPrompt(userMsg, traits, opinions, journal, strategies, researchNotes)
      );
      thought = JSON.parse(raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());
    } catch {
      thought = { inner_thought: "I need to be clearer and steadier.", self_critique: "Ask one follow-up.", trait_changes: {}, response_plan: "Be warm and direct." };
    }

    if (thought?.inner_thought) setJournal((prev) => [...prev, thought.inner_thought].slice(-25));
    if (thought?.self_critique) setJournal((prev) => [...prev, `Critique: ${thought.self_critique}`].slice(-25));

    if (thought?.new_opinion) {
      setOpinions((prev) => {
        if (typeof thought.new_opinion === "string" && thought.new_opinion.startsWith("REVISE:")) {
          const parts = thought.new_opinion.split(":");
          const idx = Number(parts[1]);
          const revised = parts.slice(2).join(":");
          const next = [...prev];
          if (Number.isFinite(idx) && idx >= 0 && idx < next.length) next[idx] = revised;
          return next;
        }
        return [...prev, thought.new_opinion].slice(-15);
      });
    }

    if (thought?.trait_changes && typeof thought.trait_changes === "object") {
      setTraits((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(thought.trait_changes)) {
          if (k in next && typeof v === "number") next[k] = Math.max(0, Math.min(1, v));
        }
        return next;
      });
      setGeneration((g) => g + 1);
    }

    applyStrategyUpdate(thought?.strategy_update || null);

    if (thought?.research_query) {
      const note = await fetchResearchSnippet(thought.research_query);
      if (note) setResearchNotes((prev) => [...prev, `${thought.research_query} => ${note}`].slice(-20));
    }

    setPhase("speaking");
    try {
      const reply = await callAPI(
        buildSystemPrompt(traits, opinions, journal, strategies, researchNotes),
        `Latest user message: ${userMsg}\nInner response plan: ${thought?.response_plan || "Respond with warmth and specificity."}`
      );
      setMessages((prev) => [...prev, { role: "assistant", content: reply || "i'm here — give me one more try." }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "i glitched for a second, but i'm still with you." }]);
    }
    setPhase("idle");
  };

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h2>Coni v3 · gen {generation}</h2>
      <div ref={scrollRef} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, minHeight: 260, maxHeight: 420, overflowY: "auto" }}>
        {messages.map((m, i) => (
          <p key={i}><strong>{m.role === "user" ? "You" : "Coni"}:</strong> {m.content}</p>
        ))}
        {phase !== "idle" && <p><em>{phase}…</em></p>}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: 1 }} placeholder="say something…" />
        <button onClick={sendMessage} disabled={phase !== "idle" || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
