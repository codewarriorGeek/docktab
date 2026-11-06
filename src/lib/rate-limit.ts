import "server-only";

// In-memory limits for the public demo (one server process). They protect the
// PayPal sandbox and AI model quotas from casual abuse; they are not a security boundary.
const PER_IP = Number(process.env.RATE_LIMIT_PER_HOUR ?? 40);
// Across all visitors, so many addresses together cannot drain the AI model quota.
const GLOBAL_PER_HOUR = Number(process.env.GLOBAL_LIMIT_PER_HOUR ?? 300);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_ASKS ?? 6);
const HOUR = 60 * 60 * 1000;

const hits = new Map<string, number[]>();
let globalHits: number[] = [];
let running = 0;

// Drop addresses with no recent requests so the map does not grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) if (times.every((t) => now - t >= HOUR)) hits.delete(ip);
}, 10 * 60 * 1000).unref();

export function allow(ip: string): { ok: true; release: () => void } | { ok: false; reason: string } {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= PER_IP) {
    return { ok: false, reason: "Too many requests from this connection. Please try again later." };
  }
  globalHits = globalHits.filter((t) => now - t < HOUR);
  if (globalHits.length >= GLOBAL_PER_HOUR) {
    return { ok: false, reason: "DockTab has reached its hourly limit. Please try again a little later." };
  }
  if (running >= MAX_CONCURRENT) {
    return { ok: false, reason: "DockTab is busy right now. Please try again in a minute." };
  }
  recent.push(now);
  hits.set(ip, recent);
  globalHits.push(now);
  running++;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (!released) {
        released = true;
        running--;
      }
    },
  };
}
