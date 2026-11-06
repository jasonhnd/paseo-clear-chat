export function codeBlockWebAddress(code: string): string | undefined {
  const line = code.replace(/\r?\n$/, "");
  if (/[\r\n\u2028\u2029]/u.test(line)) return undefined;
  const address = line.trim();
  if (!address.startsWith("https://") || /\s/u.test(address)) return undefined;
  try {
    const url = new URL(address);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || !host || host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local")) return undefined;
    return address;
  } catch {
    return undefined;
  }
}
