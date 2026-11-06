import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Publication } from "@shazhou/pinboard-contracts";
import { AccountManager, PinCard, publishUploadedPin } from "../src/manager.js";
import { PublicationDialog, DeletedDialog } from "../src/publications.js";
import { Icon } from "../src/icon.js";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { NodeDescriptionEditor } from "../src/node-description.js";

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
afterEach(() => vi.unstubAllGlobals());
describe("publication wall identity and management", () => {
  it("routes external and internal card events without bubbling into document upload handlers", () => {
    type EventProps = {
      children?: ReactNode;
      onDragStart?: (event: unknown) => void;
      onDragEnter?: (event: unknown) => void;
      onDragOver?: (event: unknown) => void;
      onDrop?: (event: unknown) => void;
      onClick?: () => void;
    };
    let tree: ReactElement<EventProps>;
    const drop = vi.fn();
    const convert = vi.fn();
    const uploadFile = vi.fn();
    const uploadFolder = vi.fn();
    function Probe({ publication: item }: { publication?: Publication }) {
      tree = PinCard({
        pin,
        ...(item ? { publication: item } : {}),
        busy: false,
        onOpen: noop,
        onCopyCid: noop,
        onCopyLink: noop,
        onUnpin: noop,
        onDrop: drop,
        onConvert: convert,
        onUploadFile: uploadFile,
        onUploadFolder: uploadFolder,
      });
      return tree;
    }
    const find = (
      node: ReactNode,
      text: string,
    ): ReactElement<EventProps> | undefined => {
      if (!isValidElement<EventProps>(node)) return undefined;
      if (
        node.type === "button" &&
        Children.toArray(node.props.children).includes(text)
      )
        return node;
      for (const child of Children.toArray(node.props.children)) {
        const found = find(child, text);
        if (found) return found;
      }
      return undefined;
    };
    const fixed = renderToStaticMarkup(<Probe />);
    expect(fixed).toContain('draggable="true"');
    const dataTransfer = {
      types: ["Files"],
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer,
    };
    tree!.props.onDragStart!(event);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-pinboard-pin",
      pin.cid,
    );
    expect(dataTransfer.effectAllowed).toBe("link");
    tree!.props.onDragEnter!(event);
    tree!.props.onDragOver!(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(dataTransfer.dropEffect).toBe("copy");
    tree!.props.onDrop!(event);
    expect(drop).toHaveBeenCalledWith(event);
    find(tree!, "Convert to publication")!.props.onClick!();
    find(tree!, "Convert & upload file")!.props.onClick!();
    find(tree!, "Convert & upload folder")!.props.onClick!();
    expect(convert).toHaveBeenCalledOnce();
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(uploadFolder).toHaveBeenCalledOnce();
    const published = renderToStaticMarkup(<Probe publication={publication} />);
    expect(published).toContain('draggable="false"');
    dataTransfer.types = ["application/x-pinboard-pin"];
    tree!.props.onDragOver!(event);
    expect(dataTransfer.dropEffect).toBe("link");
    dataTransfer.types = ["text/plain"];
    event.preventDefault.mockClear();
    tree!.props.onDragOver!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("offers explicit conversion with a blank public title, and separate read-only public root/child lookup", () => {
    const html = renderToStaticMarkup(
      <PublicationDialog
        publication={null}
        pin={pin}
        pins={[pin]}
        publications={[publication]}
        convert
        onClose={noop}
        onChanged={async () => {}}
      />,
    );
    expect(html).toContain("original content becomes v1");
    expect(html).toContain("Public title");
    expect(html).not.toContain('value="Private label"');
    expect(html).not.toContain("Create a publication</option>");
    expect(html).toContain("draft description changes");
    const editor = renderToStaticMarkup(
      <NodeDescriptionEditor rootCid={pin.cid} />,
    );
    expect(editor).toContain("Node CID (root or reachable child)");
    expect(editor).toContain("Read node");
    const readOnly = renderToStaticMarkup(
      <NodeDescriptionEditor
        rootCid={pin.cid}
        publicationId={publication.id}
        revision={1}
      />,
    );
    expect(readOnly).toContain("Published node description");
    expect(readOnly).not.toContain("Save description");
  });
  it("offers upload-time creation even when the account has no publications", () => {
    const html = renderToStaticMarkup(
      <AccountManager renderHeader={() => null} />,
    );
    expect(html).toContain(
      '<option value="" selected="">Keep as a pin only</option>',
    );
    expect(html).toContain(
      '<option value="create">Create a publication</option>',
    );
  });

  it("creates an uploaded publication with explicit public title, not the private pin name", async () => {
    const result = { publication, status: "published" };
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json(result, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await publishUploadedPin(pin, { title: " Public title " })).toEqual(
      result,
    );
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/publications");
    expect(JSON.parse(init.body)).toEqual({
      cid: pin.cid,
      title: "Public title",
      public: true,
      requestId: expect.any(String),
    });
    expect(init.body).not.toContain(pin.name);
  });

  it("preserves existing-publication CAS and current-CID NOP behavior", async () => {
    const result = { publication, status: "nop" };
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    expect(await publishUploadedPin(pin, publication)).toEqual(result);
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe(`/api/publications/${publication.id}/publish`);
    expect(JSON.parse(init.body)).toEqual({
      cid: pin.cid,
      expectedSequence: publication.sequence,
      requestId: expect.any(String),
    });
  });

  it.each([{ title: "Public title" }, publication])(
    "reports preserved upload and retry identity when publication fails",
    async (target) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "Conflict" }, { status: 409 }),
        );
      vi.stubGlobal("fetch", fetch);
      await expect(publishUploadedPin(pin, target)).rejects.toThrow(
        `Pin ${pin.cid} is preserved. Retry publication request`,
      );
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

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
