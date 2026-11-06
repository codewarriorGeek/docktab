import { connection } from "next/server";
import { paypalReady } from "@/lib/paypal";

export async function GET() {
  await connection();
  const paypal = paypalReady();
  const claude = Boolean(process.env.AI_SERVICE_API_KEY);
  const ok = paypal && claude;
  return Response.json(
    { ok, paypal, claude, model: process.env.AI_MODEL_NAME ?? "claude-haiku-5-5" },
    { status: ok ? 200 : 503 },
  );
}
