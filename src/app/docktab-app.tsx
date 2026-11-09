"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Step = { tool: string; ok: boolean; summary: string };
type Turn = { role: "user" | "assistant"; text: string; steps?: Step[]; ms?: number };
type Detention = { billableMinutes: number; billableHours: string; amount: string; stillAtDock: boolean; onSiteMinutes: number };
type Load = {
  id: string;
  broker: string;
  receiver: string;
  city: string;
  appointment: string;
  arrived: string | null;
  released: string | null;
  ratePerHour: number;
  detention: Detention | null;
  invoiceId?: string;
  invoiceStatus?: string;
  lumper?: { amount: string; status: string };
};

const EXAMPLES = [
  "I've been stuck at the Columbus dock all morning, bill the broker for detention",
  "Lumper wants 150 dollars for load 1042",
  "Has Prairie paid me for Indianapolis yet?",
];

const TOOL_LABEL: Record<string, string> = {
  loads: "Checked your loads",
  bill_detention: "PayPal invoice",
  pay_lumper: "PayPal payout",
  list_invoices: "PayPal invoices",
  get_invoice: "PayPal invoice status",
  send_invoice_reminder: "PayPal reminder",
  paypal_activity: "PayPal transactions",
};

// Minimal Web Speech API typing (Chrome and Safari prefix it).
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};
const speechCtor = (): (new () => Recognition) | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => Recognition) | null;
};

const money = (v: string | number) => `$${Number(v).toFixed(2)}`;
const mins = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;

