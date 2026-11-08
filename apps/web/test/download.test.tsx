import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SharePage } from "../src/ui.js";

describe("share downloads", () => {
  it("offers original file/ZIP downloads as the primary action and retains CAR export", () => {
    const cid = "bafkreigh2akiscaildc4";
    const html = renderToStaticMarkup(<SharePage cid={cid} />);
    expect(html).toContain(
      `class="primary" href="/api/public/${cid}/download"`,
    );
    expect(html).toContain("Download file / ZIP");
    expect(html).toContain(`href="/api/public/${cid}/car"`);
    expect(html).toContain(`href="/ipfs/${cid}?format=raw"`);
  });
});
