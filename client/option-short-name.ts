/** Keep tab labels short while preserving the subject of the question. */
export function optionShortName(title: string, number: number | string): string {
  let name = title.trim().replace(/\?\s*$/, "").trim();
  name = name.replace(/^(?:(?:please\s+)?(?:choose|select|pick)(?:\s+|$)|(?:which|what|when|where|how|who|should|would|could|can|is|are|do|does|did|please)(?:\s+|$)|(?:we|you)\s+(?:want|prefer|like|use)(?:\s+|$)|to\s+(?:use|choose|select|pick)(?:\s+|$)|to(?:\s+|$))+/i, "");
  name = name.replace(/^(?:a|an|the|for|of)\s+/i, "");
  name = name.split(/\s+(?:should|would|could|can|do|does|did|is|are|will)\b|[,:;.!?\n]/i)[0]!.trim();
  if (!name) return `Question ${number}`;
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return name.length > 18 ? `${name.slice(0, 17).trimEnd()}…` : name;
}
