import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailMenu, discardDetailsDraft } from "../src/detail-actions.js";
import { NodeDescriptionEditor } from "../src/node-description.js";

afterEach(() => vi.unstubAllGlobals());

describe("reading details", () => {
  it("keeps the root reading path free of edit and node query forms", () => {
    const html = renderToStaticMarkup(
      <NodeDescriptionEditor
        rootCid="fixed-root"
        name="Private name"
        readingFirst
      />,
    );
    expect(html).toContain('aria-label="Content preview"');
    expect(html.indexOf("reading-content")).toBeLessThan(
      html.indexOf("reading-sidebar"),
    );
    expect(html).toContain("Private description");
    expect(html).toContain("Advanced information and node query");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Read node");
  });

  it("keeps the selected publication snapshot read-only", () => {
    const html = renderToStaticMarkup(
      <NodeDescriptionEditor
        rootCid="selected-root"
        publicationId="publication"
        revision={5}
        readingFirst
      />,
    );
    expect(html).toContain("Published description");
    expect(html).toContain("Read-only snapshot of this version.");
    expect(html).not.toContain("Edit description");
    expect(html).not.toContain("Save description");
  });

  it("preserves reachable node queries in the advanced view", () => {
    const html = renderToStaticMarkup(<NodeDescriptionEditor rootCid="root" />);
    expect(html).toContain("Node CID (root or reachable child)");
    expect(html).toContain("Read node");
    expect(html).not.toContain("<textarea");
  });

  it("uses a closed native disclosure with keyboard-focusable actions", () => {
    const html = renderToStaticMarkup(
      <DetailMenu label="Download">
        <a href="/fixed/car">CAR</a>
      </DetailMenu>,
    );
    expect(html).toContain("<summary>Download</summary>");
    expect(html).toContain('aria-label="Download actions"');
    expect(html).not.toContain(" open=");
    expect(html).not.toContain('role="menu"');
  });

  it("contains Escape within the active menu instead of dismissing details", () => {
    let tree: ReactNode;
    function Probe() {
      tree = DetailMenu({
        label: "Share",
        children: <button>Copy CID</button>,
      });
      return tree;
    }
    renderToStaticMarkup(<Probe />);
    type Props = {
      onKeyDown: (event: {
        key: string;
        preventDefault: () => void;
        stopPropagation: () => void;
      }) => void;
      ref: { current: unknown };
    };
    if (!isValidElement<Props>(tree)) throw new Error("Missing menu");
    const focus = vi.fn();
    const menu = { open: true, querySelector: () => ({ focus }) };
    tree.props.ref.current = menu;
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    tree.props.onKeyDown(event);
    expect(menu.open).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("does not ask to discard normal reading state", () => {
    const confirm = vi.fn();
    vi.stubGlobal("window", { confirm });
    expect(discardDetailsDraft(false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires explicit discard confirmation: %s",
    (accept) => {
      const confirm = vi.fn(() => accept);
      vi.stubGlobal("window", { confirm });
      expect(discardDetailsDraft(true)).toBe(accept);
      expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    },
  );
});
