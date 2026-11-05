import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Publication } from "@shazhou/pinboard-contracts";
import { PinCard } from "../src/manager.js";
import { PublicationDialog, DeletedDialog } from "../src/publications.js";
import { Icon } from "../src/icon.js";

const pin = {
  cid: "bafkreigh2akiscaildcxxbmjcwt4svm6yv6oubkcb3i3m2ak6bpgxy3s6a",
  name: "Private label",
  size: 100,
  blocks: 1,
  createdAt: "2026-11-01T10:00:00Z",
};
const publication: Publication = {
  id: "publication-a",
  title: "Public field notes",
  currentRevision: 3,
  revisionCount: 5,
  sequence: 6,
  createdAt: pin.createdAt,
  updatedAt: pin.createdAt,
  current: {
    revision: 3,
    cid: pin.cid,
    size: 100,
    blocks: 1,
    createdAt: pin.createdAt,
  },
};
const noop = () => {};
describe("publication wall identity and management", () => {
  it("uses the exact pin card frame while distinguishing current revision from total history after rollback", () => {
    const render = (item?: Publication) =>
      renderToStaticMarkup(
        <PinCard
          pin={item ? { ...pin, name: item.title } : pin}
          {...(item ? { publication: item } : {})}
          busy={false}
          onOpen={noop}
          onCopyCid={noop}
          onCopyLink={noop}
          onUnpin={noop}
        />,
      );
    const fixed = render();
    const published = render(publication);
    for (const html of [fixed, published])
      expect(html).toContain('class="pin-card"');
    expect(fixed).not.toContain("publication-badge");
    expect(published).toContain('class="publication-badge"');
    expect(published).toContain(
      renderToStaticMarkup(<Icon name="publication" size={14} />),
    );
    expect(published).toContain("Current v3 · 5 versions");
    expect(published).not.toContain("Current v5");
    expect(published).not.toContain("Private label");
    expect(published).toContain("Copy follow link");
    expect(published).toContain("Manage publication &amp; history");
    expect(
      render({ ...publication, currentRevision: 1, revisionCount: 1 }),
    ).toContain("Publication");
  });

  it("explains public title/history versus private pin identity before creating a publication", () => {
    const html = renderToStaticMarkup(
      <PublicationDialog
        publication={null}
        pin={pin}
        pins={[pin]}
        publications={[publication]}
        onClose={noop}
        onChanged={async () => {}}
      />,
    );
    expect(html).toContain("complete version history are visible to everyone");
    expect(html).toContain(
      "private pin label and account identity stay private",
    );
    expect(html).toContain("Public title");
    expect(html).toContain("Create a publication");
    expect(html).toContain("current v3");
  });

  it("labels follow, fixed-version and CID copies independently and explains recovery expiry", () => {
    const html = renderToStaticMarkup(
      <PublicationDialog
        publication={publication}
        pin={null}
        pins={[pin]}
        publications={[publication]}
        onClose={noop}
        onChanged={async () => {}}
      />,
    );
    expect(html).toContain("Copy follow link");
    expect(html).toContain("Copy fixed v3 link");
    expect(html).toContain("Copy current CID");
    expect(html).toContain("5 versions");
    const deleted = renderToStaticMarkup(
      <DeletedDialog open onClose={noop} onChanged={async () => {}} />,
    );
    expect(deleted).toContain("Restore within 30 days");
    expect(deleted).toContain(
      "last reference then starts a seven-day cleanup grace period",
    );
  });
});
