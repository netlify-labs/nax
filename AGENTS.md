# Repository Rules

- All JavaScript must be typed with JSDoc annotations. Do not introduce `any` types; use precise object shapes, callbacks, `unknown`, or other explicit types instead.
- After every UI change, run the dashboard build with `npm run dashboard:build` before handing work back.
- User-facing documentation lives in `site/content`. Treat those MDX files as the canonical docs source.
- Package publishing is a human handoff. Do not run `npm publish` or another interactive registry publish. Alert the user when a release is ready, provide the exact package version, working directory, and publish command, and wait for the user to confirm publication before verifying, tagging, or continuing the rollout.
