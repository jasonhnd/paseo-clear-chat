/** Handwritten demo-shop data. No timeline exports or user data are loaded. */
import type { ApprovalRequest, ReasoningTraceData, TaskListData, ToolCalloutData } from "../shared/contracts";

export const PROMPT = "Add a free-shipping message when the cart total reaches $50.";
export const REPLY = "## Ready to review\n\nThe cart now shows **Free shipping** at $50.\n\n- Added the threshold check in `src/cart.ts`.\n- Covered totals below, at, and above $50.\n- All 12 demo tests passed.";
export const CODE = `export function shippingLabel(total: number) {
  return total >= 50
    ? "Free shipping"
    : "Shipping calculated at checkout";
}`;
export const DIFF = `@@ -1,3 +1,5 @@
 export function shippingLabel(total: number) {
-  return "Shipping calculated at checkout";
+  return total >= 50
+    ? "Free shipping"
+    : "Shipping calculated at checkout";
 }`;
export const WRAP_UP = JSON.stringify({
  recap: "## Cart update complete\n\n**Free shipping** now appears at $50. All 12 demo tests passed.",
  ask: "Which checkout detail should we tackle next?",
  actions: [
    { label: "Add a progress bar", message: "Show how much remains until free shipping." },
    { label: "Review the copy", message: "Check the message at each threshold." },
  ],
  blocked: false,
});
export const TASKS: TaskListData = {
  id: "demo-checklist", phaseName: "Checkout polish", tasks: [
    { id: "read", title: "Inspect the cart summary", phase: "Explore", status: "completed", duration: "8s" },
    { id: "edit", title: "Add the free-shipping threshold", phase: "Build", status: "in_progress" },
    { id: "test", title: "Test the threshold boundaries", phase: "Verify", status: "pending" },
    { id: "copy", title: "Publish translated copy", phase: "Follow-up", status: "blocked", blockerReason: "Demo translation text is not available yet." },
  ],
};
export const APPROVAL: ApprovalRequest = {
  id: "demo-approval", toolName: "bash", title: "Run the demo build", riskLevel: "low",
  rationale: "Writes generated files only inside the demo output directory.",
  command: "npm run build", targetPath: "/workspace/demo-shop/dist", cwd: "/workspace/demo-shop",
  timeoutSeconds: 60, status: "pending", timestamp: "2026-01-01T12:00:00Z",
};
export const REASONING: ReasoningTraceData = {
  id: "demo-reasoning", agentModel: "Demo model", durationMs: 3200, totalTokens: 280, status: "completed",
  steps: [
    { id: "inspect", number: 1, title: "Find the cart label", summary: "The cart summary owns the shipping message.", content: "Keep the change in the existing shippingLabel helper.", durationMs: 1400, tokenCount: 120, status: "completed" },
    { id: "boundary", number: 2, title: "Check the boundary", summary: "A total of exactly $50 qualifies.", content: "Use an inclusive comparison and test both sides of the threshold.", durationMs: 1800, tokenCount: 160, status: "completed" },
  ],
};
const completed = { status: "completed" as const, durationMs: 84 };
export const CALLS: Record<string, ToolCalloutData> = {
  bash: { ...completed, id: "demo-bash", tool: "bash", title: "npm test", command: "npm test", exitCode: 0, durationMs: 1250,
    shell: { command: "npm test", cwd: "/workspace/demo-shop", exitCode: 0, stdout: "PASS test/cart.test.ts\n  below $50: standard shipping\n  exactly $50: free shipping\n  above $50: free shipping\n\n12 tests passed" } },
  git: { ...completed, id: "demo-git", tool: "git", title: "git diff --stat", command: "git diff --stat", shell: { command: "git diff --stat", stdout: "src/cart.ts       | 4 +++-\ntest/cart.test.ts | 9 +++++++++\n2 files changed, 12 insertions(+), 1 deletion(-)" } },
  read: { ...completed, id: "demo-read", tool: "read", title: "Read src/cart.ts", filePath: "src/cart.ts", language: "typescript", lineRange: "1-5", code: CODE },
  edit: { ...completed, id: "demo-edit", tool: "edit", title: "Edit src/cart.ts", filePath: "src/cart.ts", diff: DIFF, changes: { added: 3, removed: 1 } },
  image: { ...completed, id: "demo-image", tool: "read", title: "Read assets/checkout.png", filePath: "assets/checkout.png" },
  thinking: { ...completed, id: "demo-thinking", tool: "thinking", title: "Check the shipping rule", thinking: { text: "The threshold includes exactly $50. Keep the existing message below that amount.", status: "completed", tokenCount: 120, steps: ["Locate the cart helper", "Use total >= 50", "Test the boundary values"] } },
  mcp: { ...completed, id: "demo-mcp", tool: "mcp", title: "catalog.lookup", mcp: { server: "demo-catalog", tool: "lookup", transport: "stdio", arguments: { sku: "sample-mug" }, result: '{"name":"Sample mug","price":25,"currency":"USD"}' } },
  eval: { ...completed, id: "demo-eval", tool: "eval", title: "Check threshold values", cells: [{ title: "shipping boundary", language: "javascript", code: "[49, 50, 75].map(total => ({\n  total, freeShipping: total >= 50,\n}));", output: '[{"total":49,"freeShipping":false},\n {"total":50,"freeShipping":true},\n {"total":75,"freeShipping":true}]' }] },
  ask: { ...completed, id: "demo-ask", tool: "ask", title: "Choose the shipping message", askOptions: [{ id: "short", label: "Free shipping", description: "Keep the cart summary concise.", recommended: true }, { id: "long", label: "Your order ships for free", description: "Use a more conversational message." }], askAnswer: ["Free shipping"] },
  task: { ...completed, id: "demo-task", tool: "task", title: "2 subagents", subagent: { context: "Review the demo cart change using synthetic examples only.", agents: [ { name: "Boundary reviewer", agentType: "review", task: "Check totals of $49, $50, and $75.", status: "completed" }, { name: "Copy reviewer", agentType: "review", task: "Check that the shipping message is concise.", status: "completed" } ] } },
  subagent: { ...completed, id: "demo-subagent", tool: "sub_agent", title: "Review the cart tests", subagent: { agents: [{ name: "Test reviewer", agentType: "review", model: "Demo model", task: "Verify the free-shipping boundary cases in test/cart.test.ts.", status: "completed" }] } },
  search: { ...completed, id: "demo-search", tool: "search", title: "shippingLabel", search: { query: "shippingLabel", scope: "src/", count: 2, truncated: false, results: [ { label: "src/cart.ts:1", path: "src/cart.ts", preview: "export function shippingLabel(total: number) {" }, { label: "src/checkout.ts:8", path: "src/checkout.ts", preview: "const label = shippingLabel(cart.total);" } ] } },
  fetch: { ...completed, id: "demo-fetch", tool: "fetch", title: "Fetch shipping policy", fetch: { url: "https://example.com/shipping", title: "Demo shipping policy", preview: "Free shipping starts at $50.\nThe threshold applies to the cart subtotal.\nGift cards do not count toward the subtotal." } },
  websearch: { ...completed, id: "demo-web-search", tool: "web_search", title: "free shipping checkout copy", fetch: { query: "free shipping checkout copy", url: "https://example.com/checkout-guide", title: "Demo checkout writing guide", preview: "Use a short, specific message.\nShow the shipping threshold near the total.\nKeep currency formatting consistent." }, search: { query: "free shipping checkout copy", scope: "web", count: 1, truncated: false, results: [{ label: "Demo checkout writing guide", url: "https://example.com/checkout-guide", preview: "Short messages for cart summaries." }] } },
  discovery: { ...completed, id: "demo-discovery", tool: "tool_search", title: "browser", toolSearch: { query: "browser", text: "browser.open: open a demo page\nbrowser.capture: capture a demo preview" } },
  plan: { ...completed, id: "demo-plan", tool: "plan", title: "Checkout plan", checklist: TASKS },
  todo: { ...completed, id: "demo-todo", tool: "todo", title: "Checkout checklist", checklist: { ...TASKS, phaseName: "Verification", tasks: TASKS.tasks.slice(0, 3) } },
  failure: { id: "demo-failure", tool: "bash", title: "npm run test:preview", status: "failed", durationMs: 620, exitCode: 1, error: "Preview server is unavailable. Start the demo server and retry.", command: "npm run test:preview", shell: { command: "npm run test:preview", exitCode: 1, stderr: "Error: demo preview is not running on localhost:4173.\nStart the demo server and retry." } },
  github: { ...completed, id: "demo-github", tool: "github", title: "Demo checks", github: { op: "checks", subject: "Demo checkout update", rows: [{ label: "Cart tests", value: "12 passed", tone: "ok" }, { label: "Type check", value: "passed", tone: "ok" }] } },
};
export const JOB_NOTICE = `<system-notice>\nBackground job CopyReviewer has completed.\n<task-result id="CopyReviewer" agent="task" status="completed" duration="12s">\n<meta lines="2" size="80B" />\n<preview>Shipping copy is concise. All demo boundary cases are covered.</preview>\n</task-result>\n</system-notice>`;

/** Extended synthetic output used only by the animated README capture. */
const demoOutput = Array.from({ length: 90 }, (_, index) =>
  `PASS cart case ${String(index + 1).padStart(2, "0")} · $${index + 10}`,
).join("\n") + "\n\n90 tests passed";
export const DEMO_STEPS: ToolCalloutData[] = [CALLS.search!, CALLS.read!, CALLS.edit!, {
  ...CALLS.bash!, id: "demo-motion-tests", input: "npm test", stdout: demoOutput,
  shell: { command: "npm test", stdout: demoOutput, exitCode: 0 },
}];
