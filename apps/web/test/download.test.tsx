import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContentDownloads, SharePage } from "../src/ui.js";

describe("share downloads", () => {
  it("offers original file/ZIP downloads as the primary action and retains CAR export", () => {
    const cid = "bafkreigh2akiscaildc4";
    const html = renderToStaticMarkup(<ContentDownloads cid={cid} />);
    expect(html).toContain(
      `class="primary" href="/api/public/${cid}/download?access=v1"`,
    );
    expect(html).toContain("Download file / ZIP");
    expect(html).toContain(`href="/api/public/${cid}/car?access=v1"`);
    expect(html).toContain(`href="/ipfs/${cid}?format=raw&amp;access=v1"`);
    const checking = renderToStaticMarkup(<SharePage cid={cid} />);
    expect(checking).toContain("Checking access...");
    expect(checking).not.toContain(cid);
  });
});
