import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  defaultOAuthLifetime,
  oauthLifetimes,
  oauthLifetimeOptions,
} from "@shazhou/pinboard-contracts";
import { ConsentDetails, GrantList, OAuthSignIn } from "../src/oauth.js";

describe("MCP consent and grant management interface", () => {
  it("presents Google sign-in as a primary button separate from leaving without authorizing", () => {
    const html = renderToStaticMarkup(
      <OAuthSignIn busy={false} onSignIn={() => {}} />,
    );
    expect(html).toContain('class="panel signin oauth-panel"');
    expect(html).toContain('role="group" aria-label="Sign-in options"');
    expect(html).toContain(
      '<button type="button" class="primary" aria-busy="false">Continue with Google</button>',
    );
    expect(html).toContain('<a class="secondary" href="/">Cancel</a>');
  });
  it("shows and disables pending Google sign-in while keeping the leave action available", () => {
    const html = renderToStaticMarkup(<OAuthSignIn busy onSignIn={() => {}} />);
    expect(html).toContain(
      '<button type="button" class="primary" disabled="" aria-busy="true">Connecting to Google...</button>',
    );
    expect(html).toContain('<a class="secondary" href="/">Cancel</a>');
  });
  it("escapes unverified client text, hides the callback and presents named permissions", () => {
    const html = renderToStaticMarkup(
      <ConsentDetails
        consent={{
          accountId: "alice",
          clientId: "client-id",
          clientName: "<script>alert(1)</script>",
          redirectUri: "https://vscode.dev/redirect",
          resource: "https://example.test/mcp",
          scopes: [
            "pins:read",
            "pins:write",
            "pins:delete",
            "publications:read",
            "publications:write",
            "publications:delete",
          ],
          expiresAt: Date.now() + 600000,
        }}
        selected={["pins:read"]}
        lifetime={defaultOAuthLifetime}
        busy={false}
        onToggle={() => {}}
        onLifetimeChange={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    for (const text of [
      "Unverified client",
      "https://example.test/mcp",
      "alice",
      "<strong>Read pins</strong>: View your pins.",
      "<strong>Write pins</strong>:",
      "<strong>Delete pins</strong>:",
      "<strong>Read publications</strong>:",
      "<strong>Write publications</strong>:",
      "<strong>Delete publications</strong>:",
      "public content",
      "Move pins to trash",
      "Uploads are public",
      "Google credentials aren&#x27;t shared",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("https://vscode.dev/redirect");
    expect(html).not.toContain("Return address");
    expect(html).not.toContain("one hour");
    expect(html).toContain('class="oauth-permissions"');
    expect(html.match(/class="oauth-permission"/g)).toHaveLength(6);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('class="panel oauth-panel"');
    expect(html).toContain(
      '<button type="button" class="primary">Allow</button>',
    );
    expect(html).toContain(
      '<button type="button" class="secondary">Cancel</button>',
    );
  });
  it("disables approval without permissions and disables decisions during submission", () => {
    const consent = {
      accountId: "alice",
      clientId: "client",
      clientName: "VS Code",
      redirectUri: "https://vscode.dev/redirect",
      resource: "https://example.test/mcp",
      scopes: ["pins:read"],
      expiresAt: 1,
    };
    const empty = renderToStaticMarkup(
      <ConsentDetails
        consent={consent}
        selected={[]}
        lifetime={defaultOAuthLifetime}
        busy={false}
        onToggle={() => {}}
        onLifetimeChange={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(empty).toContain('disabled="">Allow');
    expect(empty).toContain("Select at least one permission.");
    const busy = renderToStaticMarkup(
      <ConsentDetails
        consent={consent}
        selected={["pins:read"]}
        lifetime={defaultOAuthLifetime}
        busy
        onToggle={() => {}}
        onLifetimeChange={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(busy.match(/disabled=""/g)).toHaveLength(4);
  });
  it.each(oauthLifetimes)(
    "renders the %s lifetime and its explanation",
    (lifetime) => {
      const html = renderToStaticMarkup(
        <ConsentDetails
          consent={{
            accountId: "alice",
            clientId: "client",
            clientName: "VS Code",
            redirectUri: "https://vscode.dev/redirect",
            resource: "https://example.test/mcp",
            scopes: ["pins:read", "future:scope"],
            expiresAt: 1,
          }}
          selected={["pins:read"]}
          lifetime={lifetime}
          busy={false}
          onToggle={() => {}}
          onLifetimeChange={() => {}}
          onDecide={() => {}}
        />,
      );
      expect(defaultOAuthLifetime).toBe("1d");
      expect(html).toContain(
        `<option value="${lifetime}" selected="">${oauthLifetimeOptions[lifetime].label}</option>`,
      );
      expect(html).toContain(
        lifetime === "never"
          ? "No expiry. Access lasts until you revoke it."
          : "Revoke anytime from the homepage.",
      );
      expect(html).toContain("<strong>future:scope</strong>");
    },
  );
  it("distinguishes active, expired, pending and revoked grants; exposes only non-revoked revoke actions", () => {
    const grant = {
      id: "1",
      clientId: "client",
      clientName: "<client>",
      scopes: "pins:read",
      createdAt: 1,
      codeExpiresAt: Date.now() + 60000,
      tokenIssued: true,
      expiresAt: Date.now() + 3600000,
      revokedAt: null,
    };
    const html = renderToStaticMarkup(
      <GrantList
        grants={[
          grant,
          { ...grant, id: "2", expiresAt: 0 },
          { ...grant, id: "3", expiresAt: null, tokenIssued: false },
          { ...grant, id: "4", revokedAt: 0 },
          {
            ...grant,
            id: "5",
            expiresAt: null,
            codeExpiresAt: 1,
            tokenIssued: false,
          },
          { ...grant, id: "6", expiresAt: null, codeExpiresAt: 1 },
        ]}
        busy={false}
        onRevoke={() => {}}
      />,
    );
    for (const status of [
      "Active",
      "Expired",
      "Awaiting code exchange",
      "Revoked",
    ])
      expect(html).toContain(status);
    expect(html.match(/Revoke client authorization/g)).toHaveLength(5);
    expect(html.match(/class="muted">Expired/g)).toHaveLength(2);
    expect(html.match(/class="muted">Active/g)).toHaveLength(2);
    expect(html).toContain('class="token-list"');
    expect(html.match(/class="authorization-actions"/g)).toHaveLength(6);
    expect(html).toContain("Never expires");
    expect(html).toContain("&lt;client&gt;");
    expect(html).not.toContain("access_token");
  });
});
