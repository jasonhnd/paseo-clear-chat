/** Remove bold formatting from Hermes's outer terminal result labels only. */
export function terminalResultOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  // Everything between the labels is literal command output, including
  // Markdown and lines that resemble result labels.
  return value.replace(
    /^(terminal result\r?\n- )\*\*output:\*\*([\s\S]*)(\r?\n- )\*\*exit_code:\*\*( -?\d+(?:\r?\n)?)$/,
    "$1output:$2$3exit_code:$4",
  );
}
