export function classifyPollError(message) {
  if (message === "TOKEN_EXPIRED") return { type: "refresh" };
  if (message.startsWith("RATE_LIMITED:")) {
    return {
      type: "retry",
      seconds: Number.parseInt(message.split(":")[1], 10),
    };
  }
  return { type: "error" };
}
