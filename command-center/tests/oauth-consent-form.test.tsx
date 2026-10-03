// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConsentForm, type ConsentText } from "@/components/oauth/ConsentForm";

/**
 * The monthly limit is typed in a one-field form. A form with a single text
 * field submits on Enter even without a submit button, so Enter in that box
 * used to be "Allow" — a spending approval from a keystroke meant to finish
 * typing a number. Only an explicit press of Allow (or Deny) sends a decision.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const text: ConsentText = {
  limitLabel: "Monthly limit", limitHint: "hint", limitInvalid: "Enter a whole number.", limitEcho: "{app} can spend {n} credits", limitEchoOne: "{app} one", limitEchoZero: "{app} zero",
  allow: "Allow", deny: "Deny", working: "Working", failed: "Failed", expired: "Expired", sessionEnded: "Signed out",
};

function setup() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ redirect: "https://a.example.com/cb?code=c" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const assign = vi.fn();
  Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
  render(<ConsentForm secret="nso_rq_x" app="Some App" locale="en" defaultLimit={500} maxLimit={20000} text={text} />);
  return { fetchMock, assign };
}

describe("the consent form never decides by itself", () => {
  it("Enter in the limit field sends nothing", async () => {
    const { fetchMock } = setup();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "800" } });
    const down = fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(down).toBe(false); // default prevented: no implicit submission
    fireEvent.keyPress(input, { key: "Enter", code: "Enter", charCode: 13 });
    // And a submit event on the form (what some browsers raise on Enter) is swallowed too.
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("there is no submit button: Allow and Deny are plain buttons", () => {
    setup();
    for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).type).toBe("button");
  });

  it("a click on Allow sends exactly one allow, with the number in the box", async () => {
    const { fetchMock, assign } = setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "800" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://a.example.com/cb?code=c"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/oauth/decision");
    expect(JSON.parse(String(init.body))).toEqual({ request: "nso_rq_x", decision: "allow", limit: 800 });
  });

  it("a click on Deny sends a deny with no limit; an invalid limit blocks Allow but not Deny", async () => {
    const { fetchMock } = setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getAllByText("Enter a whole number.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ request: "nso_rq_x", decision: "deny", limit: null });
  });
});

describe("Allow and Deny keep their places and their size", () => {
  it("Allow comes first in the page and sits on the right from sm up (as it always did); both are the same width", () => {
    setup();
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });
    expect(allow.parentElement).toBe(deny.parentElement);
    expect(allow.parentElement?.className).toContain("sm:flex-row-reverse");
    expect(allow.compareDocumentPosition(deny) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(allow.getAttribute("data-block")).toBe("true");
    expect(deny.getAttribute("data-block")).toBe("true");
  });
});
