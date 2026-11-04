# Compliance requirements and gap inventory

## Baseline and evidence

This inventory records the source review on 2026-11-04 against the
[Trustless Gateway specification](https://specs.ipfs.tech/http-gateways/trustless-gateway/)
and its inherited
[Path Gateway specification](https://specs.ipfs.tech/http-gateways/path-gateway/).
Normative keywords describe upstream requirements, not issue severity.

The selected scope is a public, non-recursive, raw-block gateway. Raw support is
mandatory; CAR and IPNS record support are recommended capabilities, not
prerequisites for this raw-only baseline. In-scope recommendations below are
intentional behavior changes and require regression tests.

Current code evidence:

- [Raw gateway and provider routing](../../../../../../apps/worker/src/gateway.ts).
- [Custom complete CAR download](../../../../../../apps/worker/src/index.ts).
- [CID, block and DAG validation](../../../../../../apps/worker/src/content.ts).
- [Existing public-read tests](../../../../../../apps/worker/test/worker.test.ts).
- [Kubo evidence and external acceptance limits](../../../../../../docs/kubo.md).

## In-scope corrections

### TG-01: Conditional requests do not honor If-None-Match

**Classification:** MUST, inherited from Path Gateway request headers.

The raw handler emits an ETag but does not compare If-None-Match. Matching
requests for existing blocks therefore continue to return 200.

**Required outcome:** Matching validators return 304 without a body for GET and
HEAD. Implement HTTP validator semantics, including lists, weak comparison and
wildcard, while preserving ordinary 200 and missing-root 404 behavior.

**Proof:** Exercise matching and nonmatching validators, wildcard, weak tags,
GET, HEAD, ordinary blocks and the probe. Assert response status, headers, empty
304 bodies and unchanged successful block bytes.

### TG-02: Accept negotiation uses substring matching

**Classification:** HTTP content-negotiation correctness; not a new
format-support MUST invented by this project.

The handler uses includes("application/vnd.ipld.raw"), accepting a raw media
range with q=0 and lookalike names. It does not interpret weighted alternatives.

**Required outcome:** Match valid media ranges and acceptability rather than
substrings. Preserve explicit format precedence and document wildcard,
unsupported-type, empty-format and malformed-header behavior.

**Proof:** Cover q=0, supported/unsupported alternatives and weights, lookalike
media types, wildcard policy, malformed input, and conflicting format/Accept
requests. Do not let negotiation select an unsupported format.

### TG-03: only-if-cached does not distinguish an unavailable root

**Classification:** SHOULD in Trustless Gateway request headers.

Missing roots always receive 404, including requests carrying Cache-Control:
only-if-cached.

**Selected outcome:** Return 412 when that directive is present and the root is
unavailable locally. Keep ordinary missing-root requests at 404 and never
introduce remote retrieval.

**Proof:** GET and HEAD for existing/missing roots, combined cache directives,
and the probe; confirm successful bytes and absence of network fetching.

### TG-04: Strict-mode missing-Accept rejection differs from guidance

**Classification:** SHOULD, not a mandatory status-code violation.

Requests without format or Accept currently receive 406. The trustless
specification recommends 400 when Accept is missing in strict trustless mode.

**Selected outcome:** Use 400 for requests lacking both explicit format and
Accept. Continue accepting format=raw without Accept. Keep unsupported-format
and unsupported-Accept responses explicit, with their statuses documented.

**Proof:** Test absent, empty and unsupported headers/query parameters,
including the supported query-only form and GET/HEAD symmetry.

### TG-05: ETags do not distinguish the raw representation by name

**Classification:** Path Gateway recommendation; the existing CID-only ETag is
not a second independent MUST violation.

The raw ETag contains only the canonical CID.

**Selected outcome:** Use a representation-specific raw validator as
recommended, consistently across successful and conditional responses. Preserve
byte identity for equivalent CID forms.

**Proof:** Assert stable GET/HEAD validators and correct conditional matching;
if standard CAR is later added, raw and CAR validators must not collide.

## Optional capabilities and conditional requirements

### TG-06: Standard CAR gateway negotiation is not supported

**Classification:** SHOULD capability; deferred from this raw-only correction.

The custom /api/public/:cid/car endpoint produces a complete downloadable CAR,
but /ipfs/:cid?format=car and Accept: application/vnd.ipld.car are not
supported. A generic trustless client cannot infer the custom download URL.

**Disposition:** Retain and accurately document the custom endpoint. Do not
advertise standard CAR gateway support. A future CAR extension needs an explicit
scope decision rather than being smuggled into mandatory raw fixes.

**Conditional proof obligations if selected later:**

- Standard GET/HEAD URLs, format negotiation, the CAR probe, and unavailable
  root behavior.
- Mandatory attachment, CAR version Content-Type and ETag/conditional handling.
  The current custom download has version=1 and attachment but no ETag.
- Path proofs and dag-scope behavior for the supported CAR request surface;
  entity-bytes and other optional features must be evaluated explicitly.
- Supported version/order/duplicate signaling, unsupported-variant rejection,
  Content-Location where recommended, and representation-specific validators.
- Complete, client-verifiable content and a deliberate missing-descendant
  policy. The current custom exporter buffers and validates before responding;
  streaming missing-child rules do not describe its current implementation.

This list does not make every optional CAR parameter mandatory.

### TG-07: IPNS records and other recommended features are outside scope

**Classification:** Recommended or optional extensions, not known raw-only MUST
failures.

IPNS record retrieval is not implemented. Range responses and configurable
download filenames have no dedicated handling in the current raw route; they are
not prerequisites for this selected correction.

**Disposition:** Document the bounded raw-only surface. Do not claim IPNS,
byte-range, standard CAR path traversal or parameter support without separate
implementation and protocol tests. Raw path traversal itself is intentionally
unsupported by the specification.

## Verification gap

### TG-08: Existing evidence is not a conformance suite

**Classification:** Proof obligation and claim boundary.

The current public-read tests cover ordinary raw requests, HEAD, missing
content, one HEAD probe, provider routing and custom CAR round trips. The review
ran seven relevant tests successfully, but those tests do not establish TG-01
through TG-05, full GET/HEAD probe parity or production compatibility.

**Required outcome:** Maintain a requirement-to-test matrix for selected
behavior, run pnpm check, and preserve the documented local/production
distinction. Client-side CID verification remains essential; service-side hash
checks do not replace it.

**External proof after explicit deployment authorization:** Actual edge
TLS/HTTP2, GET/HEAD probe and headers, conditional requests, routing formats,
and byte/hash equality from an independent cold client with the source stopped.
Standard CAR/IPNS claims require their own evidence if ever selected.

## Existing behavior that is not a gap

- Anonymous GET/HEAD of stored raw blocks with original bytes, raw media type,
  attachment, immutable caching and defensive browser headers.
- Ordinary missing-root 404 and the empty identity-CID probe.
- A non-recursive local-store model without public-network discovery.
- CID/hash validation before accepted pins and complete-DAG validation.
- Delegated routing and custom CAR export as separate capabilities.

Neither a custom CAR URL nor the absence of a server-side Kubo is itself a
mandatory Trustless Gateway violation.
