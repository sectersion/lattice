# Contributing

## Setup

```bash
npm install
npm run build && npm start   # or: npm test
```

## Before opening a PR

- `npm test` passes — `test/integration.ts` is the source of truth for
  endpoint contract behavior. Add cases there for any new/changed endpoint.
- `npm run build` compiles clean (no `tsc` errors).
- Update `CLAUDE.md`'s endpoint list if you add, remove, or change a route.

## Scope

This project deliberately stays small — see "Deliberately not built" in
`README.md` and "Explicitly deferred" in `RESEARCH.md`. If your change adds
a dependency, an ORM, a test framework, or auth, open an issue first to
discuss whether it fits before sending a PR.

## Style

No linter/formatter is enforced. Match the existing code: flat file layout,
plain `node:sqlite` queries, no unrequested abstractions.
