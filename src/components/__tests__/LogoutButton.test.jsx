import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LogoutButton from "../LogoutButton.jsx";

describe("LogoutButton", () => {
  it("renders a Log out button and calls onLogout when clicked", () => {
    const onLogout = vi.fn();
    render(<LogoutButton onLogout={onLogout} />);
    const button = screen.getByRole("button", { name: "Log out" });
    fireEvent.click(button);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
