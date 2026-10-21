/** Read provider and RPC errors without coercing objects or exposing metadata. */
export function errorText(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  for (const key of ["message", "error", "text", "detail", "reason"]) {
    const field = fields[key];
    const text = typeof field === "string" ? errorText(field)
      : depth < 1 ? errorText(field, depth + 1) : undefined;
    if (text) return text;
  }
  return undefined;
}
