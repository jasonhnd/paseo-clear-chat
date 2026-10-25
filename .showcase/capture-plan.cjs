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

// Phone README shots are browser widths. They stay out of the published README
// inventory until a later card links them, and they never replace an id the
// README already names.
const phoneGroups = [
  {
    id: "phone-timeline",
    light: "docs/images/phone-timeline-light.png",
    dark: "docs/images/phone-timeline-dark.png",
    viewport: { width: 390, height: 640 },
    deviceScaleFactor: 3,
    fit: "content",
  },
  {
    id: "phone-details",
    light: "docs/images/phone-details-light.png",
    dark: "docs/images/phone-details-dark.png",
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 3,
    fit: "viewport",
  },
  {
    id: "phone-menu",
    light: "docs/images/phone-menu-light.png",
    dark: "docs/images/phone-menu-dark.png",
    viewport: { width: 390, height: 700 },
    deviceScaleFactor: 3,
    fit: "content",
  },
];

function withPhoneGroups(groups) {
  const seen = new Set(groups.map(group => group.id));
  return [...groups, ...phoneGroups.filter(group => !seen.has(group.id))];
}

module.exports = { createCapturePlan, withPhoneGroups, phoneGroups };
