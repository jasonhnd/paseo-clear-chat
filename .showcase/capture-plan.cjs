"use strict";

// README v2 cover. Not referenced by the README body yet, so it is appended
// after the published pairs. Both themes live beside the comparison images.
const EXTRA_GROUPS = [
  { id: "hero", light: "images/hero-light.png", dark: "images/hero-dark.png" },
];

// The README is the inventory of published screenshots.
function createCapturePlan(readme) {
  const groups = new Map();
  for (const match of readme.matchAll(/\b(?:src|srcset)="((?:docs\/)?images\/([a-z0-9-]+)-(light|dark)\.png)"/g)) {
    const [, file, id, theme] = match;
    const directory = id === "compare" || id === "hero" ? "images" : "docs/images";
    if (file !== `${directory}/${id}-${theme}.png`) {
      throw new Error(`Unexpected screenshot location: ${file}`);
    }
    if (!groups.has(id)) groups.set(id, { id });
    groups.get(id)[theme] = file;
  }
  if (!groups.size) throw new Error("The README has no screenshot references.");
  for (const group of groups.values()) {
    if (!group.light || !group.dark) throw new Error(`Missing screenshot theme for ${group.id}`);
  }
  const planned = [...groups.values()];
  for (const extra of EXTRA_GROUPS) {
    if (!planned.some(group => group.id === extra.id)) planned.push({ ...extra });
  }
  return planned;
}

module.exports = { createCapturePlan };
