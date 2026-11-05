import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
    expect(html).toContain(
      '<a class="secondary" href="/">Leave without authorizing</a>',
    );
  });
  it("shows and disables pending Google sign-in while keeping the leave action available", () => {
    const html = renderToStaticMarkup(<OAuthSignIn busy onSignIn={() => {}} />);
    expect(html).toContain(
      '<button type="button" class="primary" disabled="" aria-busy="true">Connecting to Google...</button>',
    );
    expect(html).toContain(
      '<a class="secondary" href="/">Leave without authorizing</a>',
    );
  });
  it("escapes unverified client text, displays exact callback/resource and requires explicit scoped consent", () => {
    const html = renderToStaticMarkup(
      <ConsentDetails
        consent={{
          accountId: "alice",
          clientId: "client-id",
          clientName: "<script>alert(1)</script>",
          redirectUri: "https://vscode.dev/redirect",
          resource: "https://example.test/mcp",
          scopes: ["pins:read", "pins:write", "pins:delete"],
          expiresAt: Date.now() + 600000,
        }}
        selected={["pins:read"]}
        busy={false}
        onToggle={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    for (const text of [
      "not verified",
      "https://vscode.dev/redirect",
      "https://example.test/mcp",
      "alice",
      "Read your pins",
      "public content",
      "Remove your pin",
      "Allow selected permissions",
      "Cancel connection",
      "one hour",
      "Google credentials are never shared",
    ])
      expect(html).toContain(text);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('class="panel oauth-panel"');
    expect(html).toContain(
      '<button type="button" class="primary">Allow selected permissions</button>',
    );
    expect(html).toContain(
      '<button type="button" class="secondary">Cancel connection</button>',
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
        busy={false}
        onToggle={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(empty).toContain('disabled="">Allow selected permissions');
    const busy = renderToStaticMarkup(
      <ConsentDetails
        consent={consent}
        selected={["pins:read"]}
        busy
        onToggle={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(busy.match(/disabled=""/g)).toHaveLength(3);
  });
  it("distinguishes active, expired, pending and revoked grants; exposes only non-revoked revoke actions", () => {
    const grant = {
      id: "1",
      clientId: "client",
      clientName: "<client>",
      scopes: "pins:read",
      createdAt: 1,
      codeExpiresAt: Date.now() + 60000,
      expiresAt: Date.now() + 3600000,
      revokedAt: null,
    };
    const html = renderToStaticMarkup(
      <GrantList
        grants={[
          grant,
          { ...grant, id: "2", expiresAt: 1 },
          { ...grant, id: "3", expiresAt: null },
          { ...grant, id: "4", revokedAt: 1 },
          { ...grant, id: "5", expiresAt: null, codeExpiresAt: 1 },
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
    expect(html.match(/Revoke client authorization/g)).toHaveLength(4);
    expect(html.match(/— Expired/g)).toHaveLength(2);
    expect(html).toContain("&lt;client&gt;");
    expect(html).not.toContain("access_token");
  });
});
