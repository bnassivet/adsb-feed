import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Mock ResizeObserver (not available in jsdom, needed by @tanstack/react-virtual)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      // Fire callback immediately with synthetic entry so virtualizer gets dimensions
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
}

// Mock layout properties for @tanstack/react-virtual (jsdom has no layout engine)
Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return 1000; } });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 192; } });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 192; } });

// getBoundingClientRect must return non-zero dimensions for virtualizer
const origGetBCR = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  const rect = origGetBCR.call(this);
  // If jsdom returns all-zero rect, provide a reasonable default
  if (rect.height === 0 && rect.width === 0) {
    return { ...rect, height: 192, width: 300, top: 0, left: 0, bottom: 192, right: 300, x: 0, y: 0, toJSON: rect.toJSON?.bind(rect) };
  }
  return rect;
};

afterEach(() => {
  cleanup();
});
