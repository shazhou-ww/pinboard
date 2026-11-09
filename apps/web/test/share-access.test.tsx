import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[],
  cleanup: undefined as (() => void) | undefined,
  fetch: vi.fn(),
}));
vi.mock("../src/api.js", () => ({ apiFetch: host.fetch }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = initial;
    return [
      host.slots[index],
      (next: unknown) => {
        host.slots[index] = next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = host.index++;
    const before = host.slots[index] as unknown[] | undefined;
    if (!before || deps.some((item, i) => item !== before[i])) {
      host.slots[index] = deps;
      host.effects.push(effect);
    }
  },
}));
import { SharePage } from "../src/ui.js";
const cid = "bafkreigh2akiscaildc4";
let tree: ReactNode;
function render(value = cid) {
  host.index = 0;
  tree = SharePage({ cid: value });
  for (const effect of host.effects.splice(0)) {
    host.cleanup?.();
    host.cleanup = effect() || undefined;
  }
  return renderToStaticMarkup(tree);
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => {
  host.slots = [];
  host.index = 0;
  host.effects = [];
  host.cleanup = undefined;
  host.fetch.mockReset();
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  host.cleanup?.();
  vi.unstubAllGlobals();
});

describe("protected CID share reading", () => {
  it("checks access before showing the CID or download actions", async () => {
    host.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(render()).toContain("Checking access...");
    expect(render()).not.toContain(cid);
    await flush();
    const readable = render();
    expect(host.fetch.mock.calls[0]![0]).toBe(`/api/public/${cid}/access`);
    expect(readable).toContain(cid);
    expect(readable).toContain("Download file / ZIP");
    expect(readable).toContain("Download CAR");
    expect(readable).toContain("access=v1");
  });
  it.each([401, 403, 404, 503])(
    "keeps unavailable links generic (%s)",
    async (status) => {
      host.fetch.mockResolvedValueOnce(new Response(null, { status }));
      render();
      await flush();
      const denied = render();
      expect(denied).toContain("Content unavailable");
      expect(denied).toContain("Sign in to check access or switch accounts");
      expect(denied).not.toContain(cid);
      expect(denied).not.toContain("Download CAR");
    },
  );
  it("handles transport failure and invalid input without revealing metadata", async () => {
    host.fetch.mockRejectedValueOnce(new Error("Network unavailable"));
    render();
    await flush();
    expect(render()).toContain("Content unavailable");
    expect(render("<script>")).toContain("Invalid CID");
    await flush();
    expect(render("<script>")).not.toContain("Download CAR");
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });
  it("ignores reads that finish after closing or changing the link", async () => {
    let complete!: (response: Response) => void;
    host.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    render();
    host.cleanup?.();
    complete(new Response(null, { status: 204 }));
    await flush();
    expect(render()).toContain("Checking access...");
  });
  it("ignores transport failures after closing", async () => {
    let fail!: (error: Error) => void;
    host.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((_, reject) => {
          fail = reject;
        }),
    );
    render();
    host.cleanup?.();
    fail(new Error("Canceled request"));
    await flush();
    expect(render()).toContain("Checking access...");
  });
  it("shows a readonly private byte icon without pretending CID links grant item-management rights", async () => {
    host.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        headers: { "x-pinboard-byte-access": "private" },
      }),
    );
    render();
    await flush();
    const readable = render();
    expect(readable).toContain(
      'class="detail-access" role="img" aria-label="Private"',
    );
    expect(readable).not.toContain("Private. Access and sharing");
    expect(readable).toContain("Copy personal access link");
    expect(readable).not.toContain("ipfs get");
  });
  it("keeps public visitor icons readonly and handles clipboard failures explicitly", async () => {
    host.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        headers: { "x-pinboard-byte-access": "public" },
      }),
    );
    render();
    await flush();
    expect(render()).toContain(
      'class="detail-access" role="img" aria-label="Public"',
    );
    const find = (
      node: ReactNode,
    ): ((text: string, copied?: () => void) => void) | undefined => {
      if (
        !isValidElement<{
          children?: ReactNode;
          onCopy?: (text: string, copied?: () => void) => void;
        }>(node)
      )
        return;
      if (node.props.onCopy) return node.props.onCopy;
      for (const child of Children.toArray(node.props.children)) {
        const found = find(child);
        if (found) return found;
      }
      return undefined;
    };
    const copy = find(tree)!;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const copied = vi.fn();
    copy(cid, copied);
    await flush();
    expect(copied).toHaveBeenCalledOnce();
    copy(cid);
    await flush();
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    copy(cid);
    await flush();
    expect(render()).toContain(
      "Could not copy the link or CID. Retry copying.",
    );
  });
});
