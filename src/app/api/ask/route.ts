import { z } from "zod";
import { ask } from "@/lib/agent";
import { allow } from "@/lib/rate-limit";

// Streams newline-delimited JSON so the driver sees each PayPal call as it happens:
//   {"type":"step","tool":"bill_detention","ok":true,"summary":"..."}
//   {"type":"done","reply":"...","steps":[...],"ms":1234}
//   {"type":"error","error":"..."}
const Request = z.object({
  message: z.string().trim().min(1).max(500),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(2000) }))
    .max(20)
    .default([]),
});

export async function POST(request: Request) {
  // Apache appends the real client address last; earlier entries can be forged.
  const ip = request.headers.get("x-forwarded-for")?.split(",").pop()?.trim() || "local";
  const limit = allow(ip);
  if (!limit.ok) return Response.json({ error: limit.reason }, { status: 429 });

  const parsed = Request.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    limit.release();
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const { message, history } = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      const started = Date.now();
      try {
        const result = await ask(history, message, (step) => send({ type: "step", ...step }), request.signal);
        console.log("ask", { model: result.model, ms: Date.now() - started, ...result.usage });
        // Model name and token usage stay in the server log, not in the response.
        send({ type: "done", reply: result.reply, steps: result.steps, ms: Date.now() - started });
      } catch (err) {
        console.error("ask failed", err);
        send({ type: "error", error: "Something went wrong talking to PayPal or the AI service. Please try again." });
      } finally {
        limit.release();
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
