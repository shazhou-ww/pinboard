export function installReadingFixture() {
  const cid = (n) =>
    `bafkreigh2akiscaildcxxbmjcwt4svm6yv6oubkcb3i3m2ak6bpgxy3s6${n}`;
  const date = "2026-11-01T10:00:00Z";
  const pins = [
    {
      cid: cid("a"),
      name: "Reading fixture — " + "long name ".repeat(16),
      size: 120,
      blocks: 1,
      createdAt: date,
    },
    {
      cid: cid("b"),
      name: "Second owned pin",
      size: 240,
      blocks: 2,
      createdAt: date,
    },
  ];
  const revisions = Array.from({ length: 5 }, (_, i) => ({
    revision: i + 1,
    cid: cid(String(i + 1)),
    size: 100 * (i + 1),
    blocks: i + 1,
    createdAt: date,
  }));
  const publication = {
    id: "reading-fixture",
    title: "Reading publication",
    currentRevision: 3,
    revisionCount: 5,
    sequence: 6,
    createdAt: date,
    updatedAt: date,
    current: revisions[2],
  };
  const single = {
    ...publication,
    id: "single-fixture",
    title: "Single-version publication",
    currentRevision: 1,
    revisionCount: 1,
    sequence: 1,
    current: revisions[0],
  };
  const state = (window.__readingTest = {
    pins,
    publication,
    single,
    revisions,
    requests: [],
    version: 1,
    text: "Private fixture description",
    historyFailure: false,
    descriptionFailure: false,
    conflict: false,
    publishFailure: false,
    previewStatus: "ready",
    previewKind: "text",
    lateRevision: 0,
    delayWrite: 0,
  });
  const originalFetch = window.fetch.bind(window);
  const preview = (label) => {
    const base = {
      version: 3,
      status: state.previewStatus,
      truncated: true,
      contentType: "text/plain",
    };
    if (state.previewStatus !== "ready")
      return { ...base, truncated: false, preview: null };
    if (state.previewKind === "directory")
      return {
        ...base,
        contentType: "inode/directory",
        preview: {
          kind: "directory",
          entries: [{ name: "notes.txt", kind: "file", depth: 0 }],
          total: 1,
        },
      };
    if (["image", "pdf"].includes(state.previewKind))
      return {
        ...base,
        contentType:
          state.previewKind === "pdf" ? "application/pdf" : "image/png",
        preview: {
          kind: "image",
          image: {
            cid: cid("a"),
            url: `/ipfs/${cid("a")}`,
            width: 480,
            height: 360,
          },
        },
      };
    return { ...base, preview: { kind: "text", text: label } };
  };
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/ipfs/"))
      return new Response(
        Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
          ),
          (c) => c.charCodeAt(0),
        ),
        { headers: { "content-type": "image/png" } },
      );
    if (!url.pathname.startsWith("/api/")) return originalFetch(input, init);
    const path = url.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ path, method, body });
    const result = (data, status = 200) => Response.json(data, { status });
    if (path === "/api/bootstrap")
      return result({
        appName: "Pinboard",
        providers: [{ id: "google", label: "Google" }],
      });
    if (path === "/api/auth/session")
      return result({
        user: {
          id: "synthetic",
          name: "Synthetic local test",
          email: "fixture@example.test",
        },
      });
    if (["/api/tokens", "/api/oauth/grants"].includes(path))
      return result(path.endsWith("tokens") ? { tokens: [] } : { grants: [] });
    if (path === "/api/pins/previews")
      return result({
        previews: body.cids.map((value) => ({
          cid: value,
          preview: preview("Card excerpt"),
        })),
      });
    if (path === "/api/pins")
      return result({ pins: state.pins, nextCursor: null });
    if (path === "/api/publications" && method === "GET")
      return result({ publications: [publication, single], nextCursor: null });
    if (path.endsWith("/history")) {
      if (state.historyFailure)
        return result({ error: "Fixture history unavailable" }, 503);
      const pub = path.includes("single-fixture") ? single : publication;
      return result({
        publication: pub,
        revisions: pub === single ? [revisions[0]] : revisions,
      });
    }
    if (/\/publications\/[^/]+\/preview\/\d+$/.test(path))
      return result(preview("Publication card"));
    if (path.endsWith("/description")) {
      const version = Number(/\/versions\/(\d+)\//.exec(path)?.[1]);
      const root = version ? revisions[version - 1].cid : path.split("/")[3];
      if (path.split("/").at(-2) !== root)
        return result(
          { error: "Node is not reachable from authorized root" },
          404,
        );
      if (state.descriptionFailure)
        return result({ error: "Fixture description unavailable" }, 503);
      if (method === "PUT") {
        if (state.delayWrite)
          await new Promise((resolve) => setTimeout(resolve, state.delayWrite));
        if (state.conflict)
          return result(
            { error: "Description conflict; refresh required" },
            409,
          );
        if (body.expectedVersion !== state.version)
          return result({ error: "Version conflict" }, 409);
        state.text = body.text;
        state.version++;
      }
      if (version === state.lateRevision)
        await new Promise((resolve) => setTimeout(resolve, 650));
      return result({
        rootCid: root,
        nodeCid: root,
        description: {
          user: {
            text: version ? `Public snapshot v${version}` : state.text,
            version: version || state.version,
          },
          preview: preview(
            version ? `Version ${version} excerpt` : "Private content excerpt",
          ),
        },
      });
    }
    if (method === "POST" && path.endsWith("/rollback")) {
      if (body.expectedSequence !== publication.sequence)
        return result({ error: "Sequence conflict" }, 409);
      publication.currentRevision = body.revision;
      publication.current = revisions[body.revision - 1];
      publication.sequence++;
      return result({ publication, status: "rolled-back" });
    }
    if (method === "POST" && path.endsWith("/publish")) {
      if (state.publishFailure)
        return result(
          { error: "Fixture publication failed; pin preserved" },
          503,
        );
      if (body.expectedSequence !== publication.sequence)
        return result({ error: "Sequence conflict" }, 409);
      return result({ publication, status: "nop" });
    }
    if (
      method === "POST" &&
      (path === "/api/publications" || path.endsWith("/convert"))
    )
      return result({ publication, status: "nop" });
    if (path.startsWith("/api/pins/") && !path.includes("/nodes/")) {
      const pin = state.pins.find((item) => path.includes(item.cid));
      if (!pin) return result({ error: "Pin not found" }, 404);
      if (method === "PATCH") pin.name = body.name;
      if (method === "DELETE")
        state.pins = state.pins.filter((item) => item !== pin);
      return result(pin);
    }
    if (path === "/api/public/reading-thumbnail")
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    return result({ error: `Unmocked local API ${method} ${path}` }, 404);
  };
}
