# Phase 2F — Selective Verification Lab

This is an isolated, test-only extraction from the private source repository
`HassanKapos/Khalid-Pharmacy-1`, pinned to source snapshot
`3c50faa20f471542a85b2101be5fe762747306b9` (PR-F4 head).

## Included suites
- **PR-F0:** Firestore rules/Auth/R3.2 emulator suite.
- **PR-F1:** Pure stocktake foundation suite.
- **PR-F2:** Firestore adapter integration suite.
- **PR-F3:** Offline sidecar/reconnect emulator suite.

## Deliberate exclusions
- No Git history, production database, pharmacy data, user records, credentials,
  environment files, production Firebase project configuration, POS, or
  protected `pharmacyDb.ts` / Outbox V2 worker files were copied.
- `src/services/outboxFeatureFlags.ts` is a **lab-only test shim**, not the
  protected production file. It keeps Outbox V2 disabled for PR-F3. Results
  involving PR-F3 must be reported as shim-assisted, not byte-for-byte identical
  to the production repository.
- **PR-F4 browser E2E is NOT RUN / NOT INCLUDED in the executable workflow.**
  Its source test expects Playwright at a hard-coded Bun-global path and starts
  the full Vite application; the isolated browser bootstrap and full application
  graph are intentionally not copied into this public lab.

## Runtime
Node.js 20, OpenJDK 21, Firebase Auth + Firestore emulators, non-production
project ID `demo-khalid-pharmacy`.

Run from this directory:
- `npm install`
- `npm run typecheck`
- `npm run test:pr-f1`
- For PR-F0 / F2 / F3, use the commands in the workflow file.
