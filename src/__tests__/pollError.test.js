import { describe, expect, it } from "vitest";
import { classifyPollError } from "../pollError.js";

describe("classifyPollError", () => {
  it("maps TOKEN_EXPIRED to a refresh action", () => {
    expect(classifyPollError("TOKEN_EXPIRED")).toEqual({ type: "refresh" });
  });

  it("maps RATE_LIMITED to a retry action with seconds", () => {
    expect(classifyPollError("RATE_LIMITED:10")).toEqual({
      type: "retry",
      seconds: 10,
    });
  });

  it("maps anything else to an error action", () => {
    expect(classifyPollError("SPOTIFY_ERROR:503")).toEqual({ type: "error" });
  });
});
