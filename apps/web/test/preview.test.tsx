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
  it("scopes pin row layout to direct children and keeps directory list spacing compact", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(/\.pin-list\s*>\s*li\s*\{/u);
    expect(styles).not.toMatch(/\.pin-list\s+li\s*\{/u);
    expect(styles).toMatch(/\.preview-directory ul\s*\{[^}]*margin:\s*0;/u);
    expect(styles).toMatch(
      /\.preview-directory p\s*\{[^}]*margin:\s*0 0 8px;/u,
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
    expect(markup).not.toMatch(/href=|<button|<a |total/iu);
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
