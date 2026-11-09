import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ContentPreview } from "@shazhou/pinboard-contracts";
import { PinPreview, PreviewContent } from "../src/pin-preview.js";
import { previewPollDelay } from "../src/preview-poll.js";

const render = (preview: ContentPreview) =>
  renderToStaticMarkup(
    <PreviewContent name="my private pin" preview={preview} />,
  );
const base = { version: 1, status: "ready" as const, truncated: false };
describe("typed, display-only content previews", () => {
  it.each([
    ["application/pdf", "PDF"],
    ["image/jpeg", "Image"],
    ["video/mp4", "Video"],
    ["audio/mpeg", "Audio"],
    ["text/plain", "Text"],
    ["inode/directory", "Folder"],
    ["application/octet-stream", "File"],
    [null, "Content"],
  ] as const)(
    "uses source %s for the normal empty-material cover",
    (contentType, label) => {
      const markup = render({
        ...base,
        status: "unsupported",
        contentType,
        preview: null,
        reason: "Internal diagnosis",
      });
      expect(markup).toContain(`aria-label="${label} preview"`);
      expect(markup).not.toMatch(
        /Internal diagnosis|unavailable|retry|role="alert"/u,
      );
    },
  );
  it("decorates only PDF image material and preserves unknown source material", () => {
    const image = {
      kind: "image" as const,
      image: {
        cid: "thumbnail",
        url: "/ipfs/thumbnail",
        width: 339,
        height: 480,
      },
    };
    for (const contentType of [
      "application/pdf",
      "image/jpeg",
      "video/mp4",
      null,
    ]) {
      const markup = render({ ...base, contentType, preview: image });
      expect(markup).toContain('src="/ipfs/thumbnail"');
      expect(markup.includes('class="preview-paper"')).toBe(
        contentType === "application/pdf",
      );
      expect(markup.includes('aria-label="PDF document"')).toBe(
        contentType === "application/pdf",
      );
    }
  });
  it("keeps PDF paper below the overlay in the same fixed-size card as other content", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).not.toMatch(
      /\.pin-(?:wall \.pin-)?card:has\(\.has-paper\)/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/u,
    );
    expect(styles).toMatch(
      /\.pin-info\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*auto 0 -1px;/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\.has-paper\s*\{[^}]*height:\s*100%;/u,
    );
    expect(styles).toMatch(
      /\.preview-paper-sheet\s*\{[^}]*aspect-ratio:\s*4 \/ 3;[^}]*overflow:\s*hidden;[^}]*border-bottom:\s*0;[^}]*box-shadow:\s*-3px 0 6px -2px var\(--shadow\),\s*3px 0 6px -2px var\(--shadow\),\s*0 -3px 6px -2px var\(--shadow\);/u,
    );
    expect(styles).toMatch(
      /\.pin-preview \.preview-paper img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*cover;[^}]*object-position:\s*center top;/u,
    );
  });
  it("extends the glass band through the card bottom border without moving its content", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.pin-info\s*\{[^}]*inset:\s*auto 0 -1px;[^}]*padding:\s*12px 16px;[^}]*border-top:\s*1px solid var\(--border\);[^}]*border-bottom:\s*1px solid var\(--border\);/u,
    );
    expect(styles).toMatch(/\.pin-wall \.pin-card\s*\{[^}]*overflow:\s*clip;/u);
  });
  it("keeps polling transient backend retries across their backoff without retrying terminal failures", () => {
    const preview: ContentPreview = {
      ...base,
      status: "pending",
      contentType: "application/pdf",
      preview: null,
    };
    expect(previewPollDelay({ ...preview, status: "pending" }, 1)).toBe(2000);
    expect(
      previewPollDelay(
        {
          ...preview,
          status: "failed",
          reason: "Preview generation failed; retry scheduled",
        },
        3,
      ),
    ).toBe(30000);
    expect(
      previewPollDelay(
        {
          ...preview,
          status: "failed",
          reason: "Preview failed after 3 attempts",
        },
        3,
      ),
    ).toBeUndefined();
    expect(
      previewPollDelay({ ...preview, status: "unsupported" }, 1),
    ).toBeUndefined();
    expect(
      previewPollDelay({ ...preview, status: "pending" }, 24),
    ).toBeUndefined();
  });
  it("floats publication icons without changing the shared preview or summary layout", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.publication-badge\s*\{[^}]*position:\s*absolute;[^}]*top:\s*12px;[^}]*right:\s*12px;[^}]*width:\s*28px;[^}]*height:\s*28px;/u,
    );
    expect(styles).not.toMatch(
      /\.pin-card:has\(\.publication-badge\) \.(?:pin-preview|pin-info-summary|pin-size)/u,
    );
    expect(styles).toMatch(
      /\.pin-info\s*\{[^}]*grid-template-rows:\s*auto 0fr;/u,
    );
    expect(styles).toMatch(
      /\.pin-info-cid\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;/u,
    );
    expect(styles).toMatch(
      /\.pin-info:focus-visible,\s*\.pin-info:has\(:focus-visible\),\s*\.pin-card.copy-confirmed \.pin-info\s*\{[^}]*grid-template-rows:\s*auto 1fr;/u,
    );
    expect(styles).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*\.pin-info:hover\s*\{[^}]*grid-template-rows:\s*auto 1fr;/u,
    );
    expect(styles).toMatch(
      /@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.pin-info\s*\{[^}]*grid-template-rows:\s*auto 1fr;/u,
    );
  });
  it("uses compact top spacing while extending previews behind the strip and centering image crops", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto;/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\s*\{[^}]*padding:\s*12px 24px 0;[^}]*overflow:\s*hidden;/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview\.has-image\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*padding:\s*0;/u,
    );
    expect(styles).toMatch(
      /\.pin-card \.pin-preview img\s*\{[^}]*min-height:\s*0;[^}]*object-fit:\s*cover;[^}]*object-position:\s*center;/u,
    );
  });
  it("sizes Phosphor icons consistently without CSS-drawn shapes", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.preview-entry-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/u,
    );
    expect(styles).not.toMatch(/\.preview-entry-icon[^{}]*::(?:before|after)/u);
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
      /\.pin-info\s*\{[^}]*background:\s*var\(--surface-glass\);[^}]*backdrop-filter:\s*blur\(16px\)/u,
    );
    expect(styles).toMatch(
      /\.pin-card:has\(\.preview-text, \.preview-code, \.preview-directory\) \.pin-info\s*\{[^}]*background:\s*var\(--surface-glass-light\);[^}]*-webkit-backdrop-filter:\s*blur\(4px\) saturate\(1\.15\);[^}]*backdrop-filter:\s*blur\(4px\) saturate\(1\.15\);/u,
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
    expect(styles).toMatch(
      /\.preview-directory ul\s*\{[^}]*padding:\s*0 0 0 14\.5px;[^}]*margin:\s*0 0 0 8\.5px;/u,
    );
    expect(styles).toMatch(
      /\.preview-folder-heading\s*\{[^}]*height:\s*28px;[^}]*margin-bottom:\s*0;/u,
    );
  });
  it("aligns guide axes with parent icon centers and leaves room before child icons", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.preview-directory li::before\s*\{[^}]*left:\s*-15\.5px;[^}]*top:\s*0;[^}]*width:\s*10\.5px;[^}]*height:\s*14px;/u,
    );
    expect(styles).toMatch(
      /\.preview-directory li\[data-depth="1"\]\s*\{[^}]*margin-left:\s*24px;/u,
    );
    expect(styles).toMatch(
      /\.preview-directory li\[data-depth="1"\]::before\s*\{[^}]*top:\s*-14px;[^}]*height:\s*28px;[^}]*border-left:\s*1px solid var\(--border\);/u,
    );
  });
  it("starts each subfolder guide below its parent icon without interrupting sibling connections", () => {
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.preview-directory li\[data-depth="0"\] \+ li\[data-depth="1"\]::before\s*\{[^}]*top:\s*-3px;[^}]*height:\s*17px;/u,
    );
  });
  it("uses the current pin name for folder headings and truncates long names", () => {
    const markup = renderToStaticMarkup(
      <PreviewContent
        name={"<Project> " + "x".repeat(200)}
        preview={{
          ...base,
          contentType: "inode/directory",
          preview: { kind: "directory", entries: [], total: 0 },
        }}
      />,
    );
    expect(markup).toContain(
      'class="preview-entry-name" title="&lt;Project&gt; ' + "x".repeat(200),
    );
    expect(markup).not.toContain("<span>Folder</span>");
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.preview-entry-name\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/u,
    );
  });
  it("uses only the separately cacheable thumbnail URL, not a CAR or data URL", () => {
    const markup = render({
      ...base,
      contentType: "image/webp",
      preview: {
        kind: "image",
        image: {
          cid: "thumbnail",
          url: "/ipfs/thumbnail",
          width: 480,
          height: 320,
        },
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
        preview: {
          kind: contentType === "text/plain" ? "text" : "markdown",
          text: "<script>alert(1)</script><svg onload='bad()'/><img src='https://bad.test/x'>\n[link](https://bad.test)",
        },
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
        preview: {
          kind: "markdown",
          text: "\\# literal \\*star\\* \\[link\\]\\(url\\)",
        },
      }),
    ).toContain("# literal *star* [link](url)");
    const markup = render({
      ...base,
      contentType: "text/markdown",
      preview: {
        kind: "markdown",
        text: "````\nconst x = '<script>';\n```\n````",
      },
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
      contentType: "inode/directory",
      preview: {
        kind: "directory",
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
    expect(markup.match(/<svg /gu)).toHaveLength(3);
    expect(markup.match(/opacity="0.2"/gu)).toHaveLength(3);
    expect(
      markup.match(/<svg (?=[^>]*role="img")(?=[^>]*aria-hidden="false")/gu),
    ).toHaveLength(2);
    expect(markup).toMatch(
      /<svg [^>]*aria-hidden="true"[^>]*data-kind="directory"/u,
    );
    expect(markup).toContain('class="preview-folder-heading"');
    expect(markup).toContain(">my private pin</span>");
    expect(markup).not.toContain("Excerpt / sampled overview");
    expect(markup).not.toContain("preview-truncated");
    expect(markup).not.toMatch(/href=|<button|<a |total/iu);
  });
  it("only reports verified counts and distinguishes empty folders from sampled empty previews", () => {
    const directory = {
      ...base,
      contentType: "inode/directory",
      preview: { kind: "directory" as const, entries: [], total: 0 },
    };
    expect(render(directory)).toContain("Empty folder");
    expect(render(directory)).toContain("0");
    expect(
      render({
        ...directory,
        truncated: true,
        preview: { kind: "directory", entries: [] },
      }),
    ).toContain("No entries in this preview");
    expect(
      render({
        ...directory,
        preview: { kind: "directory", entries: [], total: 1 },
      }),
    ).toContain("top-level");
  });
  it("keeps unknown folder entries honest and long names inert", () => {
    const markup = render({
      ...base,
      contentType: "inode/directory",
      preview: {
        kind: "directory",
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
    "renders %s as the same type cover without a failure UX",
    (status) => {
      const markup = render({
        ...base,
        status,
        reason: "Explicit reason",
        contentType: "application/pdf",
        size: 1024,
        preview: null,
      });
      expect(markup).toContain('aria-label="PDF preview"');
      expect(markup).not.toMatch(
        /role="status"|Explicit reason|1024|failed|pending|unavailable/iu,
      );
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
          visibility: "private",
        }}
      />,
    );
    expect(markup).toContain('aria-label="Content preview"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("/car");
  });
});
