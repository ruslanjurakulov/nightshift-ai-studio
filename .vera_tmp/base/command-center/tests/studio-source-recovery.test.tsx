// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { SourcePicker } from "@/components/studio/SourcePicker";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const g = dictionaries.en.gen;

describe("saved Studio source recovery", () => {
  it.each([
    { media: "picture" as const, well: false, kind: "image" },
    { media: "picture" as const, well: true, kind: "image" },
    { media: "recording" as const, well: false, kind: "audio" },
    { media: "video" as const, well: false, kind: "video" },
  ])("keeps the selected $media (well=$well) and offers a single pending retry", async ({ media, well, kind }) => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();
    render(<I18nProvider locale="en"><SourcePicker orgId={org} value={id} onChange={onChange}
      libraryHref="/fictional/library" media={media} well={well} /></I18nProvider>);

    expect(await screen.findByText(g.sourceFailed)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: g.sourceRetry }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toBe(g.sourceLoading);
    expect(screen.queryByRole("button", { name: g.sourceRetry })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => finish(new Response(JSON.stringify({ assets: [{
      id, kind, name: "fictional saved source", mime: `${kind}/synthetic`, durationS: 8,
      thumbUrl: null, viewUrl: null,
    }] }), { status: 200 })));
    expect(await screen.findByText("fictional saved source")).toBeTruthy();
    expect(screen.queryByText(g.sourceFailed)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`/api/media?org=${org}`);
      expect(init).toEqual({ cache: "no-store" });
    }
  });
});
