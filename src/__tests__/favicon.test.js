import { beforeEach, describe, expect, it } from "vitest";
import {
  applyFavicon,
  FAVICON_DEV,
  FAVICON_PROD,
  faviconHref,
} from "../favicon.js";

describe("faviconHref", () => {
  it("returns the dev icon when running locally", () => {
    expect(faviconHref(true)).toBe(FAVICON_DEV);
  });

  it("returns the production icon otherwise", () => {
    expect(faviconHref(false)).toBe(FAVICON_PROD);
  });

  it("uses two distinct files so the tabs cannot be confused", () => {
    expect(FAVICON_DEV).not.toBe(FAVICON_PROD);
  });
});

describe("applyFavicon", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("creates the icon link when the document has none", () => {
    const link = applyFavicon(document, true);

    expect(document.head.querySelectorAll("link[rel='icon']")).toHaveLength(1);
    expect(link.getAttribute("href")).toBe(FAVICON_DEV);
    expect(link.getAttribute("type")).toBe("image/svg+xml");
  });

  it("reuses the link already declared in index.html rather than adding a second", () => {
    const existing = document.createElement("link");
    existing.rel = "icon";
    existing.href = FAVICON_PROD;
    document.head.appendChild(existing);

    const link = applyFavicon(document, true);

    expect(link).toBe(existing);
    expect(document.head.querySelectorAll("link[rel='icon']")).toHaveLength(1);
    expect(link.getAttribute("href")).toBe(FAVICON_DEV);
  });

  it("leaves the production icon in place outside dev", () => {
    const link = applyFavicon(document, false);
    expect(link.getAttribute("href")).toBe(FAVICON_PROD);
  });
});
