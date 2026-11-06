// Component fences belong to plugins that render them, rather than Markdown.
export function containsComponentFence(text: string, delegatedBlocks = ""): boolean {
  const names = new Set(delegatedBlocks.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  names.add("ui");
  names.add("app");
  const checkMath = names.has("math");
  let prose = "";
  let openFence: { marker: string; length: number } | undefined;

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (openFence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1]!.charAt(0) === openFence.marker && closing[1]!.length >= openFence.length) {
        openFence = undefined;
      }
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!opening) {
      if (checkMath) prose += `${line}\n`;
      continue;
    }
    if (checkMath && containsFormula(prose)) return true;
    prose = "";
    const language = (opening[2]!.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
    if (names.has(language)) return true;
    openFence = { marker: opening[1]!.charAt(0), length: opening[1]!.length };
  }
  return checkMath && containsFormula(prose);
}

// Remove matched inline code spans before looking for formula delimiters.
function containsFormula(text: string): boolean {
  let visible = "";
  for (let i = 0; i < text.length;) {
    if (text[i] === "`" && !isEscaped(text, i)) {
      let end = i;
      while (text[end] === "`") end++;
      const length = end - i;
      let close = end;
      while (close < text.length) {
        if (text[close] !== "`") { close++; continue; }
        let after = close;
        while (text[after] === "`") after++;
        if (after - close === length) break;
        close = after;
      }
      if (close < text.length) {
        visible += " ".repeat(close + length - i);
        i = close + length;
        continue;
      }
      visible += text.slice(i, end);
      i = end;
      continue;
    }
    visible += text[i];
    i++;
  }

  for (let i = 0; i < visible.length; i++) {
    if (isEscaped(visible, i)) continue;
    if (visible[i] === "\\" && (visible[i + 1] === "(" || visible[i + 1] === "[")) {
      const closing = visible[i + 1] === "(" ? ")" : "]";
      for (let j = i + 2; j < visible.length - 1; j++) {
        if (visible[j] === "\\" && visible[j + 1] === closing && !isEscaped(visible, j)) return true;
      }
    }
    if (visible[i] !== "$") continue;
    if (visible[i + 1] === "$") {
      for (let j = i + 2; j < visible.length - 1; j++) {
        if (visible[j] === "$" && visible[j + 1] === "$" && !isEscaped(visible, j)) return true;
      }
      i++;
      continue;
    }
    if ((i > 0 && visible[i - 1] === "$") || !visible[i + 1] || /\s/.test(visible[i + 1]!)) continue;
    for (let j = i + 1; j < visible.length; j++) {
      if (visible[j] !== "$" || isEscaped(visible, j)) continue;
      if (visible[j + 1] !== "$" && !/\s/.test(visible[j - 1]!) && !/\d/.test(visible[j + 1] ?? "")) return true;
      break;
    }
  }
  return false;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}
