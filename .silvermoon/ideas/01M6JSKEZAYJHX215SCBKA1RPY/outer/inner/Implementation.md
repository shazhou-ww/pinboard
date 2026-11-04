# Implementation

This preparation seed is provisional and is not accepted with the Idea.

## Steps

### I-S01: Refine the selected protocol matrix

Translate TG-01 through TG-05 and TG-08 from the
[gap inventory](ideal/Compliance.md) into a request/response regression matrix.
Keep TG-06 and TG-07 explicitly deferred and identify intentional status and
validator changes before editing the gateway.

### I-S02: Repair raw gateway behavior and add regression coverage

Implement conditional requests, media negotiation, selected cache/rejection
semantics and representation-specific validators using existing repository
patterns. Preserve public reads, routing, authorization and custom CAR export.

### I-S03: Align documentation and validate the repository

Document the exact supported surface, intentional changes, deferred capabilities
and evidence boundaries. Run focused protocol tests and pnpm check.

## Acceptance criteria

### I-AC01: Selected protocol requirements have executable proof

Tests demonstrate every selected outcome in TG-01 through TG-05, including
GET/HEAD, probe and unavailable-root edge cases. A requirement-to-test matrix
accounts for each case and explicitly deferred capability.

### I-AC02: Existing behavior remains intact outside selected changes

Regression tests preserve block bytes, browser-safe headers, ordinary missing
content, routing, authenticated pin management and custom complete CAR
downloads. No remote CID retrieval is introduced.

### I-AC03: Checks pass and claims match the implemented surface

pnpm check passes. API and Kubo documentation accurately distinguish raw-only
behavior, optional/deferred capabilities and unverified production claims.
