import { connection } from "next/server";
import { paypalReady } from "@/lib/paypal";

// Public endpoint: returns only a generic status, never which dependency is
// configured or which model is in use. Details go to the server log.
export async function GET() {
  await connection();
  const ok = paypalReady() && Boolean(process.env.AI_SERVICE_API_KEY);
  if (!ok) console.error("health: a required service is not configured");
  return Response.json({ status: ok ? "ok" : "unavailable" }, { status: ok ? 200 : 503 });
}
