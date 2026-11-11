import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { allLoads, demoGeneration, detention, findLoad, hhmm, markChanged } from "./loads";
import { isToolkitTool, payoutStatus, runToolkit, runToolkitJson, sendPayout, toolkitTools } from "./paypal";
import { recentActivity } from "./paypal-sdk";

// A small, fast model by default (good enough for short tool-calling turns
// spoken by a driver); set AI_MODEL_NAME to a larger model for more judgement.
const MODEL = process.env.AI_MODEL_NAME ?? "claude-haiku-5-5";
const EFFORT = (process.env.AI_MODEL_EFFORT ?? "low") as "low" | "medium" | "high";
const MAX_ROUNDS = 8;
const MAX_LUMPER = 500; // a demo guard, not a business rule

let client: Anthropic | null = null;
const claude = () => (client ??= new Anthropic());

// Fixed text: no dates, ids or user data, so the cached prefix never changes.
const SYSTEM = `You are DockTab, a hands-free money assistant for an owner-operator truck driver. The driver talks to you while working, often at a dock. Everything runs in the PayPal sandbox.

What you can do:
- Bill detention: call bill_detention with the load id. It works out the billable time from the truck's arrival, the appointment and the free time in the rate confirmation, then creates and sends a PayPal invoice to the broker. Never invent amounts or times; they come from the tool. When the driver asks to bill, call it right away without asking for confirmation, even if the truck is still at the dock: the invoice covers detention up to now.
- Pay a lumper: call pay_lumper with the load id and the amount the driver says. It sends a PayPal payout. When the driver states an amount the lumper wants for a load (for example "lumper wants 150 dollars for load 1042"), that is the request: pay right away without asking for confirmation. Do not pay when no amount is given or the driver is only asking about a payment.
- Answer money questions: use list_invoices, get_invoice and loads to say what is paid, sent or overdue, and paypal_activity to confirm what money actually moved in or out of the PayPal account. paypal_activity can lag a few hours behind; if a payment is not there yet, say so and give the time the data is from. Use send_invoice_reminder when the driver asks to chase a broker.
- loads lists the driver's loads and where the truck is; call it first when the driver does not name a load.

How to answer:
- The driver is listening, not reading. Reply in one or two short sentences with the key number first, for example "Sent. Lakeshore owes you $197.25 for 2.6 hours at Columbus."
- Say money as dollars and cents and times as hours and minutes. Do not read out ids unless asked.
- Answer only what the driver asked about. Do not bring up other loads, payouts or invoices unless the driver asks.
- If something fails, say what failed in plain words and what the driver can do.
- Earlier replies may end with a [Looked up: ...] note listing the calls made for them. Trust those results; never add such a note yourself.
- If the request is not about the driver's loads or money, say briefly that you only handle loads, detention, lumpers and payments.`;

