"use strict";

// The README is the inventory of published screenshots.
function createCapturePlan(readme) {
  const groups = new Map();
  for (const match of readme.matchAll(/\b(?:src|srcset)="((?:docs\/)?images\/([a-z0-9-]+)-(light|dark)\.png)"/g)) {
    const [, file, id, theme] = match;
    const directory = id === "compare" ? "images" : "docs/images";
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
  return [...groups.values()];
}

const demoCapture = { id: "demo", light: "images/demo.gif", width: 1200, height: 800, fps: 12, seconds: 26 };

module.exports = { createCapturePlan, demoCapture };
