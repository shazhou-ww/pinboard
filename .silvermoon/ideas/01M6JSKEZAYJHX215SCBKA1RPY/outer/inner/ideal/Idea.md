# Establish a defensible Trustless Gateway compliance baseline

## Problem

Pinboard serves verifiable raw blocks, but its HTTP contract has an unhandled
mandatory conditional-request requirement and additional interoperability and
verification gaps. Existing Kubo retrieval evidence does not establish full
Trustless Gateway conformance.

## Outcome

Provide a standards-aligned, non-recursive raw-block gateway with explicit,
testable claims about supported behavior. Keep the
[compliance requirements and gap inventory](Compliance.md) as the authoritative
scope classification, separating mandatory fixes, recommendations, optional
capabilities, and externally unverified claims.

## Boundaries

- Preserve public immutable reads, browser-safe responses, authenticated pin
  management, delegated routing, and existing custom CAR downloads.
- The mandatory baseline is raw-only: no server-side Kubo, DHT discovery,
  arbitrary CID fetching, IPNS, or standard CAR extension is required.
- Record recommended behavior and optional CAR requirements explicitly; do not
  deploy, enable push deployment, or claim production compatibility without
  authorization and separate external evidence.

## Acceptance criteria

1. Every known gap in the linked inventory has a normative classification, an
   explicit scope disposition, a source, and an observable proof obligation.
2. The selected raw-only baseline satisfies mandatory HTTP behavior, addresses
   the selected recommendation and negotiation gaps, and retains existing
   behavior outside the intentional changes.
3. Documentation and verification distinguish raw-only compliance, custom CAR
   downloads, optional standard gateway capabilities, and real production
   interoperability; no broader claim rests only on the current local PoC.
