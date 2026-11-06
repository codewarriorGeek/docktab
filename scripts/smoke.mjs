// Sandbox smoke test: proves the PayPal APIs DockTab depends on work with our
// credentials before any app code is written.
//   node --env-file=.env.local scripts/smoke.mjs
// 1. OAuth client-credentials token
// 2. Orders v2: create + capture with a sandbox test card (no buyer login)
// 3. Invoicing v2: create a detention invoice, send it to the broker, read status
// Prints ids and statuses only, never credentials.

const BASE = process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local");
  process.exit(1);
}
if (!BASE.includes("sandbox")) {
  console.error("Refusing to run against a non-sandbox PayPal URL");
  process.exit(1);
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "paypal-request-id": crypto.randomUUID(),
      prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const tokenRes = await fetch(`${BASE}/v1/oauth2/token`, {
  method: "POST",
  headers: { authorization: `Basic ${btoa(`${id}:${secret}`)}`, "content-type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) throw new Error(`token -> ${tokenRes.status}`);
const { access_token: token, scope } = await tokenRes.json();
const scopes = scope.split(" ");
console.log("token ok; invoicing scope:", scopes.some((s) => s.includes("invoicing")));

// Orders v2 with a sandbox test card: create completes the capture directly.
const order = await call(
  "POST",
  "/v2/checkout/orders",
  {
    intent: "CAPTURE",
    purchase_units: [{ description: "Lumper fee, load DT-1042", amount: { currency_code: "USD", value: "150.00" } }],
    payment_source: {
      card: {
        number: process.env.PAYPAL_TEST_CARD ?? "4111111111111111",
        expiry: "2030-12",
        name: "Test Driver",
        security_code: "123",
      },
    },
  },
  token,
);
const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
console.log("order", order.id, order.status, "capture", capture?.id, capture?.status);

// Invoicing v2: draft, send, read back.
const broker = process.env.PAYPAL_BROKER_EMAIL;
const draft = await call(
  "POST",
  "/v2/invoicing/invoices",
  {
    detail: {
      currency_code: "USD",
      note: "Detention at receiver: arrived 07:02, appointment 08:00, released 12:40. 2 h free time.",
      payment_term: { term_type: "NET_10" },
    },
    invoicer: { business_name: "DockTab demo carrier" },
    primary_recipients: [{ billing_info: { email_address: broker } }],
    items: [
      {
        name: "Detention, load DT-1042",
        description: "2 h 38 min billable after free time",
        quantity: "2.63",
        unit_amount: { currency_code: "USD", value: "75.00" },
        unit_of_measure: "HOURS",
      },
    ],
  },
  token,
);
const invoiceId = draft.id ?? draft.href?.split("/").pop();
await call("POST", `/v2/invoicing/invoices/${invoiceId}/send`, { send_to_invoicer: false }, token);
const sent = await call("GET", `/v2/invoicing/invoices/${invoiceId}`, undefined, token);
console.log("invoice", invoiceId, sent.status, sent.amount?.value, sent.amount?.currency_code);
console.log("SMOKE OK");
