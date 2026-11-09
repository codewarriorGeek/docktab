// Checks PayPal Transaction Search through the PayPal Server SDK (sandbox only).
// Run: node --env-file=.env.local scripts/sdk-check.mjs
import { Client, Environment, TransactionSearchController, ApiError } from "@paypal/paypal-server-sdk";

if (!(process.env.PAYPAL_BASE_URL ?? "").includes("sandbox")) throw new Error("sandbox only");
const client = new Client({
  environment: Environment.Sandbox,
  timeout: 15000,
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
    oAuthClockSkew: 300,
  },
});
const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const end = new Date();
const start = new Date(end.getTime() - 31 * 86400000);
try {
  const { result, statusCode } = await new TransactionSearchController(client).searchTransactions({
    startDate: stamp(start), endDate: stamp(end), fields: "transaction_info,payer_info", pageSize: 100,
  });
  console.log("HTTP", statusCode, "items", result.transactionDetails?.length ?? 0, "refreshed", result.lastRefreshedDatetime);
  for (const t of (result.transactionDetails ?? []).slice(0, 8)) {
    const i = t.transactionInfo ?? {};
    console.log(i.transactionInitiationDate, i.transactionEventCode, i.transactionAmount?.value, i.transactionStatus, t.payerInfo?.emailAddress ?? "", i.invoiceId ?? "");
  }
  console.log("SDK OK");
} catch (err) {
  if (err instanceof ApiError) console.log("ApiError", err.statusCode, String(err.body).slice(0, 300));
  else throw err;
}
