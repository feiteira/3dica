# Contributing

3Dica is developed in the open at [github.com/feiteira/3dica](https://github.com/feiteira/3dica). Bug reports, ideas,
documentation fixes and pull requests are all welcome. For anything bigger than a small fix, open an issue first so
the approach can be agreed before you write a lot of code. Contributions are released under the MIT License.

This page covers the development setup, the scripts, the three kinds of tests, building the site and the coding
conventions. [Architecture](/dev/architecture) explains how the code fits together.

## Set up

You need **Node.js 20.19 or newer** (22 LTS recommended) and git.

```sh
git clone https://github.com/feiteira/3dica.git
cd 3dica
npm ci
npx playwright install chromium   # once per machine: the browser for the e2e tests and the manual screenshots
npm run dev                       # http://localhost:5173
```

- Use `npm ci`, not `npm install`, so you get exactly the versions in `package-lock.json`. Every dependency is pinned to
  an exact version (no `^` or `~`). If you need to change one, say why in the pull request.
- Open `http://localhost:5173/?fresh` to start from the sample project and ignore the autosave. Your own autosave on
  localhost is separate from the one of the published app.
- Add `?evalTimeout=3000` to shorten the 20 s runaway-code timeout while you test error handling.
- To work on the MCP server, see [AI assistants (MCP)](/guide/mcp).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173, with hot reload |
| `npm run build` | Type-check, then build the app into `dist/` |
| `npm run preview` | Serve the production build on port 4173 |
| `npm run typecheck` | `tsc` in strict mode, no output |
| `npm test` | The unit tests (vitest, Node) |
| `npm run test:watch` | The unit tests in watch mode |
| `npm run test:e2e` | The end-to-end tests (Playwright) against a dev server it starts |
| `npm run test:e2e:preview` | The same scenarios against a production build |
| `npm run test:all` | Type-check, unit tests and e2e tests |
| `npm run docs:dev` | The manual with hot reload, at `http://localhost:5180/3dica/manual/` |
| `npm run docs:build` | Build the manual into `dist/manual/` |
| `npm run docs:preview` | Serve the built manual on port 4180 |
| `npm run docs:shots` | Regenerate the manual's screenshots in `docs/public/shots/` |
| `npm run build:site` | The app and then the manual: the whole GitHub Pages site in `dist/` |
| `npm run mcp` | Start the MCP server (normally your MCP client starts it) |

## Tests

### Unit tests

`tests/unit/*.test.ts` run in Node with vitest and the real JSCAD library: the pure core (graph expansion, ops,
specs and keys, hashing, the file format, selection rules, transforms), the evaluation engine, the client with a fake
worker, the store and history, autosave, the controller, picking, the MCP server and its handlers, the AI chat's
loop, tools, settings and provider adapters, and the OpenSCAD interpreter and builder (`scad-*.test.ts`, with
expected output recorded from the OpenSCAD 2021.01 binary).

```sh
npm test
npx vitest run tests/unit/engine.test.ts   # one file
```

Add a unit test for every change to `src/core/`, the engine or the store. Because `core/` and the engine have no DOM
or browser dependencies, you can also use a throwaway test to try JSCAD code: `createEngine()` from
`src/eval/engine.ts` runs a job exactly as the worker does.

### End-to-end tests

`tests/e2e/*.spec.ts` drive the real app in Chromium. `app.spec.ts` holds the main scenarios, `fixes.spec.ts` the
regressions, `mcp.spec.ts` the MCP server talking to a real tab and `chat.spec.ts` the AI chat. Each test boots
`/?fresh`, waits for `window.__3dica.ready` and `idle()`, and fails if the page logs an error.

```sh
npm run test:e2e
PW_PORT=5199 npm run test:e2e       # use another port if 5173 is taken
npx playwright test -g "STL export"   # one scenario by name
```

- The e2e server always starts fresh on its port (`reuseExistingServer` is off), so a dev server you have open must be
  on a different port. `PW_PORT` sets the port for both `test:e2e` and `test:e2e:preview`.
- Tests read the app's state through `window.__3dica` (see [the test API](/dev/architecture#the-test-api)) and find
  elements by `data-testid`.
- Add a scenario for every user-visible fix.
- Run `npm run test:e2e:preview` too when you touch the build, the worker or anything path-related.

### Testing the AI chat without a key

The chat's tests never call a real model and need no API key. Don't add a test that does: it would cost money, need
a secret, and give a different answer on every run.

- **Unit tests** (`tests/unit/agent-*.test.ts`, `providers-*.test.ts`) drive the `ChatController` with a fake
  session and fake tools, run the real tools against a real store with a fake evaluator
  (`tests/unit/agent-fixtures.ts`), and test each provider adapter with a mocked `fetch` that returns recorded-shape
  streams.
- **End to end** (`tests/e2e/chat.spec.ts`), `page.route` answers `https://api.anthropic.com` and an
  OpenAI-compatible `https://mock.example/v1` with Server-Sent Events, the way the real APIs stream. The model's tool
  calls then run through the real loop on the real app, so a test can check the scene, the undo labels, and every
  request body that went over the wire (including that no request contains the key).
- To script a conversation, give the mock one reply per request: text, tool calls, a stop reason. The next request
  carries the tool results, so you can assert on them before you answer.

To try the chat by hand with a real provider, use your own key in the app. It stays in your browser.

### Manual screenshots

`npm run docs:shots` runs `tests/docs/*.spec.ts` with `playwright.docs.config.ts`. These scripts perform the manual's
tutorials and reference views through the real UI (clicks, keys and drags) and write `docs/public/shots/<name>.png` at
1440 × 900 (the OpenSCAD editor shot uses a taller window). If a tutorial step stops working, the run fails, which
keeps the tutorials honest.

- The run starts its own dev server on port 5721 (`PW_PORT` changes it), without hot reload, so editing files during a
  run cannot reload the page in the middle of a sequence.
- The chat shots (`tests/docs/chat.spec.ts`) use a mocked Anthropic API (`tests/docs/mock-anthropic.ts`) with fixed
  replies, so they come out the same every time and need no key.
- Regenerate the shots when a change alters what the UI looks like, and look at the result before you commit.

## The manual

The manual is a [VitePress](https://vitepress.dev/) site in `docs/`, published at
`https://feiteira.github.io/3dica/manual/`.

- Configuration and the sidebar: `docs/.vitepress/config.mts`. A new page must be added to the sidebar there.
- Run `npm run docs:dev` while you write.
- **Dead links fail the build.** Link to existing pages (`[Code API](/reference/code-api)`) or to full `https://`
  URLs. Images live in `docs/public/` and are linked from the root: `![](/shots/overview.png)`.
- VitePress pages are Vue templates. Keep double curly braces and anything that looks like an HTML tag inside inline
  code or code blocks, or Vue will try to interpret it.
- `docs/design/` (the historical spec) is excluded from the site.
- Describe what the code does, not what was planned: check behavior in the source or in the app before you document
  it.

## Building the site

```sh
npm run build:site
```

This builds the app into `dist/` (Vite, with `base: './'`, so it works from any sub-path) and then the manual into
`dist/manual/`. Serve `dist/` with any static server to check the result. The app's **Manual** link points to
`./manual/` in a build, and to the published manual on the dev server.

## How the site is deployed

Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` | every push and pull request | `npm ci`, type-check, unit tests, `npx playwright install --with-deps chromium`, e2e tests, `npm run build:site`. The Playwright report is uploaded when something fails. |
| `pages.yml` | every push to `main`, or by hand | `npm ci`, `npm run build:site`, then uploads `dist/` and deploys it to GitHub Pages |

So merging to `main` publishes the app at `https://feiteira.github.io/3dica/` and the manual at
`https://feiteira.github.io/3dica/manual/` a few minutes later. In a fork, enable it under *Settings → Pages → Build
and deployment → Source: GitHub Actions*.

## Coding conventions

- **TypeScript, strict.** `tsconfig.json` turns on `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`. Use `import type` for types. No `enum`s, `namespace`s or constructor
  parameter properties: use string-literal unions and plain fields.
- **`src/core/` stays pure.** No DOM, no three.js, no Worker, so it runs in Node and in the worker. Logic that could
  live there should, with unit tests.
- **Project edits go through `src/app/commands.ts`.** Each user action is one `store.update(label, recipe)`, so one
  action is one undo step with a readable label. The mutations themselves live in `src/core/ops.ts` and throw `OpError`
  with a message meant for the user. Panels never call the store directly.
- **The layers talk through `src/app/context.ts`.** If a panel needs something new from the view or the evaluator, add
  it to the interface there.
- **No UI framework.** Panels are plain TypeScript (`mount(el, ctx)`), built with the `h()` helper from `src/ui/dom.ts`.
  They re-render from the controller's `render` event and patch the DOM rather than rebuilding it, so a focused input
  keeps its focus.
- **No `window.alert`, `confirm` or `prompt`.** Use `ctx.toast`, `ctx.confirm` and `ctx.problems`, which are accessible
  `<dialog>` and live-region based.
- **Every interactive control gets a `data-testid`.** The e2e tests and the screenshot scripts rely on them.
- **Messages are for people.** Errors say what happened and what to do, in plain words, as in
  `Can't delete 'Bolt': used by code in 'Bolt sizes'`.
- **Keep the `§` references meaningful.** When a comment points at a spec section, that section should describe the
  code. If you change behavior the spec describes, update the comment, and add the difference to "Known deviations" at
  the top of `docs/design/spec-v0.1.md` if it is lasting.
- **Pinned dependencies** with exact versions, and no new dependency without a reason.
- **OpenSCAD support is a clean-room implementation.** OpenSCAD is GPL and its MCAD library LGPL, while 3Dica is MIT.
  Don't copy or translate OpenSCAD's C++ source or its bundled `.scad` files into this repository. Work from the
  OpenSCAD User Manual and compare with the binary (`openscad -o out.echo`, `-o out.stl`, `-D name=value`) on snippets
  you write yourself; recording the binary's output as expected values in a test is fine. See
  [OpenSCAD objects](/dev/architecture#openscad-objects) in the architecture notes.
- **Formatting:** match the code around you. `.editorconfig` sets UTF-8, LF and 2-space indentation.
- **Document user-visible changes** in the manual and in `CHANGELOG.md` under *Unreleased*.

## Pull requests

Keep each pull request focused on one change, and say what changed and why. Before you open it:

- [ ] `npm run typecheck`, `npm test` and `npm run test:e2e` pass
- [ ] `npm run build:site` passes (the app builds and the manual has no dead links)
- [ ] New logic in `core/` or the engine has unit tests, and user-visible fixes have an e2e scenario
- [ ] The manual and `CHANGELOG.md` are updated for user-visible changes
- [ ] No new dependency, or an exact version and a reason in the description

## Reporting bugs and security issues

Open an [issue](https://github.com/feiteira/3dica/issues) with the steps to reproduce, what you expected and what
happened, and your browser and OS. A small `.3dica.json` that shows the problem helps a lot.

Report security problems privately as described in
[SECURITY.md](https://github.com/feiteira/3dica/blob/main/SECURITY.md), not in a public issue.
