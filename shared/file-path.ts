/** Remove line selectors without truncating spaces inside a file name. */
export function stripFileSelector(path: string): string {
  return path.trim().replace(/(?::|\s+)\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, "");
}
