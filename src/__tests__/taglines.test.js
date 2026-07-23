import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickRandomTagline, TAGLINES } from "../taglines.js";

describe("taglines", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a pool of 10 taglines", () => {
    expect(TAGLINES).toHaveLength(10);
    for (const t of TAGLINES) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it("always returns a member of the pool", () => {
    expect(TAGLINES).toContain(pickRandomTagline());
  });

  it("uses Math.random to pick (first element at 0)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickRandomTagline()).toBe(TAGLINES[0]);
  });

  it("picks the last element as random approaches 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    expect(pickRandomTagline()).toBe(TAGLINES[TAGLINES.length - 1]);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    pickRandomTagline();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
