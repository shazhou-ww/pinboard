import type { AgentToken, OAuthGrant } from "@shazhou/pinboard-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AuthorizationToolbar,
  authorizationMatches,
  fetchTokenViews,
  grantStatus,
  tokenStatus,
} from "../src/authorizations.js";
import { GrantList, OAuthGrants } from "../src/oauth.js";

const now = 1700000000000;
const token: AgentToken = {
  id: "token",
  name: "Client",
  prefix: "prefix",
  scopes: "pins:read publications:write",
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 1).toISOString(),
  revokedAt: null,
};
const grant: OAuthGrant = {
  id: "grant",
  clientId: "client",
  clientName: "Client",
  scopes: "pins:read",
  createdAt: now,
  expiresAt: now + 1,
  codeExpiresAt: now + 1,
  revokedAt: null,
  tokenIssued: true,
};

describe("authorization state and combined filtering", () => {
  it("treats expiry equal to now as expired, including pending codes and revocation at zero", () => {
    expect(tokenStatus(token, now)).toBe("Active");
    expect(
      tokenStatus({ ...token, expiresAt: new Date(now).toISOString() }, now),
    ).toBe("Expired");
    expect(
      tokenStatus({ ...token, revokedAt: "1970-01-01T00:00:00.000Z" }, now),
    ).toBe("Revoked");
    expect(grantStatus(grant, now)).toBe("Active");
    expect(grantStatus({ ...grant, expiresAt: now }, now)).toBe("Expired");
    expect(
      grantStatus({ ...grant, expiresAt: null, tokenIssued: false }, now),
    ).toBe("Awaiting code exchange");
    expect(
      grantStatus(
        { ...grant, expiresAt: null, tokenIssued: false, codeExpiresAt: now },
        now,
      ),
    ).toBe("Expired");
    expect(grantStatus({ ...grant, revokedAt: 0 }, now)).toBe("Revoked");
    expect(
      grantStatus({ ...grant, expiresAt: null, codeExpiresAt: 0 }, now),
    ).toBe("Active");
  });
  it("combines case-insensitive name and scope search with inactive inclusion", () => {
    expect(
      authorizationMatches(
        token.name,
        token.scopes,
        "Active",
        " client ",
        false,
      ),
    ).toBe(true);
    expect(
      authorizationMatches(
        token.name,
        token.scopes,
        "Active",
        "PUBLICATIONS:WRITE",
        false,
      ),
    ).toBe(true);
    expect(
      authorizationMatches(
        token.name,
        token.scopes,
        "Revoked",
        "pins:read",
        false,
      ),
    ).toBe(false);
    expect(
      authorizationMatches(
        token.name,
        token.scopes,
        "Expired",
        "pins:read",
        true,
      ),
    ).toBe(true);
    expect(
      authorizationMatches(
        token.name,
        token.scopes,
        "Expired",
        "secret-key",
        true,
      ),
    ).toBe(false);
    expect(
      authorizationMatches(
        "Client",
        "pins:read",
        "Awaiting code exchange",
        "",
        false,
      ),
    ).toBe(true);
  });
  it("fetches active plus history atomically without duplicate boundary records", async () => {
    const history = { ...token, revokedAt: new Date(now).toISOString() };
    const calls: string[] = [];
    const result = await fetchTokenViews(async (view) => {
      calls.push(view);
      return { tokens: [view === "active" ? token : history] };
    }, true);
    expect(calls).toEqual(["active", "history"]);
    expect(result).toEqual([history]);
    const activeCalls: string[] = [];
    await fetchTokenViews(async (view) => {
      activeCalls.push(view);
      return { tokens: [] };
    }, false);
    expect(activeCalls).toEqual(["active"]);
  });
  it.each(["active", "history"])(
    "fails the combined result when %s retrieval fails",
    async (failed) => {
      await expect(
        fetchTokenViews(async (view) => {
          if (view === failed) throw new Error(`${view} failed`);
          return { tokens: [token] };
        }, true),
      ).rejects.toThrow(`${failed} failed`);
    },
  );
  it("has no revoke buttons for expired token-issued, code-expired or revoked grants", () => {
    const html = renderToStaticMarkup(
      <GrantList
        grants={[
          { ...grant, expiresAt: 0 },
          { ...grant, expiresAt: null, tokenIssued: false, codeExpiresAt: 0 },
          { ...grant, revokedAt: 0 },
        ]}
        busy={false}
        onRevoke={() => {}}
      />,
    );
    expect(html).not.toContain("<button");
    expect(html.match(/authorization-badge">Expired/g)).toHaveLength(2);
  });
  it("labels glyph buttons and keeps endpoint/configuration out of OAuth", () => {
    const html = renderToStaticMarkup(
      <AuthorizationToolbar
        name="access tokens"
        query=""
        onQuery={() => {}}
        includeInactive
        disabled={false}
        onIncludeInactive={() => {}}
        action={null}
      />,
    );
    expect(html).toContain(
      'aria-label="access tokens filter options (including inactive)"',
    );
    expect(html).toContain(
      'title="access tokens filter options (including inactive)"',
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("filter-active");
    const oauth = renderToStaticMarkup(<OAuthGrants />);
    expect(oauth).not.toContain("MCP endpoint");
    expect(oauth).not.toContain("Client names");
    expect(oauth).toContain('aria-label="Refresh authorizations"');
    expect(oauth).toContain('title="Refresh authorizations"');
  });
});