export default function DockTabApp() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<Step[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState<Load[]>([]);
  const [canListen, setCanListen] = useState(false);
  const recRef = useRef<Recognition | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCanListen(speechCtor() !== null);
  }, []);

  const refreshBoard = useCallback(async () => {
    const res = await fetch("/api/board", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setLoads(((await res.json()) as { loads: Load[] }).loads);
  }, []);

  useEffect(() => {
    void refreshBoard();
    const t = setInterval(refreshBoard, 15_000);
    return () => clearInterval(t);
  }, [refreshBoard]);

  // Block body on purpose: newer Chrome returns a Promise from scrollIntoView,
  // and React would call a returned value as the effect's clean-up and crash.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, live]);

  const say = useCallback(
    (text: string) => {
      if (!speak || typeof speechSynthesis === "undefined") return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      speechSynthesis.speak(u);
    },
    [speak],
  );

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) return;
      setError(null);
      setBusy(true);
      setInput("");
      setLive([]);
      // Earlier replies carry a note of the calls behind them, so the agent knows
      // what it already checked.
      const history = turns.slice(-10).map(({ role, text, steps }) => ({
        role,
        text: steps?.length ? `${text}\n[Looked up: ${steps.map((s) => s.summary).join("; ")}]` : text,
      }));
      setTurns((t) => [...t, { role: "user", text }]);
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, history }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "DockTab could not answer. Please try again.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const steps: Step[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === "step") {
              steps.push(event);
              setLive([...steps]);
            } else if (event.type === "done") {
              setTurns((t) => [...t, { role: "assistant", text: event.reply, steps, ms: event.ms }]);
              setLive([]);
              say(event.reply);
              void refreshBoard();
            } else if (event.type === "error") {
              throw new Error(event.error);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLive([]);
      } finally {
        setBusy(false);
      }
    },
    [busy, turns, say, refreshBoard],
  );

  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setInput(finalText + interim);
    };
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") setError(`Microphone: ${e.error}`);
    };
    rec.onend = () => {
      setListening(false);
      if (finalText.trim()) void send(finalText);
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  return (
    <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[1.1fr_1fr] lg:py-10">
      {/* Driver */}
      <section className="flex min-h-[70vh] min-w-0 flex-col rounded-3xl border border-line bg-panel p-5 sm:p-6">
        <header className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Dock<span className="text-accent">Tab</span>
            </h1>
            <p className="text-sm text-muted">Say what happened. DockTab bills or pays through PayPal.</p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            Read replies aloud
          </label>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite">
          {turns.length === 0 && (
            <div className="space-y-2">
              <p className="text-sm text-muted">Try one of these:</p>
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  onClick={() => send(e)}
                  disabled={busy}
                  className="block w-full rounded-2xl border border-line bg-tile px-4 py-3 text-left text-[15px] hover:border-accent disabled:opacity-50"
                >
                  “{e}”
                </button>
              ))}
            </div>
          )}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <p key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-tile px-4 py-3 text-[15px]">
                {t.text}
              </p>
            ) : (
              <div key={i} className="max-w-[92%] space-y-2">
                {t.steps && t.steps.length > 0 && <Steps steps={t.steps} />}
                <p className="rounded-2xl rounded-bl-md border border-accent/40 bg-accent/10 px-4 py-3 text-lg leading-snug">
                  {t.text}
                </p>
                {t.ms !== undefined && <p className="text-xs text-muted">{(t.ms / 1000).toFixed(1)} s</p>}
              </div>
            ),
          )}
          {busy && (
            <div className="max-w-[92%] space-y-2">
              <Steps steps={live} />
              <p className="text-sm text-muted">Working on it…</p>
            </div>
          )}
          {error && <p className="rounded-2xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm">{error}</p>}
          <div ref={endRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="mt-4 flex items-center gap-3"
        >
          {canListen && (
            <button
              type="button"
              onClick={toggleMic}
              disabled={busy}
              aria-label={listening ? "Stop listening" : "Talk to DockTab"}
              className={`grid size-16 shrink-0 place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-50 ${listening ? "listening" : ""}`}
            >
              <svg viewBox="0 0 24 24" className="size-7" fill="currentColor" aria-hidden>
                {listening ? (
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                ) : (
                  <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
                )}
              </svg>
            </button>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={listening ? "Listening…" : "Or type: bill detention for load 1042"}
            maxLength={500}
            className="h-14 min-w-0 flex-1 rounded-2xl border border-line bg-tile px-4 text-[15px] outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="h-14 shrink-0 rounded-2xl bg-ink px-4 font-medium sm:px-5 text-bg disabled:opacity-40"
          >
            Send
          </button>
        </form>
        <p className="mt-3 text-xs text-muted">PayPal sandbox only: no real money moves. Brokers and the lumper are sandbox test accounts.</p>
      </section>

      {/* Dispatcher board */}
      <section className="min-w-0 rounded-3xl border border-line bg-panel p-5 sm:p-6">
        <header className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Loads and money</h2>
          <span className="text-xs text-muted">Live from PayPal</span>
        </header>
        <div className="space-y-3">
          {loads.map((l) => (
            <LoadCard key={l.id} load={l} />
          ))}
          {loads.length === 0 && <p className="text-sm text-muted">Loading…</p>}
        </div>
      </section>
    </main>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="space-y-1">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-2 font-mono text-xs text-muted">
          <span className={s.ok ? "text-good" : "text-bad"}>{s.ok ? "✓" : "✗"}</span>
          <span>
            <span className="text-blue">{TOOL_LABEL[s.tool] ?? s.tool}</span> · {s.summary}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Badge({ tone, children }: { tone: "good" | "accent" | "muted" | "blue"; children: React.ReactNode }) {
  const cls = {
    good: "bg-good/15 text-good",
    accent: "bg-accent/15 text-accent",
    muted: "bg-tile text-muted",
    blue: "bg-blue/15 text-blue",
  }[tone];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}

function LoadCard({ load: l }: { load: Load }) {
  const d = l.detention;
  const where = !l.arrived ? "Not arrived" : l.released ? "Delivered" : "At the dock";
  return (
    <article className="rounded-2xl border border-line bg-tile p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-sm text-muted">{l.id}</p>
          <p className="font-medium">
            {l.receiver}, {l.city}
          </p>
          <p className="text-sm text-muted">{l.broker}</p>
        </div>
        <Badge tone={where === "At the dock" ? "accent" : where === "Delivered" ? "muted" : "blue"}>{where}</Badge>
      </div>
      {d && (
        <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-xs text-muted">Detention clock</dt>
            <dd className="font-mono">{mins(d.onSiteMinutes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Billable</dt>
            <dd className="font-mono">{mins(d.billableMinutes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Owed at ${l.ratePerHour}/h</dt>
            <dd className="font-mono font-semibold">{money(d.amount)}</dd>
          </div>
        </dl>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {l.invoiceId ? (
          <Badge tone={l.invoiceStatus === "PAID" ? "good" : "accent"}>Invoice {String(l.invoiceStatus ?? "").toLowerCase()}</Badge>
        ) : (
          d && d.billableMinutes > 0 && <Badge tone="muted">Not billed yet</Badge>
        )}
        {l.lumper && (
          <Badge tone={l.lumper.status === "SUCCESS" ? "good" : "accent"}>
            Lumper {money(l.lumper.amount)} {String(l.lumper.status ?? "").toLowerCase()}
          </Badge>
        )}
      </div>
    </article>
  );
}
