"use strict";

// This function is serialized into the new document before the app starts.
function observeFirstScreen({ readySelector }) {
  if (window !== window.top) return;
  const probe = window.__clearChatPerf = { firstScreenMs: null, error: null };
  function check() {
    try {
      const elements = document.querySelectorAll(readySelector);
      const visible = [...elements].some(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 &&
          rect.left < innerWidth && rect.right > 0 && style.visibility === "visible" &&
          style.display !== "none" && element.textContent.trim().length > 0;
      });
      if (visible) {
        requestAnimationFrame(() => {
          if (document.visibilityState !== "visible") {
            probe.error = "The measurement tab was hidden during first-screen timing";
          } else {
            probe.firstScreenMs = performance.now();
          }
        });
      } else {
        requestAnimationFrame(check);
      }
    } catch {
      probe.error = "Invalid ready selector";
    }
  }
  requestAnimationFrame(check);
}

// Find only the timeline's scrolling ancestor; never fall back to the sidebar.
function prepareScroll({ readySelector, scrollSelector }) {
  let element;
  if (scrollSelector) {
    const matches = document.querySelectorAll(scrollSelector);
    if (matches.length !== 1) throw new Error("The scroll selector must match exactly one element");
    element = matches[0];
  } else {
    const rows = [...document.querySelectorAll(readySelector)];
    const row = rows.find(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
    });
    for (let parent = row?.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1) {
        element = parent;
        break;
      }
    }
  }
  if (!element || element.scrollHeight <= element.clientHeight + 1 || element.clientHeight <= 0) {
    throw new Error("No scrollable conversation found; choose a longer conversation or pass --scroll-selector");
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) throw new Error("The conversation scroller is not visible");
  window.__clearChatPerf.scroller = element;
  element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  return { viewportHeight: element.clientHeight, initialScrollHeight: element.scrollHeight };
}

function sampleScroll({ scrollMs }) {
  return new Promise((resolve, reject) => {
    const element = window.__clearChatPerf.scroller;
    const intervals = [];
    let start;
    let previous;
    let direction = -1;
    let movedPixels = 0;
    function frame(now) {
      if (document.visibilityState !== "visible") return reject(new Error("The measurement tab was hidden during scrolling"));
      if (!element.isConnected) return reject(new Error("The conversation scroller was replaced during measurement"));
      if (start === undefined) { start = previous = now; requestAnimationFrame(frame); return; }
      const interval = now - previous;
      previous = now;
      if (interval > 0) intervals.push(interval);
      const before = element.scrollTop;
      const maximum = element.scrollHeight - element.clientHeight;
      const next = Math.max(0, Math.min(maximum, before + direction * element.clientHeight * 2 * interval / 1000));
      element.scrollTo({ top: next, behavior: "instant" });
      movedPixels += Math.abs(element.scrollTop - before);
      if (next <= 0) direction = 1;
      if (next >= maximum) direction = -1;
      if (now - start >= scrollMs) {
        if (!movedPixels) return reject(new Error("The conversation did not scroll"));
        resolve({ intervals, movedPixels, finalScrollHeight: element.scrollHeight });
      } else {
        requestAnimationFrame(frame);
      }
    }
    requestAnimationFrame(frame);
  });
}

module.exports = { observeFirstScreen, prepareScroll, sampleScroll };
