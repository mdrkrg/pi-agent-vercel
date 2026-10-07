import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Faq from "./Faq.svelte";

function setup() {
  render(Faq, { sessionId: "test-session" });
  const button = screen.getByRole("button", { name: "Frequently asked questions" });
  return { button, root: button.parentElement! };
}
describe("bottom FAQ", () => {
  it("stays hidden until hovered and closes when the pointer leaves", async () => {
    const { button, root } = setup();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Frequently asked questions" })).toBeNull();
    await fireEvent.pointerEnter(root);
    const panel = screen.getByRole("region", { name: "Frequently asked questions" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel.id).toBe(button.getAttribute("aria-controls"));
    expect(screen.getByText(/APP_API_TOKEN/)).toBeTruthy();
    expect(screen.getByText(/plain text in this tab/)).toBeTruthy();
    expect(screen.getByText(/worker and scheduler/)).toBeTruthy();
    expect(screen.getByText(/Session ID: test-session/)).toBeTruthy();
    expect(panel.textContent).not.toContain("administrator");
    await fireEvent.pointerLeave(root);
    expect(screen.queryByRole("region", { name: "Frequently asked questions" })).toBeNull();
  });
  it("opens on keyboard focus, remains reachable for scrolling, and closes on Escape", async () => {
    const { button, root } = setup();
    button.focus();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Frequently asked questions" })).toBeTruthy(),
    );
    const panel = screen.getByRole("region", { name: "Frequently asked questions" });
    panel.focus();
    await fireEvent.pointerLeave(root);
    expect(screen.getByRole("region", { name: "Frequently asked questions" })).toBe(panel);
    await fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Frequently asked questions" })).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
  it("also supports tapping the question mark and dismissing outside the panel", async () => {
    const { button, root } = setup();
    const touch = new Event("pointerenter");
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    await fireEvent(root, touch);
    expect(screen.queryByRole("region", { name: "Frequently asked questions" })).toBeNull();
    await fireEvent.click(button);
    expect(screen.getByRole("region", { name: "Frequently asked questions" })).toBeTruthy();
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "Frequently asked questions" })).toBeNull();
  });
  it("closes after keyboard focus moves outside", async () => {
    const { button } = setup();
    button.focus();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Frequently asked questions" })).toBeTruthy(),
    );
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      outside.focus();
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Frequently asked questions" })).toBeNull(),
      );
    } finally {
      outside.remove();
    }
  });
});