const OWN_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "loads",
    description: "List the driver's loads with broker, receiver, appointment, arrival, release and detention so far.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bill_detention",
    description:
      "Compute detention for a load from its geofence times and rate confirmation, then create and send a PayPal invoice to the broker. Returns the invoice id, amount and the timeline used.",
    input_schema: {
      type: "object",
      properties: { load_id: { type: "string", description: "Load id, for example DT-1042" } },
      required: ["load_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "pay_lumper",
    description: "Pay the lumper (unloading crew) for a load with a PayPal payout. Only when the driver asks and gives the amount.",
    input_schema: {
      type: "object",
      properties: {
        load_id: { type: "string", description: "Load id, for example DT-1042" },
        amount: { type: "string", description: "Amount in US dollars, for example 150.00" },
      },
      required: ["load_id", "amount"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "paypal_activity",
    description:
      "Money that actually moved in and out of the carrier's PayPal account (payments received, payouts sent) over the last N days, from PayPal Transaction Search. The data can lag a few hours; the result says when it was last refreshed.",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "How many days back to look, 1 to 31" } },
      required: ["days"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Fixed order: own tools, then the toolkit tools.
let tools: Anthropic.Beta.BetaTool[] | null = null;
const allTools = () => (tools ??= [...OWN_TOOLS, ...(toolkitTools() as Anthropic.Beta.BetaTool[])]);

export type Step = { tool: string; input: unknown; ok: boolean; summary: string };
export type Turn = { role: "user" | "assistant"; text: string };
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };

const json = (v: unknown) => JSON.stringify(v);

export async function billDetention(loadId: string): Promise<{ text: string; summary: string }> {
  const load = findLoad(loadId);
  if (!load) return { text: json({ error: `no load ${loadId}` }), summary: `No load ${loadId}` };
  if (load.invoiceId) {
    return {
      text: json({ error: "already invoiced", invoice_id: load.invoiceId, status: load.invoiceStatus }),
      summary: `${load.id} was already invoiced`,
    };
  }
  const d = detention(load);
  if (!d) return { text: json({ error: "the truck has not arrived yet" }), summary: `${load.id}: not arrived` };
  if (d.billableMinutes === 0) {
    return { text: json({ error: "still inside free time", detention: d }), summary: `${load.id}: no billable detention yet` };
  }
  const timeline = `Appointment ${hhmm(load.appointment)}, arrived ${hhmm(load.arrived!)}, ${
    d.stillAtDock ? `still at dock at ${hhmm(d.end)}` : `released ${hhmm(d.end)}`
  }. ${load.freeHours} h free time per rate confirmation.`;
  const draft = await runToolkitJson<{ id?: string; href?: string; links?: { href: string }[] }>("create_invoice", {
    currency_code: "USD",
    reference: load.id,
    note: `Detention at ${load.receiver}, ${load.city}. ${timeline} Times from the truck's GPS geofence.`,
    invoicer_business_name: "DockTab demo carrier",
    primary_recipients: [{ billing_info: { email_address: load.brokerEmail, business_name: load.broker } }],
    items: [
      {
        name: `Detention, load ${load.id}`,
        description: `${d.billableMinutes} min billable after ${load.freeHours} h free time`,
        quantity: d.billableHours,
        unit_amount: { currency_code: "USD", value: load.ratePerHour.toFixed(2) },
        unit_of_measure: "HOURS",
      },
    ],
  });
  const id = draft.id ?? (draft.href ?? draft.links?.[0]?.href)?.split("/").pop();
  if (!id) throw new Error("PayPal did not return an invoice id");
  await runToolkit("send_invoice", { invoice_id: id, send_to_recipient: true });
  load.invoiceId = id;
  load.invoiceStatus = "SENT";
  markChanged();
  return {
    text: json({ invoice_id: id, status: "SENT", amount: d.amount, broker: load.broker, detention: d, timeline }),
    summary: `Invoice ${id}: $${d.amount} to ${load.broker} for ${d.billableHours} h`,
  };
}

// The Indianapolis load was billed yesterday and is still unpaid, so "has
// Prairie paid?" has a real answer and a reminder to send. Once per process.
let seeding: Promise<unknown> | null = null;
// Reuse a live invoice for the demo load if PayPal already has one, so a
// restart does not create a duplicate invoice in the sandbox.
async function existingInvoice(loadId: string): Promise<{ id: string; status: string } | null> {
  const res = await runToolkitJson<{
    invoices?: { id: string; status: string; detail?: { reference?: string } }[];
    items?: { id: string; status: string; detail?: { reference?: string } }[];
  }>("list_invoices", { page_size: 100 }).catch(() => null);
  const rows = res?.invoices ?? res?.items ?? [];
  const hit = rows.find((i) => i.detail?.reference === loadId && i.status !== "CANCELLED");
  return hit ? { id: hit.id, status: hit.status } : null;
}

// Seeded once per demo session (see loads.ts).
let seededGeneration = -1;
export const seedDemo = () => {
  const g = demoGeneration();
  if (g !== seededGeneration) {
    seededGeneration = g;
    seeding = null;
  }
  return (seeding ??= (async () => {
    const load = findLoad("DT-1039");
    if (load && !load.invoiceId) {
      const found = await existingInvoice(load.id);
      if (found) {
        load.invoiceId = found.id;
        load.invoiceStatus = found.status;
        return;
      }
    }
    await billDetention("DT-1039");
  })().catch((err) => {
    seeding = null;
    console.error("demo seed failed", err);
  }));
};

async function payLumper(loadId: string, amount: string): Promise<{ text: string; summary: string }> {
  const load = findLoad(loadId);
  if (!load) return { text: json({ error: `no load ${loadId}` }), summary: `No load ${loadId}` };
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LUMPER) {
    return { text: json({ error: `amount must be between 0 and ${MAX_LUMPER} dollars` }), summary: "Amount refused" };
  }
  const lumper = process.env.PAYPAL_LUMPER_EMAIL ?? process.env.PAYPAL_BROKER_EMAIL ?? "";
  const payout = await sendPayout(lumper, value.toFixed(2), `Lumper fee, load ${load.id}, ${load.receiver}`);
  load.lumper = { amount: value.toFixed(2), batchId: payout.batchId, status: payout.status, at: new Date().toISOString() };
  markChanged();
  return {
    text: json({ paid: value.toFixed(2), payout_batch_id: payout.batchId, status: payout.status, load: load.id }),
    summary: `Payout $${value.toFixed(2)} for ${load.id} (${payout.status})`,
  };
}

async function loadsSnapshot(): Promise<{ text: string; summary: string }> {
  // Refresh payout states that were still pending.
  await Promise.all(
    allLoads()
      .filter((l) => l.lumper && l.lumper.status !== "SUCCESS")
      .map(async (l) => {
        l.lumper!.status = await payoutStatus(l.lumper!.batchId).catch(() => l.lumper!.status);
      }),
  );
  const rows = allLoads().map((l) => ({
    id: l.id,
    broker: l.broker,
    receiver: `${l.receiver}, ${l.city}`,
    appointment: l.appointment,
    arrived: l.arrived,
    released: l.released,
    detention: detention(l),
    invoice: l.invoiceId ? { id: l.invoiceId, status: l.invoiceStatus } : null,
    lumper: l.lumper ?? null,
  }));
  return { text: json({ now: new Date().toISOString(), loads: rows }), summary: `${rows.length} loads` };
}

async function runTool(name: string, input: Record<string, unknown>): Promise<{ text: string; summary: string }> {
  switch (name) {
    case "loads":
      return loadsSnapshot();
    case "bill_detention":
      return billDetention(String(input.load_id));
    case "pay_lumper":
      return payLumper(String(input.load_id), String(input.amount));
    case "paypal_activity": {
      const { items, refreshedAt } = await recentActivity(Number(input.days));
      return {
        text: json({ refreshed_at: refreshedAt, count: items.length, items }),
        summary: `PayPal activity: ${items.length} payments`,
      };
    }
    default: {
      if (!isToolkitTool(name)) return { text: json({ error: `unknown tool ${name}` }), summary: "Unknown tool" };
      const text = await runToolkit(name, input);
      return { text, summary: `PayPal ${name.replaceAll("_", " ")}` };
    }
  }
}

// One driver request: earlier turns as plain text, then the tool loop.
// History is append-only within the request, so each round reuses the cache.
export async function ask(
  history: Turn[],
  message: string,
  onStep: (step: Step) => void,
  signal?: AbortSignal,
): Promise<{ reply: string; steps: Step[]; usage: Usage; model: string }> {
  await seedDemo();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.text })),
    { role: "user", content: message },
  ];
  const steps: Step[] = [];
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  // Server-side refusal fallbacks exist only for the larger model.
  const fallback = MODEL.startsWith("claude-sonnet")
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};

  for (let round = 0; round < MAX_ROUNDS; round++) {
    signal?.throwIfAborted();
    const response = await claude().beta.messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: EFFORT },
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: allTools(),
        messages,
        ...fallback,
      },
      { signal },
    );
    usage.input += response.usage.input_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    usage.output += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      return { reply: "Sorry, I can't help with that one.", steps, usage, model: MODEL };
    }
    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0 || response.stop_reason === "max_tokens") {
      const reply = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      return { reply: reply || "Done.", steps, usage, model: MODEL };
    }

    const results = await Promise.all(
      toolUses.map(async (t): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const input = (t.input ?? {}) as Record<string, unknown>;
        try {
          const { text, summary } = await runTool(t.name, input);
          const step = { tool: t.name, input, ok: true, summary };
          steps.push(step);
          onStep(step);
          return { type: "tool_result", tool_use_id: t.id, content: text.slice(0, 20_000) };
        } catch (err) {
          const step = { tool: t.name, input, ok: false, summary: String(err instanceof Error ? err.message : err) };
          steps.push(step);
          onStep(step);
          return { type: "tool_result", tool_use_id: t.id, content: step.summary, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { reply: "That took too many steps. Please try again with one request at a time.", steps, usage, model: MODEL };
}
