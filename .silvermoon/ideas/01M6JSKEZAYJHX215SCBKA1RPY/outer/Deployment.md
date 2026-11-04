# Deployment

This preparation seed is provisional and is not accepted with the Idea.

## Steps

### D-S01: Prepare an authorization-bound external acceptance checklist

Identify the release, origin, selected protocol surface, independent client
fixture and evidence to collect. Do not deploy or enable push deployment.

### D-S02: Verify the authorized release against the actual public edge

Only after explicit deployment authorization, test edge TLS/HTTP2, raw
GET/HEAD/probe behavior, conditional requests, routing and independent cold
retrieval with byte/hash comparisons and the source stopped.

### D-S03: Record reproducible external evidence and bounded claims

Record release identifiers, requests, results and client reconstruction
evidence. Separate raw-only conformance from Kubo interoperability and any
future optional capability; do not infer an untested result.

## Acceptance criteria

### D-AC01: Deployment authorization and release identity are explicit

Evidence identifies the approved deployment and immutable release. Without
authorization this phase remains blocked, not implicitly passed.

### D-AC02: Actual public behavior satisfies the selected protocol matrix

Recorded edge requests and independent cold-client byte/hash equality prove the
selected public outcomes for the identified release.

### D-AC03: Published compatibility claims have traceable external proof

Every production compatibility claim links to reproducible external evidence.
Deferred or unverified capabilities are labeled and no local-only workaround is
presented as production configuration.
