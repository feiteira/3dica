# Contributing to 3Dica

Thanks for helping. Bug reports, ideas, documentation fixes and pull requests are all welcome. For anything bigger than
a small fix, open an issue first so we can agree on the approach before you write a lot of code.

By contributing you agree that your contribution is released under the [MIT License](LICENSE). Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 20.19 or newer (22 LTS recommended) and git.

```sh
git clone https://github.com/feiteira/3dica.git
cd 3dica
npm ci
npx playwright install chromium   # once per machine, for the e2e tests and the manual screenshots
npm run dev                       # http://localhost:5173, add ?fresh to start from the sample
```

Use `npm ci`, not `npm install`, so you get the exact versions in `package-lock.json`. Every dependency is pinned to an
exact version (no `^` or `~`). If you need to change one, say why in the pull request.

To work on the manual, run `npm run docs:dev` and open <http://localhost:5180/3dica/manual/>.

## Find your way around

- The manual's developer pages explain the design:
  [Architecture](https://feiteira.github.io/3dica/manual/dev/architecture.html) and
  [Contributing](https://feiteira.github.io/3dica/manual/dev/contributing.html).
- `src/app/context.ts` is the cross-layer contract: the interfaces that `eval/`, `view/`, `ui/` and `app/` code
  against, and a map of where each piece of pure logic lives.
- `docs/design/spec-v0.1.md` is the historical v0.1 design spec. Code comments refer to its sections as `§4.5` and so
  on. When the spec and the code disagree, the code is right; the spec lists the known deviations at the top.

## Checks that must pass

Run these before you open a pull request. CI runs the same steps on every push and pull request.

```sh
npm run typecheck     # tsc, strict
npm test              # vitest unit tests
npm run test:e2e      # Playwright, against the dev server
npm run build:site    # the app and the manual, as GitHub Pages serves them
```

- `PW_PORT=<port> npm run test:e2e` runs the e2e server on a free port if 5173 is taken.
- `npm run test:e2e:preview` runs the same scenarios against a production build. Run it when you touch the build,
  the worker or anything path-related.
- The manual build fails on dead links. Link only to pages that exist, or to full `https://` URLs.
- If your change alters what the UI looks like, regenerate the manual's screenshots with `npm run docs:shots` and check
  the result.

## Code style

- **TypeScript, strict.** `tsconfig.json` turns on `strict`, `noUnusedLocals`, `noUnusedParameters` and
  `erasableSyntaxOnly`. That means **no `enum`s** and no constructor parameter properties. Use string-literal unions and
  plain fields instead.
- **`src/core/` stays pure.** No DOM, no three.js, no `Worker`. Everything in it is unit-tested in Node. If you add logic
  that could live in `core/`, put it there and test it in `tests/unit/`.
- **Project edits go through `src/app/commands.ts`.** Each user action is one `store.update(...)`, so one action is one
  undo step. Mutations live in `src/core/ops.ts` and throw `OpError` with a readable message.
- **No UI framework.** Panels are plain TypeScript (`mount(el, ctx)`) built with the `h()` helper in `src/ui/dom.ts`.
- **Every interactive control gets a `data-testid`.** The e2e tests and the manual screenshots rely on them.
- **No `window.alert`, `confirm` or `prompt`.** Use `ctx.confirm`, `ctx.toast` and `ctx.problems` (`src/ui/dom.ts`).
- **Keep the § references meaningful.** When a comment points at a spec section, the section should describe that
  code. If you change behaviour that the spec describes, update the comment, and add the change to the
  "Known deviations" list in `docs/design/spec-v0.1.md` if it is a lasting difference.
- **Document user-visible changes** in the manual (`docs/`) and in [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.
- Match the formatting of the code around you. `.editorconfig` sets 2-space indentation, LF and UTF-8.

## Tests

- **Unit tests** (`tests/unit/*.test.ts`) run in Node with real JSCAD. Add one for every change to `core/`, the
  engine or the store.
- **End-to-end tests** (`tests/e2e/*.spec.ts`) drive the real app in Chromium through `window.__3dica`, the small test
  API installed by `src/main.ts`. Each test collects console errors and fails on any. Add a scenario for every
  user-visible fix (`fixes.spec.ts` holds the regressions).
- Use `?fresh` to start a test from the sample, and `?evalTimeout=<ms>` to shorten the runaway-code timeout.

## Pull requests

Keep each pull request focused on one change, and describe what changed and why. The template asks for this
checklist:

- [ ] `npm run typecheck`, `npm test` and `npm run test:e2e` pass
- [ ] `npm run build:site` passes (the app builds and the manual has no dead links)
- [ ] New logic in `core/` or the engine has unit tests, and user-visible fixes have an e2e scenario
- [ ] The manual and `CHANGELOG.md` are updated for user-visible changes
- [ ] No new dependency, or an exact version and a reason in the description

## Reporting bugs

Open an [issue](https://github.com/feiteira/3dica/issues/new/choose) with the steps to reproduce, what you expected and
what happened, plus your browser and OS. A small `.3dica.json` that shows the problem helps a lot. For security
problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
