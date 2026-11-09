import { renderToStaticMarkup } from "react-dom/server";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";
import { Dashboard, HomeHeader, SharePage } from "../src/ui.js";
import { formatSize, PinCard, Snackbar } from "../src/manager.js";
import { Icon } from "../src/icon.js";

const bootstrap = {
  appName: "Pinboard",
  providers: [{ id: "google" as const, label: "Google" }],
};
type ButtonTree = { children?: ReactNode; onClick?: () => void };
function findButton(
  node: ReactNode,
  label: string,
): ReactElement<ButtonTree> | undefined {
  if (!isValidElement<ButtonTree>(node)) return undefined;
  const children = Children.toArray(node.props.children);
  if (node.type === "button" && children.includes(label)) return node;
  for (const child of children) {
    const button = findButton(child, label);
    if (button) return button;
  }
  return undefined;
}
describe("Pinboard interface", () => {
  it("renders floating success feedback without a layout notice", () => {
    const html = renderToStaticMarkup(
      <Snackbar
        message="Pinned. These bytes are now public."
        error={false}
        busy={false}
        onReload={() => {}}
      />,
    );
    expect(html).toContain('popover="manual"');
    expect(html).toContain('class="snackbar"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Pinned. These bytes are now public.");
    expect(html).not.toContain('class="notice');
    expect(html).not.toContain("<button");
  });
  it("keeps error feedback explicit and routes Reload while respecting busy state", () => {
    const onReload = vi.fn();
    let snackbar: ReactNode = null;
    function SnackbarProbe() {
      snackbar = Snackbar({
        message: "Clipboard permission denied",
        error: true,
        busy: false,
        onReload,
      });
      return snackbar;
    }
    const html = renderToStaticMarkup(<SnackbarProbe />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('class="snackbar snackbar-error"');
    const reload = findButton(snackbar, "Reload");
    if (!reload?.props.onClick) throw new Error("Missing Reload action.");
    reload.props.onClick();
    expect(onReload).toHaveBeenCalledOnce();
    expect(
      renderToStaticMarkup(
        <Snackbar message="Failed" error busy onReload={onReload} />,
      ),
    ).toContain('disabled=""');
  });
  it("routes the account dropdown Settings action to the account manager", () => {
    const onSettings = vi.fn();
    let header: ReactNode = null;
    function HeaderProbe() {
      header = HomeHeader({
        user: { name: "Alice", email: "alice@example.test" },
        onSettings,
      });
      return header;
    }
    const html = renderToStaticMarkup(<HeaderProbe />);
    expect(html).toContain("alice@example.test");
    for (const name of ["brand", "caretDown", "settings", "signOut"] as const) {
      expect(html).toContain(
        renderToStaticMarkup(
          <Icon
            name={name}
            {...(name === "brand" ? { className: "brand-mark" } : {})}
          />,
        ),
      );
    }
    const settings = findButton(header, "Settings");
    if (!settings?.props.onClick) throw new Error("Missing Settings action.");
    settings.props.onClick();
    expect(onSettings).toHaveBeenCalledOnce();
  });
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
    expect(html).toContain('class="home-header"');
    expect(html).toContain('href="#signin"');
    expect(html).toContain(renderToStaticMarkup(<Icon name="externalLink" />));
    expect(html).not.toContain("<footer");
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
    expect(html).toContain('class="shell home-shell canvas-shell"');
    expect(html).toContain('class="home-header has-filter"');
    expect(html).toContain('aria-label="Filter items by name or description"');
    expect(html).toContain('placeholder="Filter items..."');
    expect(html).toMatch(/popovertarget="account-menu"/i);
    expect(html).toContain('popover="auto"');
    expect(html).toContain('aria-label="Account actions"');
    expect(html).not.toContain('class="identity"');
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("<h2>Your pins</h2>");
    expect(html).not.toContain(
      "Drop one file or folder anywhere here, or use Add.",
    );
    expect(html).toContain('aria-label="Pinboard tools"');
    expect(html).toContain('aria-label="Add file"');
    expect(html).toContain('aria-label="Pinboard Settings"');
    expect(html).not.toContain("More add options");
    const toolbar = html.slice(
      html.indexOf('role="toolbar"'),
      html.indexOf("<dialog"),
    );
    expect(toolbar.match(/class="floating-button /g)).toHaveLength(2);
    expect(toolbar.match(/<svg /g)).toHaveLength(2);
    expect(toolbar).toContain(renderToStaticMarkup(<Icon name="add" />));
    expect(toolbar).toContain(renderToStaticMarkup(<Icon name="addFolder" />));
    expect(toolbar).not.toContain("Settings");
    expect(toolbar).not.toContain(">Settings</button>");
    expect(toolbar).not.toContain(">Choose folder</button>");
    expect(html.match(/<dialog/g)).toHaveLength(5);
    expect(html).toContain('aria-label="recently deleted"');
    expect(html).not.toContain('aria-label="Recently deleted"');
    expect(html).not.toContain("Open recently deleted");
    expect(html).toContain('aria-label="Pin details"');
    expect(html).not.toContain('class="intro"');
    expect(html).toContain("Create access token");
    expect(html).toContain("Background palette");
    expect(html).toContain("晨光雾屿 · Mist blue &amp; lavender");
    expect(html).toContain("玫瑰沙丘 · Sand &amp; rose");
    expect(html).toContain("晴空冰海 · Clear sky blue");
    expect(html).toContain("Choose file");
    expect(html).toContain("Choose folder");
    expect(html).toContain("drop one file or folder anywhere.");
    expect(html).not.toContain("Content type");
    expect(html).not.toContain("Raw IPFS block");
    expect(html).toContain('aria-label="access tokens filter options"');
    expect(html).toContain('aria-label="Search access tokens"');
    expect(html).toContain('<table aria-label="access tokens">');
    expect(html).not.toContain("History (revoked or expired)");
    expect(html).toContain("30");
    expect(html).toContain("30 days");
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
  it("keeps the content-wall shell neutral until the session is known", () => {
    const html = renderToStaticMarkup(
      <Dashboard state={{ kind: "loading" }} />,
    );
    expect(html).toContain('class="shell home-shell canvas-shell"');
    expect(html).toContain('class="home-header"');
    expect(html).toContain('class="loading-reveal canvas"');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Loading Pinboard..."');
    expect(html).toContain('class="loading-spinner" aria-hidden="true"');
    expect(html).toContain('class="loading-editorial" aria-hidden="true"');
    expect(html).toContain("Keep what matters.");
    expect(html).toContain("<em>Let the noise pass.</em>");
    expect(html).not.toContain('class="intro"');
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("Continue with");
    expect(html).not.toContain("Account options");
    expect(html).not.toContain("Your pins");
    expect(html).not.toContain("Keep something here.");
    expect(html).not.toContain("Checking your session");
    expect(html).not.toContain('aria-label="Pinboard tools"');
  });
  it("uses the same single loading indicator while fetching pins", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          bootstrap,
          session: { user: { name: "Alice" } },
        }}
      />,
    );
    expect(html.match(/class="loading-indicator"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Loading your pins..."');
    expect(html).toContain('class="loading-spinner" aria-hidden="true"');
    expect(html).not.toContain(">Loading your pins...</");
    expect(html).not.toContain("Checking your session");
    expect(html).not.toContain("Keep something here.");
    expect(html).not.toContain('class="pin-list"');
  });
  it("renders failure and unconfigured-provider states", () => {
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
  it("renders preview-first cards with details and CID shortcuts, without a custom menu", () => {
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
    expect(html).toContain('class="pin-info" role="group"');
    expect(html).toContain('aria-label="Pin information for photo.png"');
    expect(html).toContain(
      '<div class="pin-info-summary"><strong class="pin-name" title="photo.png">photo.png</strong><span class="pin-size">1.0 KiB</span></div>',
    );
    expect(html).toContain('<div class="pin-info-cid"><button');
    expect(html).toContain('aria-label="View details for photo.png"');
    expect(html).toContain('aria-label="Copy CID for photo.png"');
    expect(html).toContain(`<code>${pin.cid}</code>`);
    expect(html).toContain(
      '<span class="visually-hidden" role="status"></span>',
    );
    expect(html).not.toContain(`${pin.cid.slice(0, 16)}…`);
    expect(html).not.toContain(renderToStaticMarkup(<Icon name="more" />));
    expect(html).toContain(renderToStaticMarkup(<Icon name="copy" />));
    expect(html).not.toContain("<a");
    expect(html).toContain("1.0 KiB");
    expect(html).not.toContain("Pin options");
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).not.toContain("popover=");
    expect(html).not.toContain('role="menu');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain("Rename");
    expect(html).not.toContain("Copy link");
    expect(html).toContain("Copy CID");
    expect(html).not.toContain("Unpin");
    const busy = renderToStaticMarkup(
      <PinCard pin={pin} busy onOpen={() => {}} onCopyCid={() => {}} />,
    );
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
  });
  it("keeps card activation and CID copying while leaving native context-menu events alone", () => {
    const onOpen = vi.fn();
    const onCopyCid = vi.fn();
    let card: ReactNode = null;
    function CardProbe() {
      card = PinCard({
        pin: {
          cid: "bafkreia5ncapmfbrvhm3477lwtbhwrffqpujnsx7cfihnmbu3wcipu326u",
          name: "photo.png",
          size: 1024,
          blocks: 1,
          createdAt: "2026-11-05T00:00:00Z",
        },
        busy: false,
        onOpen,
        onCopyCid,
      });
      return card;
    }
    renderToStaticMarkup(<CardProbe />);
    type CardTree = ButtonTree & {
      className?: string;
      onContextMenu?: () => void;
      onKeyDown?: () => void;
    };
    function findClass(
      node: ReactNode,
      className: string,
    ): ReactElement<CardTree> | undefined {
      if (!isValidElement<CardTree>(node)) return undefined;
      if (node.props.className === className) return node;
      for (const child of Children.toArray(node.props.children)) {
        const found = findClass(child, className);
        if (found) return found;
      }
      return undefined;
    }
    const root = findClass(card, "pin-card");
    expect(root?.props.onContextMenu).toBeUndefined();
    expect(root?.props.onKeyDown).toBeUndefined();
    const open = findClass(card, "pin-open");
    const copy = findClass(card, "pin-cid");
    if (!open?.props.onClick || !copy?.props.onClick)
      throw new Error("Missing card shortcut.");
    open.props.onClick();
    copy.props.onClick();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onCopyCid).toHaveBeenCalledWith(expect.any(Function));
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
