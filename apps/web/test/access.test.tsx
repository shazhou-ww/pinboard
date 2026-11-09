import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Pin } from "@shazhou/pinboard-contracts";
const host = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  fetch: vi.fn(),
}));
vi.mock("../src/api.js", () => ({
  apiFetch: host.fetch,
  previewEnabled: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
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
}));
import { AccessDialog, confirmPublicSource } from "../src/access.js";
import { DetailHeading } from "../src/detail-actions.js";
import { PinCard } from "../src/manager.js";

const original: Pin = {
  cid: "bafkreigh2akiscaildcxxbmjcwt4svm6yv6oubkcb3i3m2ak6bpgxy3s6a",
  name: "Private notes",
  size: 10,
  blocks: 1,
  createdAt: "2026-11-01",
  visibility: "private",
};
let current: Pin,
  confirm: ReturnType<typeof vi.fn>,
  saved: ReturnType<typeof vi.fn<(pin: Pin) => void>>;
beforeEach(() => {
  host.index = 0;
  host.slots = [];
  host.fetch.mockReset();
  current = original;
  confirm = vi.fn().mockReturnValue(true);
  saved = vi.fn((pin: Pin) => {
    current = pin;
  });
  vi.stubGlobal("window", { confirm });
  vi.stubGlobal("location", { origin: "http://local.test" });
});
afterEach(() => vi.unstubAllGlobals());
function render() {
  host.index = 0;
  return AccessDialog({
    open: true,
    kind: "pin",
    id: current.cid,
    item: current,
    onClose: () => {},
    onSaved: saved,
  });
}
function button(
  node: ReactNode,
  label: string,
): ReactElement<{ onClick: () => void; disabled?: boolean }> {
  if (
    isValidElement<{
      children?: ReactNode;
      onClick: () => void;
      disabled?: boolean;
    }>(node)
  ) {
    if (
      node.type === "button" &&
      Children.toArray(node.props.children)
        .filter((child) => typeof child === "string")
        .join("") === label
    )
      return node;
    for (const child of Children.toArray(node.props.children)) {
      try {
        return button(child, label);
      } catch {
        /* continue through siblings */
      }
    }
  }
  throw new Error(`Button not found: ${label}`);
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("detail-only access interaction", () => {
  it("waits for successful save, retains original state on failure and retries with fresh confirmation", async () => {
    let fail!: (error: Error) => void;
    host.fetch.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    button(render(), "Make public").props.onClick();
    expect(current.visibility).toBe("private");
    expect(saved).not.toHaveBeenCalled();
    expect(button(render(), "Make public").props.disabled).toBe(true);
    fail(new Error("Network unavailable"));
    await flush();
    expect(renderToStaticMarkup(render())).toContain(
      "The displayed setting is unchanged. Network unavailable",
    );
    expect(current).toBe(original);
    host.fetch.mockResolvedValueOnce(
      Response.json({ ...original, visibility: "public" }),
    );
    button(render(), "Make public").props.onClick();
    await flush();
    expect(current.visibility).toBe("public");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]![0]).toContain("cannot be recalled");
    expect(JSON.parse(host.fetch.mock.calls[1]![1].body)).toEqual({
      visibility: "public",
      acknowledge: true,
    });
    expect(button(render(), "Make private")).toBeDefined();
  });

  it("canceling a confirmation and copying a private link grant nothing", async () => {
    confirm.mockReturnValue(false);
    button(render(), "Make public").props.onClick();
    await flush();
    expect(host.fetch).not.toHaveBeenCalled();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    button(render(), "Copy personal access link").props.onClick();
    await flush();
    expect(writeText).toHaveBeenCalledWith(
      `http://local.test/share/${original.cid}`,
    );
    expect(saved).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(render())).toContain(
      "This link grants no access to others.",
    );
  });

  it("warns each time about all history, overlap and irreversible copies", async () => {
    host.fetch.mockResolvedValue(Response.json(original));
    const publication = { ...original, visibility: "public" as const };
    const tree = AccessDialog({
      open: true,
      kind: "publication",
      id: "publication",
      item: publication,
      revision: 3,
      onClose: () => {},
      onSaved: vi.fn(),
    });
    button(tree, "Make private").props.onClick();
    await flush();
    expect(confirm.mock.calls[0]![0]).toContain("ALL history");
    expect(confirm.mock.calls[0]![0]).toContain("another public reference");
    expect(confirm.mock.calls[0]![0]).toContain("external copies");
    confirm.mockReturnValue(false);
    expect(confirmPublicSource("private", "public")).toBe(false);
    expect(confirm.mock.lastCall![0]).toContain("version descriptions");
    expect(confirm.mock.lastCall![0]).toContain("source Pin remains private");
    expect(confirmPublicSource("private", "private")).toBe(true);
  });

  it("puts readonly private locks before names without a preview overlay; public cards have none", () => {
    host.slots = [];
    host.index = 0;
    const privateCard = renderToStaticMarkup(
      <PinCard
        pin={original}
        busy={false}
        onOpen={() => {}}
        onCopyCid={() => {}}
      />,
    );
    const publicCard = renderToStaticMarkup(
      <PinCard
        pin={{ ...original, visibility: "public" }}
        busy={false}
        onOpen={() => {}}
        onCopyCid={() => {}}
      />,
    );
    expect(privateCard).toMatch(
      /pin-info-summary"><span class="pin-lock" role="img" aria-label="Private"/,
    );
    expect(privateCard.indexOf('class="pin-lock"')).toBeLessThan(
      privateCard.indexOf('class="pin-name"'),
    );
    expect(privateCard).not.toContain(
      'aria-label="Private. Access and sharing"',
    );
    expect(publicCard).not.toContain("pin-lock");
    expect(privateCard).not.toContain("tile-state");
    const css = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(css.match(/\.pin-lock\s*\{([^}]+)\}/)?.[1]).not.toMatch(
      /padding|height|position/,
    );
  });

  it("uses the title's leftmost access button without a file icon; visitors get a readonly icon", () => {
    host.slots = [];
    host.index = 0;
    const props = {
      name: original.name,
      cid: original.cid,
      contentType: "text/plain",
      visibility: "private" as const,
      disabled: false,
      onCopy: () => {},
    };
    const owner = renderToStaticMarkup(
      <DetailHeading {...props} onAccess={() => {}} />,
    );
    const visitor = renderToStaticMarkup(
      <DetailHeading {...props} visibility="public" />,
    );
    expect(owner).toMatch(
      /detail-title"><button class="detail-access" aria-label="Private\. Access and sharing"/,
    );
    expect(owner).not.toContain("detail-type-icon");
    expect(visitor).toMatch(
      /detail-title"><span class="detail-access" role="img" aria-label="Public"/,
    );
    expect(visitor).not.toContain("Access and sharing");
    expect(owner).toContain("Copy CID");
  });
});
