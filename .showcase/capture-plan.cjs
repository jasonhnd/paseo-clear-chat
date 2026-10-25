"use strict";

// Published documentation and the upcoming README use separate inventories.
function createCapturePlan(readme) {
  const groups = new Map();
  for (const match of readme.matchAll(/\b(?:src|srcset)="((?:docs\/)?images\/([a-z0-9-]+)-(light|dark)\.png)"/g)) {
    const [, file, id, theme] = match;
    const directory = id === "compare" || id === "hero" ? "images" : "docs/images";
    if (file !== `${directory}/${id}-${theme}.png`) throw new Error(`Unexpected screenshot location: ${file}`);
    if (!groups.has(id)) groups.set(id, { id });
    groups.get(id)[theme] = file;
  }
  if (!groups.size) throw new Error("The README has no screenshot references.");
  for (const group of groups.values()) {
    if (!group.light || !group.dark) throw new Error(`Missing screenshot theme for ${group.id}`);
  }
  return [...groups.values()];
}

const pair = (id, width, height, deviceScaleFactor, detail) => ({
  id, light: `${id === "hero" ? "images" : "docs/images"}/${id}-light.png`,
  dark: `${id === "hero" ? "images" : "docs/images"}/${id}-dark.png`,
  viewport: { width, height }, deviceScaleFactor, detail,
});
const readmeV2Groups = [
  pair("hero", 2000, 1016, 1, "side"),
  pair("phone-timeline", 390, 460, 3),
  pair("phone-details", 390, 900, 3, "sheet"),
  pair("phone-menu", 390, 460, 3, "menu"),
  pair("ipad-popover", 834, 1194, 2, "popover"),
  pair("ipad-side", 1194, 834, 2, "side"),
];
const heroCapture = {
  marginX: 48, marginY: 40, gap: 48,
  desktop: { width: 1336, height: 936, textScale: 2.5, detailWidth: 736 },
  phone: { width: 490, height: 1200, displayWidth: 520, textScale: 2.35 },
};
const phoneGroups = readmeV2Groups.filter(group => group.id.startsWith("phone-"));
function withPhoneGroups(groups) {
  return [...groups, ...phoneGroups.filter(phone => !groups.some(group => group.id === phone.id))];
}
const demoCapture = { id: "demo", light: "images/demo.gif", width: 1200, height: 800, fps: 12, seconds: 26 };
module.exports = { createCapturePlan, readmeV2Groups, withPhoneGroups, phoneGroups, demoCapture, heroCapture };
