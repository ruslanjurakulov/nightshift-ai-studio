// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as confirmDialog from "@/components/feedback/ConfirmDialog";
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
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("model terms on the availability board", () => {
  it("shows gates and acceptance dates to non-owner operators without acceptance controls", () => {
    const { rerender } = render(board(false));
    expect(screen.getByText(en.models.termsGate.replace("{gate}", c.requirements.review.label))).toBeTruthy();
    expect(screen.getByRole("link", { name: c.link }).getAttribute("href")).toBe("https://aistudio.google.com/docs/terms");
    expect(screen.queryByRole("button", { name: c.requirements.review.accept })).toBeNull();

    rerender(board(false, ungated, coerceModelTermsAcceptances([{ model_id: id, gate, accepted_at: acceptedAt, accepted_by_you: false }])));
    expect(screen.getByText(c.accepted.replace("{date}", "Nov 27, 2026"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: c.revoke })).toBeNull();
    expect(postOperator).not.toHaveBeenCalled();
  });

  it.each([
    ["terms_review_required", "I reviewed the vendor's terms", "Confirm that you read the vendor's terms for this use."],
    ["written_consent_required", "I hold the vendor's written consent", "Confirm that you hold the vendor's written consent to offer this model to users."],
    ["plan_required:scale", "The vendor account has the Scale plan", "Confirm that the vendor account is on the Scale plan."],
    ["account_verification_required", "I checked this requirement: Account verification required", "Confirm that you checked this requirement: Account verification required."],
  ])("describes the %s gate on the board and in the confirmation", (gate, label, message) => {
    render(board(true, coerceAdminModels([{ ...raw, spec: { terms_gate: gate } }])));
    fireEvent.click(screen.getByRole("button", { name: label }));
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText(message)).toBeTruthy();
    expect(dialog.getByRole("button", { name: label })).toBeTruthy();
    expect(screen.queryByText(gate, { exact: false })).toBeNull();
  });

  it("forwards the dialog's input verbatim to the server", async () => {
    // The real dialog only submits the exact ID. Stub its callback here so
    // forwarding the input and hard-coding the ID produce different payloads.
    const typed = ` ${id.toUpperCase()} `;
    const confirm = vi.fn(async (options: confirmDialog.ConfirmOptions) => {
      expect(await options.run?.(typed)).toBe(c.errors.bad_confirm);
      return false;
    });
    vi.spyOn(confirmDialog, "useConfirm").mockReturnValue({ confirm, dialog: null });
    postOperator.mockResolvedValue({ ok: false, status: 400, data: { error: "bad_confirm" } });
    render(board(true));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: c.requirements.review.accept })));
    expect(postOperator).toHaveBeenCalledExactlyOnceWith("/api/models/terms", { id, gate, confirm: typed });
  });

  it.each(["gate_changed", "not_accepted"] as const)("refreshes after a %s refusal", async (error) => {
    postOperator.mockResolvedValue({ ok: false, status: 409, data: { error } });
    const revoke = error === "not_accepted";
    render(revoke ? board(true, ungated, { [id]: { gate, acceptedAt, acceptedByYou: true } }) : board(true));
    const name = revoke ? c.revoke : c.requirements.review.accept;
    fireEvent.click(screen.getByRole("button", { name }));
    const dialog = within(screen.getByRole("alertdialog"));
    if (!revoke) fireEvent.change(dialog.getByRole("textbox"), { target: { value: id } });
    await act(async () => fireEvent.click(dialog.getByRole("button", { name })));
    expect(refresh).toHaveBeenCalledOnce();
    expect(dialog.getByRole("alert").textContent).toBe(c.errors[error]);
  });

  it("requires the exact typed id and posts the gate the owner saw", async () => {
    postOperator.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    render(board(true));
    fireEvent.click(screen.getByRole("button", { name: c.requirements.review.accept }));
    const dialog = within(screen.getByRole("alertdialog"));
    const input = dialog.getByRole("textbox");
    const action = dialog.getByRole<HTMLButtonElement>("button", { name: c.requirements.review.accept });
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
    expect(screen.getByText(c.previousAcceptance.replace("{gate}", "Old terms").replace("{date}", "Nov 27, 2026"))).toBeTruthy();
    expect(screen.getByRole("button", { name: c.requirements.review.accept })).toBeTruthy();
    expect(screen.getByRole("button", { name: c.revoke })).toBeTruthy();
    expect(screen.queryByText(c.acceptedByYou.replace("{date}", "Nov 27, 2026"))).toBeNull();
  });

  it("keeps ByteDance terms read-only for the platform owner", () => {
    render(board(true, coerceAdminModels([{ ...raw, provider: "bytedance" }])));
    expect(screen.queryByRole("button", { name: c.requirements.review.accept })).toBeNull();
    expect(screen.getByText(c.errors.bytedance)).toBeTruthy();
  });
});
