import { connection } from "next/server";
import { seedDemo } from "@/lib/agent";
import { allLoads, detention } from "@/lib/loads";
import { payoutStatus, runToolkitJson } from "@/lib/paypal";

// Dispatcher view: every load with detention so far and live PayPal status for
// its invoice and lumper payout.
// PayPal is asked at most every 10 s, however many people watch the board.
const REFRESH_MS = 10_000;
let refreshed = 0;

export async function GET() {
  await connection();
  await seedDemo();
  const fresh = Date.now() - refreshed < REFRESH_MS;
  if (!fresh) refreshed = Date.now();
  const loads = await Promise.all(
    allLoads().map(async (l) => {
      if (fresh) return { ...l, brokerEmail: undefined, detention: detention(l) };
      if (l.invoiceId) {
        // Error payloads also carry a numeric "status" (the HTTP code), so only
        // a text status is an invoice status.
        const inv = await runToolkitJson<{ status?: unknown }>("get_invoice", { invoice_id: l.invoiceId }).catch(() => null);
        if (typeof inv?.status === "string") l.invoiceStatus = inv.status;
        else console.warn(`board: no invoice status for ${l.id}`);
      }
      if (l.lumper && l.lumper.status !== "SUCCESS") {
        l.lumper.status = await payoutStatus(l.lumper.batchId).catch(() => l.lumper!.status);
      }
      return { ...l, brokerEmail: undefined, detention: detention(l) };
    }),
  );
  return Response.json({ now: new Date().toISOString(), loads }, { headers: { "cache-control": "no-store" } });
}
