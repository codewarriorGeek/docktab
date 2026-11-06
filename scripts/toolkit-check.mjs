// Lists the Agent Toolkit tools DockTab enables and runs one read-only call.
import { PayPalAgentToolkit, ALL_TOOLS_ENABLED } from "@paypal/agent-toolkit/openai";
console.log(Object.fromEntries(Object.entries(ALL_TOOLS_ENABLED).map(([k, v]) => [k, Object.keys(v)])));
const kit = new PayPalAgentToolkit({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  configuration: {
    actions: { invoices: { create: true, list: true, send: true, get: true, sendReminder: true }, orders: { create: true, get: true, capture: true }, transactions: { list: true } },
    context: { sandbox: true },
  },
});
console.log(kit.getTools().map((t) => t.function.name));
const res = await kit.handleToolCall({ id: "t1", type: "function", function: { name: "list_invoices", arguments: JSON.stringify({ page: 1, page_size: 5 }) } });
console.log(String(res.content).slice(0, 400));
