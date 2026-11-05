import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ContentPreview } from "@shazhou/pinboard-contracts";
import { PinPreview, PreviewContent } from "../src/pin-preview.js";

const render = (preview: ContentPreview) =>
  renderToStaticMarkup(
    <PreviewContent name="my private pin" preview={preview} />,
  );
const base = { version: 1, status: "ready" as const, truncated: false };
describe("typed, display-only content previews", () => {
  it("extends previews behind the frosted information strip and centers image crops", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto;/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\s*\{[^}]*padding:\s*24px 24px 0;[^}]*overflow:\s*hidden;/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\.has-image\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview img\s*\{[^}]*min-height:\s*0;[^}]*object-fit:\s*cover;[^}]*object-position:\s*center;/u,
    );
  });
  it("uses folded document icons instead of empty checkbox-like outlines", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.preview-entry-icon\[data-kind="file"\]\s*\{[^}]*clip-path:\s*polygon\(/u,
    );
    expect(styles).toMatch(
      /\.preview-entry-icon\[data-kind="file"\]::before\s*\{[^}]*border-left:[^}]*border-bottom:/u,
    );
    expect(styles).toMatch(
      /\.preview-entry-icon\[data-kind="file"\]::after\s*\{[^}]*box-shadow:/u,
    );
    expect(styles).toMatch(
      /\.preview-truncated\s*\{[^}]*position:\s*absolute;[^}]*top:\s*5px;/u,
    );
    expect(styles).toMatch(
      /\.pin-info\s*\{[^}]*backdrop-filter:\s*blur\(16px\)/u,
    );
  });
  it("uses lighter, tighter frosting for sparse text and folders while preserving image frosting", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.pin-info\s*\{[^}]*background:\s*#fffefab8;[^}]*backdrop-filter:\s*blur\(16px\)/u,
    );
    expect(styles).toMatch(
      /\.pin-card:has\(\.preview-text, \.preview-code, \.preview-directory\) \.pin-info\s*\{[^}]*background:\s*#fffefa73;[^}]*-webkit-backdrop-filter:\s*blur\(4px\) saturate\(1\.15\);[^}]*backdrop-filter:\s*blur\(4px\) saturate\(1\.15\);/u,
    );
    expect(styles).toMatch(/\.preview-directory li\s*\{[^}]*height:\s*28px;/u);
  });
  it("scopes pin row layout to direct children and keeps directory list spacing compact", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(/\.pin-list\s*>\s*li\s*\{/u);
    expect(styles).not.toMatch(/\.pin-list\s+li\s*\{/u);
    expect(styles).toMatch(/\.preview-directory ul\s*\{[^}]*margin:\s*0;/u);
    expect(styles).toMatch(
      /\.preview-folder-heading\s*\{[^}]*margin-bottom:\s*10px;/u,
    );
  });
  it("uses only the separately cacheable thumbnail URL, not a CAR or data URL", () => {
    const markup = render({
      ...base,
      contentType: "image/webp",
      content: {
        cid: "thumbnail",
        url: "/ipfs/thumbnail",
        width: 480,
        height: 320,
      },
    });
    expect(markup).toContain('src="/ipfs/thumbnail"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).not.toMatch(/\/car|data:|blob:/u);
  });
  it.each(["text/plain", "text/markdown"] as const)(
    "never executes HTML, embeds SVG or links for %s",
    (contentType) => {
      const markup = render({
        ...base,
        contentType,
        content:
          "<script>alert(1)</script><svg onload='bad()'/><img src='https://bad.test/x'>\n[link](https://bad.test)",
      });
      expect(markup).not.toMatch(/<script|<svg|<img|<a |href=/u);
      expect(markup).toContain("&lt;script&gt;");
      expect(markup).toContain("https://bad.test");
    },
  );
  it("renders escaped ordinary Markdown and faithful code without interpreting it", () => {
    expect(
      render({
        ...base,
        contentType: "text/markdown",
        content: "\\# literal \\*star\\* \\[link\\]\\(url\\)",
      }),
    ).toContain("# literal *star* [link](url)");
    const markup = render({
      ...base,
      contentType: "text/markdown",
      content: "````\nconst x = '<script>';\n```\n````",
    });
    expect(markup).toContain(
      "<code>const x = &#x27;&lt;script&gt;&#x27;;\n```</code>",
    );
    expect(markup).not.toContain("<script>");
  });
  it("renders a bounded read-only folder overview without navigation or fake totals", () => {
    const markup = render({
      ...base,
      truncated: true,
      contentType: "application/vnd.pinboard.directory+json",
      content: {
        entries: [
          { name: "<evil>.txt", kind: "file", depth: 0 },
          { name: "photos", kind: "directory", depth: 1 },
        ],
      },
    });
    expect(markup).toContain("&lt;evil&gt;.txt");
    expect(markup).toContain("photos");
    expect(markup).toContain('aria-label="Folder contents"');
    expect(markup).toContain('data-depth="1"');
    expect(markup).toContain('aria-label="File"');
    expect(markup).toContain('aria-label="Folder"');
    expect(markup).toContain('class="preview-folder-heading"');
    expect(markup).not.toMatch(/href=|<button|<a |total/iu);
  });
  it("only reports verified counts and distinguishes empty folders from sampled empty previews", () => {
    const directory = {
      ...base,
      contentType: "application/vnd.pinboard.directory+json" as const,
      content: { entries: [], total: 0 },
    };
    expect(render(directory)).toContain("Empty folder");
    expect(render(directory)).toContain("0");
    expect(
      render({ ...directory, truncated: true, content: { entries: [] } }),
    ).toContain("No entries in this preview");
    expect(
      render({ ...directory, content: { entries: [], total: 1 } }),
    ).toContain("top-level");
  });
  it("keeps unknown folder entries honest and long names inert", () => {
    const markup = render({
      ...base,
      contentType: "application/vnd.pinboard.directory+json",
      content: {
        entries: [
          { name: "<script>" + "x".repeat(200), kind: "unknown", depth: 0 },
        ],
      },
    });
    expect(markup).toContain('aria-label="Unknown item"');
    expect(markup).toContain('data-kind="unknown"');
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toMatch(/<script|href=|tabindex=|role="tree"/iu);
  });
  it.each(["pending", "failed", "unsupported"] as const)(
    "shows %s independently of content type and preserves reliable file metadata",
    (status) => {
      const markup = render({
        ...base,
        status,
        reason: "Explicit reason",
        contentType: "application/vnd.pinboard.file+json",
        content: { mediaType: "application/pdf", size: 1024 },
      });
      expect(markup).toContain('role="status"');
      expect(markup).toContain("Explicit reason");
      expect(markup).toContain("application/pdf");
      expect(markup).toContain("1024 bytes");
    },
  );
  it("keeps unavailable cards inert instead of using source filenames to fetch originals", () => {
    const markup = renderToStaticMarkup(
      <PinPreview
        pin={{
          cid: "original",
          name: "pretend.jpg",
          size: 99,
          blocks: 1,
          createdAt: "",
        }}
      />,
    );
    expect(markup).toContain("Preview pending");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("/car");
  });
});
