import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard, SharePage } from "../src/ui.js";
import { formatSize, PinCard } from "../src/manager.js";

const bootstrap = {
  appName: "Pinboard",
  providers: [{ id: "google" as const, label: "Google" }],
};
describe("Pinboard interface", () => {
  it("shows a restrained Google-only login and public-content notice", () => {
    const html = renderToStaticMarkup(
      <Dashboard state={{ kind: "ready", bootstrap, session: null }} />,
    );
    expect(html).toContain("Share by CID.");
    expect(html).toContain("Continue with Google");
    expect(html).toContain('value="google"');
    expect(html).not.toContain('href="/api/auth/signin');
    expect(html).not.toContain("GitHub");
    expect(html).toContain("Reading by CID is always public");
  });
  it("lists configured providers on the homepage and disables them during sign-in", () => {
    const configured = {
      ...bootstrap,
      providers: [
        ...bootstrap.providers,
        { id: "github" as const, label: "GitHub" },
      ],
    };
    const html = renderToStaticMarkup(
      <Dashboard
        state={{ kind: "ready", bootstrap: configured, session: null }}
        signingIn="google"
      />,
    );
    expect(html).toContain("Connecting to Google...");
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain('value="github"');
    expect(html).not.toContain("Microsoft");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
  });
  it.each([
    { name: "Alice", email: "alice@example.test" },
    { email: "alice@example.test" },
    {},
  ])("renders account management for signed-in profiles", (user) => {
    const html = renderToStaticMarkup(
      <Dashboard state={{ kind: "ready", bootstrap, session: { user } }} />,
    );
    expect(html).toContain("Sign out");
    expect(html).not.toContain('href="/api/auth/signout"');
    expect(html).toContain("Your pins");
    expect(html).not.toContain("I understand all uploaded bytes");
    expect(html).toContain("Uploaded content will be public");
    expect(html).toContain("Do not remind me in this browser");
    expect(html).toContain('class="shell canvas-shell"');
    expect(html).toContain('aria-label="Pinboard tools"');
    expect(html).toContain('aria-label="Add file"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).not.toContain("More add options");
    const toolbar = html.slice(
      html.indexOf('role="toolbar"'),
      html.indexOf('aria-label="Choose file"'),
    );
    expect(toolbar.match(/class="floating-button /g)).toHaveLength(3);
    expect(toolbar.match(/<svg /g)).toHaveLength(3);
    expect(toolbar).not.toContain(">Settings</button>");
    expect(toolbar).not.toContain(">Choose folder</button>");
    expect(html.match(/<dialog/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Pin details"');
    expect(html).not.toContain('class="intro"');
    expect(html).toContain("Create Agent token");
    expect(html).toContain("Choose file");
    expect(html).toContain("Choose folder");
    expect(html).toContain("Drop one file or folder anywhere here");
    expect(html).not.toContain("Content type");
    expect(html).not.toContain("Raw IPFS block");
    expect(html).toContain(
      '<option value="active" selected="">Active tokens</option>',
    );
    expect(html).toContain("History (revoked or expired)");
    expect(html).toContain("30");
    expect(html).toContain("7 days");
    expect(html).not.toContain("Physical garbage collection is deferred");
  });
  it("shows a pending immediate logout without a confirmation-page link", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          bootstrap,
          session: { user: { name: "Alice" } },
        }}
        signingOut
      />,
    );
    expect(html).toContain("Signing out...");
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('href="/api/auth/signout"');
  });
  it("renders loading, failure and unconfigured-provider states", () => {
    expect(
      renderToStaticMarkup(<Dashboard state={{ kind: "loading" }} />),
    ).toContain("Checking your session");
    expect(
      renderToStaticMarkup(
        <Dashboard state={{ kind: "error", message: "HTTP 503" }} />,
      ),
    ).toContain("HTTP 503");
    expect(
      renderToStaticMarkup(
        <Dashboard
          state={{
            kind: "ready",
            bootstrap: { ...bootstrap, providers: [] },
            session: null,
          }}
        />,
      ),
    ).toContain(".dev.vars");
  });
  it("renders preview-first cards with a copyable CID prefix and no inline management actions", () => {
    const pin = {
      cid: "bafkreia5ncapmfbrvhm3477lwtbhwrffqpujnsx7cfihnmbu3wcipu326u",
      name: "photo.png",
      size: 1024,
      blocks: 1,
      createdAt: "2026-11-05T00:00:00Z",
    };
    const html = renderToStaticMarkup(
      <PinCard pin={pin} busy={false} onOpen={() => {}} onCopyCid={() => {}} />,
    );
    expect(html).toContain('class="pin-preview"');
    expect(html).toContain('class="pin-info"');
    expect(html).toContain('aria-label="View details for photo.png"');
    expect(html).toContain('aria-label="Copy CID for photo.png"');
    expect(html).toContain(`<code>${pin.cid.slice(0, 16)}…</code>`);
    expect(html).toContain("1.0 KiB");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain("Rename");
    expect(html).not.toContain("Unpin");
    const busy = renderToStaticMarkup(
      <PinCard pin={pin} busy onOpen={() => {}} onCopyCid={() => {}} />,
    );
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
  });
  it("shares only safe downloads, never renders uploaded active content", () => {
    const html = renderToStaticMarkup(
      <SharePage cid="bafkreia5ncapmfbrvhm3477lwtbhwrffqpujnsx7cfihnmbu3wcipu326u" />,
    );
    expect(html).toContain("Download CAR");
    expect(html).toContain("delegated router");
    expect(html).not.toContain("<iframe");
    expect(renderToStaticMarkup(<SharePage cid="<script>" />)).toContain(
      "Invalid CID",
    );
    expect(formatSize(10)).toBe("10 B");
    expect(formatSize(1024)).toBe("1.0 KiB");
    expect(formatSize(1048576)).toBe("1.0 MiB");
  });
});
