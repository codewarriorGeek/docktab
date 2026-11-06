// Sends one sandbox payout (lumper fee) from the merchant account and reads its status.
const BASE = process.env.PAYPAL_BASE_URL;
if (!BASE.includes("sandbox")) throw new Error("sandbox only");
const auth = btoa(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`);
const { access_token } = await (await fetch(`${BASE}/v1/oauth2/token`, { method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json();
const h = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };
const res = await fetch(`${BASE}/v1/payments/payouts`, { method: "POST", headers: h, body: JSON.stringify({
  sender_batch_header: { sender_batch_id: crypto.randomUUID(), email_subject: "Lumper fee", email_message: "Unloading, load DT-1042" },
  items: [{ recipient_type: "EMAIL", receiver: process.env.PAYPAL_BROKER_EMAIL, amount: { value: "150.00", currency: "USD" }, note: "Lumper fee, load DT-1042" }],
}) });
const batch = await res.json();
console.log(res.status, batch.batch_header?.payout_batch_id, batch.batch_header?.batch_status, batch.name ?? "", batch.message ?? "");
await new Promise((r) => setTimeout(r, 5000));
const get = await (await fetch(`${BASE}/v1/payments/payouts/${batch.batch_header.payout_batch_id}`, { headers: h })).json();
console.log(get.batch_header?.batch_status, get.items?.[0]?.transaction_status);
