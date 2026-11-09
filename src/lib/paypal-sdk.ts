import "server-only";
import { ApiError, Client, Environment, TransactionSearchController } from "@paypal/paypal-server-sdk";

// PayPal Server SDK (APIMatic-generated), written with the APIMatic Context
// Plugin for PayPal. Used for Transaction Search: what money
// actually moved in and out of the carrier's PayPal account.
//
// The SDK keeps the OAuth token on the client and fetches a new one before it
// expires; oAuthClockSkew makes it renew 5 minutes early. (The Agent Toolkit
// keeps one token for life, which is why paypal.ts rebuilds it.)

let client: Client | null = null;
const sdk = () =>
  (client ??= new Client({
    environment: Environment.Sandbox,
    timeout: 15_000,
    clientCredentialsAuthCredentials: {
      oAuthClientId: process.env.PAYPAL_CLIENT_ID!,
      oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET!,
      oAuthClockSkew: 300,
    },
  }));

export type Activity = {
  date: string;
  kind: "payout" | "payment";
  direction: "in" | "out";
  amount: string;
  currency: string;
  status: string;
  counterparty: string;
  invoiceId?: string;
  note?: string;
  transactionId?: string;
};

// PayPal wants second precision with an offset, and at most 31 days per search.
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const STATUS: Record<string, string> = { S: "completed", P: "pending", D: "denied", V: "reversed" };

export async function recentActivity(days: number): Promise<{ items: Activity[]; refreshedAt?: string }> {
  const span = Math.min(Math.max(Math.round(days) || 7, 1), 31);
  const end = new Date();
  const start = new Date(end.getTime() - span * 86_400_000);
  try {
    const { result } = await new TransactionSearchController(sdk()).searchTransactions({
      startDate: stamp(start),
      endDate: stamp(end),
      fields: "transaction_info,payer_info",
      pageSize: 100,
    });
    // Keep real payments (event group T00: payouts, card and PayPal payments,
    // invoice payments). Holds, releases and balance funding are bookkeeping.
    const payments = (result.transactionDetails ?? []).filter((t) =>
      (t.transactionInfo?.transactionEventCode ?? "").startsWith("T00"),
    );
    const items = payments.map((t): Activity => {
      const info = t.transactionInfo ?? {};
      const value = Number(info.transactionAmount?.value ?? 0);
      const payer = t.payerInfo;
      const name = [payer?.payerName?.givenName, payer?.payerName?.surname].filter(Boolean).join(" ");
      return {
        date: info.transactionInitiationDate ?? "",
        kind: info.transactionEventCode === "T0001" ? "payout" : "payment",
        direction: value < 0 ? "out" : "in",
        amount: Math.abs(value).toFixed(2),
        currency: info.transactionAmount?.currencyCode ?? "USD",
        status: STATUS[info.transactionStatus ?? ""] ?? info.transactionStatus ?? "unknown",
        counterparty: payer?.emailAddress ?? (name || "unknown"),
        invoiceId: info.invoiceId,
        note: info.transactionNote ?? info.transactionSubject,
        transactionId: info.transactionId,
      };
    });
    return { items, refreshedAt: result.lastRefreshedDatetime };
  } catch (err) {
    if (err instanceof ApiError) {
      throw new Error(`PayPal transaction search failed (${err.statusCode})`);
    }
    throw err;
  }
}
