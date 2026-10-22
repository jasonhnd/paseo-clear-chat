import { stripFileSelector } from "../shared/file-path";

/** Conservative local path recognition; ambiguous bare words stay ordinary prose. */
const ROOTED = /^(?:\/(?!\/)|~\/|\.{1,2}[\\/]|[a-z]:[\\/])/i;
const FILE_END = /\.[a-z0-9][a-z0-9_-]{0,15}(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?$/i;

export function localFilePath(value: string, explicit = false): string | null {
  if (!value || value !== value.trim() || /[\x00-\x1f<>|"?*]/.test(value) || value.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(stripFileSelector(value)) && !/^[a-z]:[\\/]/i.test(value)) return null;
  if (value.includes("://") || /^[./~\\]+$/.test(value)) return null;
  if (ROOTED.test(value)) return value;
  if (/[\\/]/.test(value) && FILE_END.test(value)) return value;
  return explicit && FILE_END.test(value) ? value : null;
}

export function isAbsoluteFilePath(value: string): boolean {
  return /^(?:\/|~\/|[a-z]:[\\/])/i.test(value);
}

/** A path prefix fixes the start; an extension bounds filenames containing spaces. */
export function matchFilePath(source: string, index: number): string | null {
  if (/[\p{L}\p{M}\p{N}_./\\-]/u.test(source[index - 1] ?? "")) return null;
  const rest = source.slice(index);
  if (!/^(?:\/(?!\/)|~\/|\.{1,2}[\\/]|[a-z]:[\\/]|[\w.-]+[\\/])/i.test(rest)) return null;
  const token = rest.match(/^[^\s<>"'`()\[\]{},;!?=\u2018\u2019\u201c\u201d\u3001\u3002\uff01\uff08\uff09\uff0c\uff0e\uff1a\uff1b\uff1f]+/)?.[0]?.replace(/[.:]+$/, "");
  if (!token) return null;
  // Prefer a complete single token to avoid consuming the following sentence.
  if (FILE_END.test(token)) return localFilePath(token);
  const spaced = rest.match(/^[^\r\n<>"'`()\[\]{},;!?=\u2018\u2019\u201c\u201d\u3001\u3002\uff01\uff08\uff09\uff0c\uff0e\uff1a\uff1b\uff1f]*?\.[a-z0-9][a-z0-9_-]{0,15}(?=$|[\s),;!?\u2018\u2019\u201c\u201d\u3001\u3002\uff01\uff08\uff09\uff0c\uff0e\uff1a\uff1b\uff1f]|\.(?:\s|$))/i)?.[0];
  if (spaced && ROOTED.test(rest) && !/(?:\s[./~]|:\/\/)/.test(spaced)) return localFilePath(spaced);
  return ROOTED.test(token) ? localFilePath(token) : null;
}
