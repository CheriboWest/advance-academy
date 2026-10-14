/**
 * Shared date-injection helper for the CV Optimizer agents (Structure, Bullets).
 *
 * Mirrors the private todayInstruction() in cv-optimizer.service.ts. It is
 * duplicated here intentionally: the original is module-private and the agent
 * pipeline is kept self-contained. Collapse the two into one source if the
 * monolith path is ever retired.
 *
 * Date is computed at call time — never baked into the prompt constants.
 */
export function todayInstruction(): string {
  const today = new Date().toISOString().split('T')[0];
  return `Today's date is ${today}. Evaluate all dates in the CV relative to this date. Do not flag any date before today as future or unrealistic.`;
}
