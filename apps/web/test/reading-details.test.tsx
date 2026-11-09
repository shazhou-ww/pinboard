import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DetailMenu,
  DetailHeading,
  DetailDrawer,
  detailCopyLinks,
  discardDetailsDraft,
} from "../src/detail-actions.js";
import { NodeDescriptionEditor } from "../src/node-description.js";

afterEach(() => vi.unstubAllGlobals());

describe("reading details", () => {
  it("replaces the title with an inline editor instead of appending another panel", () => {
    const html = renderToStaticMarkup(
      <DetailHeading
        name="Existing title"
        cid="root"
        contentType="text/plain"
        visibility="private"
        disabled
        onCopy={() => {}}
        titleEditor={
          <form
            className="detail-title-editor"
            aria-label="Rename Existing title"
          >
            <input aria-label="Pin name" defaultValue="Existing title" />
            <button aria-label="Save name">Save</button>
          </form>
        }
      />,
    );
    expect(html).toContain('class="detail-title-editor"');
    expect(html).not.toContain("<h3>");
    expect(html.indexOf('class="detail-title-editor"')).toBeLessThan(
      html.indexOf('class="detail-cid-combo"'),
    );
  });

  it("bounds the reading sidebar and isolates compact editor spacing", () => {
    const css = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(
      /\.reading-sidebar\s*\{[^}]*max-height:\s*360px;[^}]*overflow-y:\s*auto;/u,
    );
    expect(css).toMatch(
      /\.reading-sidebar \.reading-description-form\s*\{[^}]*gap:\s*8px;[^}]*margin:\s*0;/u,
    );
    expect(css).toMatch(
      /\.reading-description-form textarea\s*\{[^}]*max-height:\s*180px;/u,
    );
    expect(css).toMatch(
      /\.pin-detail \.detail-title-editor\s*\{[^}]*height:\s*1lh;[^}]*margin:\s*0;/u,
    );
  });

  it("groups the complete CID and icon in one copy button", () => {
    const html = renderToStaticMarkup(
      <DetailHeading
        visibility="private"
        name="File"
        cid="complete-cid"
        contentType="image/png"
        disabled={false}
        onCopy={() => {}}
      />,
    );
    expect(html).toMatch(
      /aria-label="Copy CID"[^>]*><code>complete-cid<\/code>/u,
    );
    expect(html).toContain('aria-label="More copy options"');
    expect(html).toContain("Copy personal access link");
    expect(html).toContain("Copy IPFS link");
    expect(html).not.toContain("Copy follow link");
  });

  it("copies direct downloads and immutable IPFS identifiers with version-specific links", () => {
    expect(
      detailCopyLinks("root", "notes & files", "https://local.test", {
        id: "pub",
        revision: 2,
      }),
    ).toEqual([
      {
        label: "Copy HTTP download link",
        value:
          "https://local.test/api/public/root/download?name=notes%20%26%20files",
      },
      { label: "Copy IPFS link", value: "ipfs://root" },
      { label: "Copy follow link", value: "https://local.test/p/pub" },
      { label: "Copy fixed v2 link", value: "https://local.test/p/pub/v/2" },
    ]);
  });

  it("keeps the version drawer inside its layer without a close glyph", () => {
    const html = renderToStaticMarkup(
      <DetailDrawer onClose={() => {}}>
        <button aria-pressed="true">View v2</button>
      </DetailDrawer>,
    );
    expect(html).toContain('class="detail-drawer-layer"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('class="detail-drawer-backdrop"');
    expect(html).not.toContain("Close version history</button>");
  });
  it("does not append scope explanations for any ready preview type", () => {
    const source = readFileSync(
      new URL("../src/node-description.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /preview-scope|First-page preview only|Thumbnail only|Directory preview only|Limited content preview|Download the complete content or retry/u,
    );
    expect(source).toContain("Generating preview...");
    expect(source).toContain("Preview generation failed.");
    expect(source).toContain("Retry preview");
  });

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
    expect(html).not.toContain("Advanced information and node query");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Read node");
  });

  it.each([{}, { publicationId: "publication", revision: 5 }])(
    "reserves a scrollable preview before content loads: %j",
    (props) => {
      const html = renderToStaticMarkup(
        <NodeDescriptionEditor rootCid="root" readingFirst {...props} />,
      );
      expect(html).toContain('class="pin-preview"');
      expect(html).toContain('class="reading-preview-viewport"');
      expect(html).toContain('aria-label="Scrollable content preview"');
      expect(html).toContain('tabindex="0"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toMatch(
        /class="pin-preview"[^>]*><p role="status">Loading content/u,
      );
    },
  );

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

  it("preserves the standalone node editor without exposing it in reading details", () => {
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
