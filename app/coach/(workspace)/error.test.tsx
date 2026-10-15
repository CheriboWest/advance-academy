import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CoachWorkspaceError from "./error";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("coach workspace error boundary", () => {
  it("shows a recoverable message instead of Next's bare error screen, and retries", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    render(<CoachWorkspaceError error={new Error("permission denied for table companies")} reset={reset} />);

    expect(screen.getByText("This page couldn't load")).toBeTruthy();
    // The raw server error is logged, not shown.
    expect(screen.queryByText(/permission denied/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
