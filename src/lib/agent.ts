import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { allLoads, demoGeneration, detention, findLoad, hhmm, markChanged } from "./loads";
import { isToolkitTool, payoutStatus, runToolkit, runToolkitJson, sendPayout, toolkitTools } from "./paypal";
import { recentActivity } from "./paypal-sdk";

// A small, fast model by default (good enough for short tool-calling turns
// spoken by a driver); set AI_MODEL_NAME to a larger model for more judgement.
const MODEL = process.env.AI_MODEL_NAME || "claude-haiku-5-5";
const EFFORT = (process.env.AI_MODEL_EFFORT || "low") as "low" | "medium" | "high";
const MAX_ROUNDS = 8;
const MAX_LUMPER = 500; // a demo guard, not a business rule

let client: Anthropic | null = null;
const ai = () => (client ??= new Anthropic({ apiKey: process.env.AI_SERVICE_API_KEY }));

// Fixed text: no dates, ids or user data, so the cached prefix never changes.
const SYSTEM = `You are DockTab, a hands-free money assistant for an owner-operator truck driver. The driver talks to you while working, often at a dock. Everything runs in the PayPal sandbox.

What you can do:
- Bill detention: call bill_detention with the load id. It works out the billable time from the truck's arrival, the appointment and the free time in the rate confirmation, then creates and sends a PayPal invoice to the broker. Never invent amounts or times; they come from the tool. When the driver asks to bill, call it right away without asking for confirmation, even if the truck is still at the dock: the invoice covers detention up to now.
- One invoice per load. If the load already has an open invoice, bill_detention refuses and returns the invoiced amount and the detention so far. Tell the driver what was already billed, and offer to update it if the detention has grown.
- Invoice amounts are fixed when billed, but the detention clock keeps running while the truck is at the dock. Always give an invoice's amount from invoice_amount or get_invoice, and the current detention from detention_now. Never report one as the other.
- Update an invoice to the detention so far: when the driver asks for this (for example "bill the extra time" or "update the invoice"), call cancel_invoice on the load's open invoice, then bill_detention for the load. Say the new amount.
- Cancel an invoice: call cancel_invoice when the driver asks to cancel or void one, for example a duplicate or a wrong amount. When the driver names the load or the invoice, cancel right away without asking for confirmation. Find the id with loads or list_invoices. If several open invoices could match and the driver did not say which, ask. Paid invoices cannot be cancelled.
- Paid another way: when the driver says a broker paid an invoice outside PayPal (check, cash, bank or wire transfer), call record_payment on it right away so PayPal shows it as paid. Do not cancel it.
- Pay a lumper: call pay_lumper with the load id and the amount the driver says. It sends a PayPal payout. When the driver states an amount the lumper wants for a load (for example "lumper wants 150 dollars for load 1042"), that is the request: pay right away without asking for confirmation. Do not pay when no amount is given or the driver is only asking about a payment. If the load's lumper was already paid, pay_lumper refuses: tell the driver what was paid and when, and pay again with pay_again only if the driver then confirms a second payment. A payout cannot be taken back.
- Answer money questions: use loads, list_invoices and get_invoice to say what is paid, sent or overdue, and paypal_activity to confirm what money actually moved in or out of the PayPal account. paypal_activity can lag a few hours behind; if a payment is not there yet, say so and give the time the data is from. Use send_invoice_reminder when the driver asks to chase a broker.
- loads lists the driver's loads, where the truck is, each load's invoice and lumper payout; call it first when the driver does not name a load or an invoice.
- Never tell the driver to do something in PayPal that one of your tools can do. If a tool fails, say what failed and offer to try again.

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
    description:
      "Pay the lumper (unloading crew) for a load with a PayPal payout. Only when the driver asks and gives the amount. Refuses if the load's lumper was already paid, unless pay_again is true.",
    input_schema: {
      type: "object",
      properties: {
        load_id: { type: "string", description: "Load id, for example DT-1042" },
        amount: { type: "string", description: "Amount in US dollars, for example 150.00" },
        pay_again: {
          type: "boolean",
          description: "true only when the driver has confirmed a second lumper payment for a load that was already paid",
        },
      },
      required: ["load_id", "amount", "pay_again"],
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
  {
    name: "cancel_invoice",
    description:
      "Cancel a sent, unpaid PayPal invoice for one of the driver's loads, for example a duplicate, a wrong amount, or before re-billing detention up to now. PayPal tells the broker it was cancelled. Paid invoices cannot be cancelled.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string", description: "PayPal invoice id, for example INV2-ABCD-EFGH-IJKL-MNOP" },
        reason: { type: "string", description: "Short note for the broker, for example \"Duplicate invoice\"" },
      },
      required: ["invoice_id", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "record_payment",
    description:
      "Mark a sent, unpaid PayPal invoice for one of the driver's loads as paid in full outside PayPal, for example by check or bank transfer.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string", description: "PayPal invoice id, for example INV2-ABCD-EFGH-IJKL-MNOP" },
        method: { type: "string", enum: ["CHECK", "CASH", "BANK_TRANSFER", "WIRE_TRANSFER", "OTHER"], description: "How the broker paid" },
        note: { type: "string", description: "Short note, for example \"Check received at the office\"" },
      },
      required: ["invoice_id", "method", "note"],
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

type ToolOut = { text: string; summary: string };

// Two requests billing the same load at once share one PayPal call, so a load
// never gets two invoices.
const billing = new Map<string, Promise<ToolOut>>();
export function billDetention(loadId: string): Promise<ToolOut> {
  const key = loadId.trim().toLowerCase();
  let p = billing.get(key);
  if (!p) {
    p = createDetentionInvoice(loadId).finally(() => billing.delete(key));
    billing.set(key, p);
  }
  return p;
}

async function createDetentionInvoice(loadId: string): Promise<ToolOut> {
  const load = findLoad(loadId);
  if (!load) return { text: json({ error: `no load ${loadId}` }), summary: `No load ${loadId}` };
  if (load.invoiceId) {
    // An invoice cancelled in PayPal itself no longer blocks billing.
    const cur = await runToolkitJson<{ status?: unknown }>("get_invoice", { invoice_id: load.invoiceId }).catch(() => null);
    if (cur?.status === "CANCELLED") {
      load.invoiceId = load.invoiceStatus = load.invoiceAmount = load.invoiceHours = undefined;
    } else if (typeof cur?.status === "string") {
      load.invoiceStatus = cur.status;
    }
  }
  if (load.invoiceId) {
    const now = detention(load);
    return {
      text: json({
        error: "already invoiced",
        invoice_id: load.invoiceId,
        status: load.invoiceStatus,
        invoice_amount: load.invoiceAmount,
        invoice_hours: load.invoiceHours,
        detention_now: now ? { amount: now.amount, billable_hours: now.billableHours, still_at_dock: now.stillAtDock } : null,
        how_to_update: "if the driver asks, cancel_invoice this invoice, then bill_detention again",
      }),
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
  load.invoiceAmount = d.amount;
  load.invoiceHours = d.billableHours;
  markChanged();
  return {
    text: json({ invoice_id: id, status: "SENT", invoice_amount: d.amount, broker: load.broker, detention: d, timeline }),
    summary: `Invoice ${id}: $${d.amount} to ${load.broker} for ${d.billableHours} h`,
  };
}

type InvoiceRow = {
  id: string;
  status: string;
  amount?: { value?: string };
  detail?: { reference?: string; metadata?: { create_time?: string } };
};
// Only sent, unpaid invoices can be cancelled.
const CANCELLABLE = new Set(["SENT", "UNPAID"]);
const refOf = (i: InvoiceRow) => (i.detail?.reference ?? "").toUpperCase();

/** Invoices for the demo loads, newest first. */
async function demoInvoices(): Promise<InvoiceRow[]> {
  const res = await runToolkitJson<{ invoices?: InvoiceRow[]; items?: InvoiceRow[] }>("list_invoices", { page_size: 100 });
  const ids = new Set(allLoads().map((l) => l.id.toUpperCase()));
  return (res?.invoices ?? res?.items ?? [])
    .filter((i) => ids.has(refOf(i)))
    .sort((a, b) => (b.detail?.metadata?.create_time ?? "").localeCompare(a.detail?.metadata?.create_time ?? ""));
}

async function cancelInPayPal(id: string, note: string, tellBroker: boolean): Promise<void> {
  await runToolkit("cancel_sent_invoice", { invoice_id: id, note, send_to_recipient: tellBroker });
  // The toolkit reports some failures as text, so check the result in PayPal.
  const after = await runToolkitJson<{ status?: unknown }>("get_invoice", { invoice_id: id });
  if (after.status !== "CANCELLED") throw new Error(`PayPal did not cancel invoice ${id}`);
}

// Each demo session starts with DT-1042 and DT-1047 unbilled and the
// Indianapolis load (DT-1039) billed once, still unpaid, so "has Prairie
// paid?" has a real answer and a reminder to send. Earlier sessions leave their
// invoices open in the sandbox, so cancel those quietly (no email to the
// broker): otherwise the broker would hold two open invoices for one load.
let seeding: Promise<unknown> | null = null;
let seededGeneration = -1;
export const seedDemo = () => {
  const g = demoGeneration();
  if (g !== seededGeneration) {
    seededGeneration = g;
    seeding = null;
  }
  return (seeding ??= (async () => {
    const open = (await demoInvoices()).filter((i) => CANCELLABLE.has(i.status));
    const keep = open.find((i) => refOf(i) === "DT-1039");
    for (const inv of open) {
      if (inv === keep || findLoad(refOf(inv))?.invoiceId === inv.id) continue;
      await cancelInPayPal(inv.id, "Replaced by a new DockTab demo session", false).catch((err) =>
        console.error(`demo tidy: could not cancel ${inv.id}`, err),
      );
    }
    const load = findLoad("DT-1039");
    if (!load || load.invoiceId) return;
    if (keep) {
      load.invoiceId = keep.id;
      load.invoiceStatus = keep.status;
      load.invoiceAmount = keep.amount?.value;
      return;
    }
    await billDetention("DT-1039");
  })().catch((err) => {
    seeding = null;
    console.error("demo seed failed", err);
  }));
};

// Looks up an invoice the driver wants to change: it must exist, belong to one
// of the driver's loads and still be sent and unpaid.
async function openInvoice(
  invoiceId: string,
  verb: string,
): Promise<{ id: string; inv: InvoiceRow; load: NonNullable<ReturnType<typeof findLoad>> } | ToolOut> {
  const id = invoiceId.trim().toUpperCase();
  const inv = await runToolkitJson<InvoiceRow & { status?: unknown }>("get_invoice", { invoice_id: id }).catch(() => null);
  if (!inv || typeof inv.status !== "string") {
    return { text: json({ error: `PayPal has no invoice ${id}` }), summary: `No invoice ${id}` };
  }
  const load = findLoad(refOf(inv));
  if (!load) return { text: json({ error: "that invoice is not for one of the driver's loads" }), summary: "Not a DockTab invoice" };
  if (!CANCELLABLE.has(inv.status)) {
    return {
      text: json({ error: `cannot ${verb} an invoice that is ${inv.status}`, invoice_id: id, status: inv.status }),
      summary: `${id} is ${inv.status.toLowerCase().replaceAll("_", " ")}, not changed`,
    };
  }
  return { id, inv, load };
}

async function recordPayment(invoiceId: string, method: string, note: string): Promise<ToolOut> {
  const found = await openInvoice(invoiceId, "record a payment on");
  if ("text" in found) return found;
  const { id, inv, load } = found;
  const value = inv.amount?.value;
  await runToolkit("record_payment_for_invoice", {
    invoice_id: id,
    method,
    note: note.slice(0, 200),
    payment_date: new Date().toISOString().slice(0, 10),
    ...(value ? { amount: { currency_code: "USD", value } } : {}),
  });
  const after = await runToolkitJson<{ status?: unknown }>("get_invoice", { invoice_id: id });
  if (after.status !== "MARKED_AS_PAID" && after.status !== "PAID") throw new Error(`PayPal did not record the payment on ${id}`);
  if (load.invoiceId === id) load.invoiceStatus = String(after.status);
  markChanged();
  return {
    text: json({ invoice_id: id, load: load.id, status: after.status, amount: value, method }),
    summary: `Recorded $${value ?? "?"} paid by ${method.toLowerCase().replaceAll("_", " ")} on ${id}`,
  };
}

async function cancelInvoice(invoiceId: string, reason: string): Promise<ToolOut> {
  const found = await openInvoice(invoiceId, "cancel");
  if ("text" in found) return found;
  const { id, inv, load } = found;
  await cancelInPayPal(id, reason.slice(0, 200) || "Cancelled by the carrier", true);
  if (load.invoiceId === id) {
    // If PayPal still holds another open invoice for this load, that one is
    // now the load's invoice; otherwise the load can be billed again.
    const other = (await demoInvoices().catch(() => [])).find((i) => refOf(i) === load.id && CANCELLABLE.has(i.status));
    load.invoiceId = other?.id;
    load.invoiceStatus = other?.status;
    load.invoiceAmount = other?.amount?.value;
    load.invoiceHours = undefined;
  }
  markChanged();
  return {
    text: json({
      cancelled: id,
      load: load.id,
      amount: inv.amount?.value,
      load_open_invoice: load.invoiceId ? { id: load.invoiceId, amount: load.invoiceAmount } : null,
    }),
    summary: `Cancelled ${id} ($${inv.amount?.value ?? "?"}) for ${load.id}`,
  };
}

async function payLumper(loadId: string, amount: string, payAgain: boolean): Promise<ToolOut> {
  const load = findLoad(loadId);
  if (!load) return { text: json({ error: `no load ${loadId}` }), summary: `No load ${loadId}` };
  const value = Number(String(amount).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LUMPER) {
    return { text: json({ error: `amount must be between 0 and ${MAX_LUMPER} dollars` }), summary: "Amount refused" };
  }
  if (load.lumper && !payAgain) {
    return {
      text: json({
        error: "lumper already paid for this load",
        paid: load.lumper.amount,
        at: load.lumper.at,
        status: load.lumper.status,
        how_to_pay_again: "only if the driver confirms a second payment, call pay_lumper with pay_again true",
      }),
      summary: `${load.id}: lumper already paid, not paid again`,
    };
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
    detention_now: detention(l),
    invoice: l.invoiceId
      ? { id: l.invoiceId, status: l.invoiceStatus, invoice_amount: l.invoiceAmount, invoice_hours: l.invoiceHours }
      : null,
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
      return payLumper(String(input.load_id), String(input.amount), input.pay_again === true);
    case "cancel_invoice":
      return cancelInvoice(String(input.invoice_id), String(input.reason ?? ""));
    case "record_payment":
      return recordPayment(String(input.invoice_id), String(input.method), String(input.note ?? ""));
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
    const response = await ai().beta.messages.create(
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
