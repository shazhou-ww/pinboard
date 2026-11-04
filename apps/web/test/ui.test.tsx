import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard, SharePage } from "../src/ui.js";
import { formatSize } from "../src/manager.js";

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
    expect(html).toContain("I understand all uploaded bytes");
    expect(html).toContain("Create Agent token");
    expect(html).toContain("Choose file");
    expect(html).toContain("Choose folder");
    expect(html).toContain("Drop one file or folder here");
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
