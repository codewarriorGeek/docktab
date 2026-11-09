import "server-only";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";

// PayPal sandbox only. Two paths, both with the same app credentials:
//   - the PayPal Agent Toolkit for invoices and transactions (its tools are
//     handed to the agent directly, and DockTab's own tools call it too)
//   - plain REST for Payouts, which the toolkit does not cover
const BASE = process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
if (!BASE.includes("sandbox")) throw new Error("DockTab only runs against the PayPal sandbox");

export const paypalReady = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

// Toolkit tools the agent may call directly. Creating and sending invoices goes
// through DockTab's bill_detention tool instead, so amounts come from code.
const DIRECT = ["list_invoices", "get_invoice", "send_invoice_reminder", "list_transactions"] as const;

// The toolkit fetches one OAuth token and keeps it for its whole life, so a
// long-running server starts getting 401s once PayPal stops accepting it.
// Rebuild it (which fetches a fresh token) every 30 minutes, and at once on a 401.
const KIT_TTL_MS = 30 * 60_000;
let kit: PayPalAgentToolkit | null = null;
let kitBorn = 0;
const resetToolkit = () => {
  kit = null;
};
const toolkit = () => {
  if (kit && Date.now() - kitBorn > KIT_TTL_MS) kit = null;
  if (!kit) kitBorn = Date.now();
  return (kit ??= new PayPalAgentToolkit({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    configuration: {
      actions: {
        invoices: { create: true, send: true, get: true, list: true, sendReminder: true },
        transactions: { list: true },
      },
      context: { sandbox: true },
    },
  }));
};

// Some toolkit schemas carry defaults computed at load time (list_transactions
// defaults to "now"); drop them so the tool list is byte-identical across
// requests and the prompt cache holds.
function stripDefaults(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripDefaults);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema)
        .filter(([k]) => k !== "default" && k !== "$schema")
        .map(([k, v]) => [k, stripDefaults(v)]),
    );
  }
  return schema;
}

export function toolkitTools() {
  return toolkit()
    .getTools()
    .filter((t) => (DIRECT as readonly string[]).includes(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: (t.function.description ?? "").trim(),
      input_schema: stripDefaults(t.function.parameters) as { type: "object"; [k: string]: unknown },
    }));
}

export const isToolkitTool = (name: string) => (DIRECT as readonly string[]).includes(name);

async function callToolkit(name: string, input: unknown): Promise<string> {
  const result = await toolkit().handleToolCall({
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: JSON.stringify(input ?? {}) },
  });
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

// A rejected token comes back as an error payload, not an exception.
const isAuthFailure = (text: string) =>
  /"status"\s*:\s*401\b|AUTHENTICATION_FAILURE|invalid_token|\b401\b.*unauthori[sz]ed/i.test(text);

// Runs one toolkit tool and returns its JSON text. On a 401 it rebuilds the
// toolkit with a fresh token and tries once more.
export async function runToolkit(name: string, input: unknown): Promise<string> {
  const text = await callToolkit(name, input);
  if (!isAuthFailure(text)) return text;
  console.warn(`paypal: ${name} got 401, refreshing the token`);
  resetToolkit();
  return callToolkit(name, input);
}

export async function runToolkitJson<T>(name: string, input: unknown): Promise<T> {
  const text = await runToolkit(name, input);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} failed: ${text.slice(0, 300)}`);
  }
}

async function token(): Promise<string> {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token request failed (${res.status})`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${await token()}`,
      "content-type": "application/json",
      "paypal-request-id": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${json.message ?? ""}`);
  return json;
}

export type Payout = { batchId: string; status: string };

export async function sendPayout(receiver: string, amount: string, note: string): Promise<Payout> {
  const out = await rest<{ batch_header: { payout_batch_id: string; batch_status: string } }>(
    "POST",
    "/v1/payments/payouts",
    {
      sender_batch_header: { sender_batch_id: crypto.randomUUID(), email_subject: "You have a payment from DockTab" },
      items: [{ recipient_type: "EMAIL", receiver, amount: { value: amount, currency: "USD" }, note }],
    },
  );
  return { batchId: out.batch_header.payout_batch_id, status: out.batch_header.batch_status };
}

export async function payoutStatus(batchId: string): Promise<string> {
  const out = await rest<{ batch_header: { batch_status: string }; items?: { transaction_status?: string }[] }>(
    "GET",
    `/v1/payments/payouts/${batchId}`,
  );
  return out.items?.[0]?.transaction_status ?? out.batch_header.batch_status;
}
