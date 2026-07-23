import { afterEach, describe, expect, it, vi } from "vitest";
import { devLog } from "../devLog.js";

describe("devLog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards to console.info in dev", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("DEV", true);
    devLog("hello", 1);
    expect(spy).toHaveBeenCalledWith("hello", 1);
  });

  it("does not log when not in dev", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("DEV", false);
    devLog("hello");
    expect(spy).not.toHaveBeenCalled();
  });
});
