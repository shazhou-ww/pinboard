import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon } from "../src/icon.js";

describe("shared Phosphor icons", () => {
  it.each([
    "add",
    "addFolder",
    "brand",
    "caretDown",
    "check",
    "copy",
    "download",
    "externalLink",
    "file",
    "folder",
    "more",
    "settings",
    "signOut",
    "unknown",
  ] as const)("renders %s with consistent decorative defaults", (name) => {
    const markup = renderToStaticMarkup(<Icon name={name} />);
    expect(markup).toContain("<svg ");
    expect(markup).toContain('viewBox="0 0 256 256"');
    expect(markup).toContain('width="20"');
    expect(markup).toContain('height="20"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
  });

  it("uses duotone artwork for content icons", () => {
    for (const name of ["file", "folder", "unknown"] as const) {
      expect(renderToStaticMarkup(<Icon name={name} />)).toContain(
        'opacity="0.2"',
      );
    }
  });

  it("preserves explicit labels, sizes and styles for meaningful icons", () => {
    const markup = renderToStaticMarkup(
      <Icon
        name="file"
        size={18}
        className="preview-entry-icon"
        role="img"
        aria-hidden={false}
        aria-label="File"
      />,
    );
    expect(markup).toContain('width="18"');
    expect(markup).toContain('height="18"');
    expect(markup).toContain('class="preview-entry-icon"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-hidden="false"');
    expect(markup).toContain('aria-label="File"');
  });
});
