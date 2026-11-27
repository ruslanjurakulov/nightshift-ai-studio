// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAvailabilityBoard } from "@/components/models/ModelAvailabilityBoard";
import { en } from "@/lib/i18n/en";
import { coerceAdminModels, coerceModelTermsAcceptances } from "@/lib/models-admin";

const { postOperator, refresh } = vi.hoisted(() => ({
  postOperator: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (path: string) => path }));
vi.mock("@/lib/operator-post", () => ({ postOperator }));
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: en, locale: "en" }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const id = "test-model";
const gate = "terms_review_required";
const raw = {
  id,
  provider: "google",
  display_name: "Test model",
  availability: "hidden",
  verified_at: "2026-11-27T12:00:00Z",
  credit_unit: "image",
  spec: { terms_gate: gate, terms_notes: ["Vendor terms (aistudio.google.com/docs/terms)."] },
};
const gated = coerceAdminModels([raw]);
const ungated = coerceAdminModels([{ ...raw, spec: {} }]);
const acceptedAt = "2026-11-27T12:00:00Z";
const c = en.models.terms;

function board(platformOwner: boolean, models = gated, terms = coerceModelTermsAcceptances([])) {
  return <ModelAvailabilityBoard models={models} probes={{}} prices={{ image: 1 }} terms={terms} platformOwner={platformOwner} />;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("model terms on the availability board", () => {
  it("shows gates and acceptance dates to non-owner operators without acceptance controls", () => {
    const { rerender } = render(board(false));
    expect(screen.getByText(en.models.termsGate.replace("{gate}", gate))).toBeTruthy();
    expect(screen.getByRole("link", { name: c.link }).getAttribute("href")).toBe("https://aistudio.google.com/docs/terms");
    expect(screen.queryByRole("button", { name: c.accept })).toBeNull();

    rerender(board(false, ungated, coerceModelTermsAcceptances([{ model_id: id, gate, accepted_at: acceptedAt, accepted_by_you: false }])));
    expect(screen.getByText(c.accepted.replace("{date}", "Nov 27, 2026"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: c.revoke })).toBeNull();
    expect(postOperator).not.toHaveBeenCalled();
  });

  it("requires the exact typed id and posts the gate the owner saw", async () => {
    postOperator.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    render(board(true));
    fireEvent.click(screen.getByRole("button", { name: c.accept }));
    const dialog = within(screen.getByRole("alertdialog"));
    const input = dialog.getByRole("textbox");
    const action = dialog.getByRole<HTMLButtonElement>("button", { name: c.confirm });
    expect(action.disabled).toBe(true);

    for (const value of ["incorrect", id.toUpperCase(), ` ${id}`]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(action.disabled).toBe(true);
    }
    expect(postOperator).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: id } });
    expect(action.disabled).toBe(false);
    await act(async () => fireEvent.click(action));
    expect(postOperator).toHaveBeenCalledExactlyOnceWith("/api/models/terms", { id, gate, confirm: id });
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the owner's acceptance and refreshes the switch after revocation", async () => {
    postOperator.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    const offered = [{ ...ungated[0], availability: "ga" as const }];
    const { rerender } = render(board(true, offered, { [id]: { gate, acceptedAt, acceptedByYou: true } }));
    expect(screen.getByText(c.acceptedByYou.replace("{date}", "Nov 27, 2026"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: c.revoke }));
    await act(async () => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: c.revoke })));
    expect(postOperator).toHaveBeenCalledExactlyOnceWith("/api/models/terms", { id, revoke: true });
    expect(refresh).toHaveBeenCalledOnce();

    rerender(board(true));
    expect(screen.getByRole("radio", { name: en.models.avail_hidden }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole<HTMLButtonElement>("radio", { name: en.models.avail_ga }).disabled).toBe(true);
  });

  it("offers review of the new terms and allows revoking the previous acceptance", () => {
    const previousGate = "old-terms";
    render(board(true, gated, { [id]: { gate: previousGate, acceptedAt, acceptedByYou: true } }));
    expect(screen.getByText(c.previousAcceptance.replace("{gate}", previousGate).replace("{date}", "Nov 27, 2026"))).toBeTruthy();
    expect(screen.getByRole("button", { name: c.accept })).toBeTruthy();
    expect(screen.getByRole("button", { name: c.revoke })).toBeTruthy();
    expect(screen.queryByText(c.acceptedByYou.replace("{date}", "Nov 27, 2026"))).toBeNull();
  });

  it("keeps ByteDance terms read-only for the platform owner", () => {
    render(board(true, coerceAdminModels([{ ...raw, provider: "bytedance" }])));
    expect(screen.queryByRole("button", { name: c.accept })).toBeNull();
    expect(screen.getByText(c.errors.bytedance)).toBeTruthy();
  });
});
