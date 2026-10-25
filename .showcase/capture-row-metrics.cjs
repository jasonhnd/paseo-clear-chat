"use strict";

// DOM geometry is in CSS pixels, independent of screenshot pixel density.
async function rowMetrics(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="tool-summary-text"]')].map(label => {
    const row = label.closest('[data-testid="tool-summary-row"]');
    const card = row.closest('[data-testid^="tool-card-"]');
    const duration = row.querySelector('[data-testid="tool-duration"]');
    const style = getComputedStyle(label);
    const rect = label.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(label);
    const text = range.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const durationRect = duration.getBoundingClientRect();
    const clippedBy = [];
    for (let ancestor = label; ancestor; ancestor = ancestor.parentElement) {
      const bounds = ancestor.getBoundingClientRect();
      const overflow = getComputedStyle(ancestor).overflowY;
      if (/hidden|clip|auto|scroll/.test(overflow) && (text.top < bounds.top || text.bottom > bounds.bottom)) {
        clippedBy.push({ testId: ancestor.dataset.testid || ancestor.tagName, overflow, top: bounds.top, bottom: bounds.bottom });
      }
    }
    return {
      clippedBy,
      label: label.textContent, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
      clientHeight: label.clientHeight, scrollHeight: label.scrollHeight,
      labelTop: rect.top, labelBottom: rect.bottom, textTop: text.top, textBottom: text.bottom,
      cardTop: cardRect.top, cardBottom: cardRect.bottom,
      titleToDuration: durationRect.left - rect.right, inkToDuration: durationRect.left - text.right,
      headerGap: getComputedStyle(row).columnGap,
    };
  }));
}
module.exports = { rowMetrics };
