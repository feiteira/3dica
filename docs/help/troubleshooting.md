# Troubleshooting

Find the symptom, check the causes in order, apply the fix. Most problems show a message somewhere: in the status line
under the code editor, in a dot's tooltip in the Scene tree or Library, in a toast at the bottom right, or in the
status bar at the bottom of the window.

![The status bar: the evaluator's state on the left, mesh and triangle counts on the right](/shots/status-bar.png)

## Nothing renders

The 3D view is empty, or an object you expect is missing.

| Check | Cause | Fix |
|---|---|---|
| The status bar says **Paused — code not run** and the toolbar shows **Run code** | You opened a file with **Open without running**, or 3Dica paused the code after a crash | Read the code, then click **Run code** or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>. See [Files, autosave and STL](/reference/files). |
| The status bar says **Evaluating** or **Starting evaluator…** | Results are still on the way | Wait. The selected object is evaluated first. |
| The object's row is dimmed | It, or a group it is in, is hidden | Click the eye icon, press <kbd>H</kbd> on it, or <kbd>Alt</kbd>+<kbd>H</kbd> to unhide everything. |
| The row has a red dot | Its code fails, and it never evaluated successfully | See [Red status dots](#red-status-dots). |
| The status line says `⚠ Returned nothing` | The code returns nothing, often a missing `return` | Return the geometry. See [Code API](/reference/code-api). |
| The view shows a banner *Isolated: …* | You are in isolate mode, which shows one definition alone | Press <kbd>I</kbd> or <kbd>Esc</kbd>. |
| The object is in the tree but not on screen | The camera looks elsewhere, or the object is tiny or far away | Press <kbd>F</kbd> to frame the selection, <kbd>Home</kbd> to frame everything. |
| Everything except the selection, or except the group you entered, is faint | Ghost is on: it fades everything outside the selection or the entered group | Press <kbd>G</kbd> to toggle Ghost, or <kbd>Esc</kbd> to deselect or leave the group. |
| The cutter of a subtract (or another part of a boolean) is not drawn | Only the boolean's result is drawn. Its parts appear, translucent, while the boolean or something inside it is selected | Select the union, subtract or intersect group. |
| A toast said the scene is *nested deeper than 32 levels* or *has more than 5,000 occurrences* | The tree expansion has limits, and the rest is not shown | Reduce the nesting or the number of copies, or build big arrays in code with `part()`. |
| The page has no toolbar or panels at all | 3Dica could not start, usually because WebGL is not available | See [WebGL not available](#webgl-not-available). |

## Red status dots

A red dot on a row in the Scene tree or the Library means that object failed. Hover the dot to read the message
(*Error: …*). On a group, the dot is red when something inside the group failed, and the tooltip says *Something
inside has an error*: expand the group to find it.

Select the object to see the details. The status line under the editor reads `✕ <message> (line <line>:<column>)` and
the code editor marks the line. In the 3D view, the last good mesh stays, tinted red, until the code works again.

![A runtime error in the Bolt: gutter marker and status line](/shots/code-error.png)

The status bar counts the failures, as in **2 errors**. A failed result is not retried by itself. It runs again when
you change its code or parameters, or when you press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.

The most common messages:

| Message | Cause | Fix |
|---|---|---|
| `ReferenceError: cubiod is not defined` | A typo in a name, or a name that is not in scope | Check the spelling. Things outside the flattened JSCAD names are under `jscad`, as in `jscad.geometries.path2`. |
| `Identifier 'center' has already been declared — "center" is a built-in name here …` | You declared a variable with the name of a JSCAD function, or `params`, `part`, `jscad`, `Math` | Rename your variable (`mid`, `pos`…). |
| `TypeError: Cannot assign to read only property 'width' …` or `Cannot add property …, object is not extensible` | `params` is frozen | Copy the value into a variable: `let w = params.width`. |
| `TypeError: Cannot read properties of null (reading 'edges')`, or other errors deep inside JSCAD | Often a `NaN` or `undefined` value reached JSCAD, for example after you renamed a parameter in the table but not in the code | Check every `params.…` name against the parameter table. Log values with `console.log()` (they print to the browser's developer console). |
| `Result has invalid vertex positions (NaN or Infinity)` | A coordinate is `NaN`: an undefined parameter, a division by zero | Same as above. |
| `Returned 2D geometry — extrude it first (e.g. extrudeLinear)` | The code returns a `circle()`, `rectangle()` or other 2D shape | Wrap it in `extrudeLinear({ height: 5 }, shape)` or `extrudeRotate`. |
| `Return a 3D geometry or an array of them; got number` | The code returns something that is not geometry | Return the shape, not a measurement or a Promise. |
| `Unexpected token …`, `Unexpected end of input` | A syntax error | The editor marks the first spot it cannot parse. Look for a missing bracket or comma just before it. |
| `depends on "Bolt" (failed)` | A definition used through `part()` failed | Fix the inner definition. Its own error is on its row. |

The [Code API](/reference/code-api) page lists every message the engine produces.

## "Unknown part" and "not a dependency"

`Unknown part "Nut" — no definition with that name`

Code calls `part('Nut')` and no definition is called exactly that.

- Names are **case-sensitive** and must match the Library exactly: `part('bolt')` does not find **Bolt**.
- Look for a typo, or code pasted from another project whose definitions have other names. (Renaming a definition in
  3Dica rewrites the `part()` calls for you, so a rename alone does not cause this.)
- Fix the string, or create the missing definition.

`part("Bolt"): not a dependency of "Rack" — call part with a string literal, e.g. part('Bolt')`

3Dica finds dependencies by reading the code before it runs, so the name has to be written literally:
`part('Bolt')` or `part("Bolt")`. A variable (`part(name)`), a template literal (`` part(`Bolt`) ``), a computed
string or a space before the parenthesis (`part ('Bolt')`) cannot be seen. Write the literal call. To choose a part at
run time, write each candidate literally and choose between the calls.

## Cycle errors

`Cycle: Bracket → Bracket row → Bracket`

Definitions use each other in a loop through `part()` calls, so none of them can be built. 3Dica shows the error on
every member and runs none of them. Remove the `part()` call that closes the loop. The line of each offending call is
marked in the editor.

`Cycle: nesting deeper than 64 levels (…)`

The chain of `part()` calls and groups is more than 64 levels deep. That almost always means an indirect loop; flatten
the structure if it really is that deep.

The Scene tree refuses moves and drops that would put a group inside itself, with a message such as
`Can't put 'Fixture' inside itself` or `Can't move 'Fixture' inside itself`. Put the object somewhere else.

## Timeouts and long evaluations

`Timed out after 20 s (infinite loop or very slow boolean?)`

An evaluation took longer than 20 seconds, so 3Dica stopped it and restarted the evaluator. The mesh you had before
stays on screen.

- **A loop that never ends.** Check the loop conditions (`i < count`, not `i > count`). As soon as you type, the
  running evaluation is no longer wanted and is stopped within about a second, so you can fix the code right away.
- **A slow boolean.** See [Slow booleans](#slow-booleans) below.
- **Legitimately heavy work.** Add `?evalTimeout=60000` to the address (in milliseconds) to allow 60 s.

While something runs for more than a second, the status bar names it and counts the time, as in
**Evaluating 1 · Plate 12.3 s**.

## "Too much geometry"

`Too much geometry: sphere with segments 5,000 makes about 12,500,000 polygons (the limit is 2,000,000 triangles) — lower the segments`

One call would build more than 2,000,000 polygons. 3Dica refuses it before it allocates anything. Lower the
parameter the message names (`segments`, `twistSteps`, `frequency`…).

`Too much geometry: this code made more than 2,000,000 polygons (a loop that never ends?) — stopped before the page runs out of memory`

The code as a whole has built more than 2,000,000 polygons. That is usually a loop that runs far more often than
intended, or many detailed primitives. Lower the count or the detail.

`Too many triangles: … (the limit is 2,000,000) — lower the segments`

The finished result is too big to draw. Lower the detail, or split the object.

These limits exist because a worker that runs out of memory takes the whole tab down. See the
[limits table](/reference/code-api#limits).

## Slow booleans

JSCAD's booleans (`union`, `subtract`, `intersect`, and also `hull` and `minkowski`) are much slower than building
primitives, and their cost grows quickly with the number of polygons. Signs: the status line shows hundreds or
thousands of milliseconds, and the view shows the previous, semi-transparent mesh for a while after each change.

- Lower `segments` on the operands. 32 is plenty for most parts; 64 is smooth.
- Return an array instead of a `union` when the pieces only need to touch or overlap.
- Subtract many holes in one call (`subtract(base, holes)`) and keep the holes simple.
- Move the expensive piece into its own definition and use it with `part()` or in a group. Each piece is then cached on
  its own, so editing one does not recompute the others.
- Hide what you are not working on. Hidden objects are not evaluated.

## Evaluator crashed or stopped

`The evaluator crashed (…)`

The worker that runs the code failed, most often because it ran out of memory. 3Dica restarts it, and the object that
was running is marked failed. Lower the detail of that object.

`Evaluator keeps crashing — reload the page`

Three crashes within 10 seconds. 3Dica stops evaluating so the tab stays usable. Fix or hide the object that crashes,
then reload the page.

`Evaluator failed to start — reload the page`

The worker never started, even after three retries. Reload. If it persists, check the developer console for errors.
3Dica is developed and tested with Chromium, so try a Chromium-based desktop browser such as Chrome or Edge.

**The project came back paused after the tab died.** If the whole tab crashed while evaluating, 3Dica restores the
project with its code paused and names the object: *3Dica stopped while evaluating 'Plate' last time (out of memory?).
Its code is paused — fix it, then click Run code.* Select that object, lower its detail or fix its loop, then click
**Run code**.

## Autosave unavailable

The toast **Autosave unavailable** means the browser refused to store the project.

- Site data or cookies are blocked for the 3Dica address, or you are in a private window that blocks storage.
- Storage is full. 3Dica already dropped its backups to make room, and the project still does not fit.

3Dica keeps working, but nothing is saved automatically. Save with <kbd>Ctrl</kbd>+<kbd>S</kbd>, allow site data for
the address, or free up storage. See [Autosave](/reference/files#autosave).

## Two tabs

*3Dica is also open in another tab. Both tabs autosave to the same slot and the last one to save wins — close one of
them, or Save to keep a copy.*

Every tab of the same address writes the same autosave slot, so two tabs overwrite each other's work. Close one of
them. If both hold something you want, save one to a file first (<kbd>Ctrl</kbd>+<kbd>S</kbd>).

## STL export problems

| Message | Cause | Fix |
|---|---|---|
| *Nothing to export* | The selection is hidden, or the scene has nothing visible | Select a visible object, or deselect (<kbd>Esc</kbd>) to export the whole scene. |
| *Skipped because of errors: Bolt* | Objects whose evaluation failed are left out of the file rather than run again | Fix those objects (red dots), then export again. |
| *Nothing to export ('Bolt' has errors)* | Everything you asked for failed | Same. |
| *Code is not running — click Run code first* | The project is paused | Click **Run code**. |
| *STL export timed out after 60 s* | The export took too long | Lower the detail, or export parts one at a time by selecting them. |

If the STL looks wrong in your slicer: overlapping solids are written as they are, not merged, and the file has no
colors. Coordinates are millimetres with Z up.

## WebGL not available

3Dica draws with WebGL. When the browser cannot create a WebGL context, 3Dica cannot start: the window shows the dark
layout without a toolbar or panels, and the developer console shows `THREE.WebGLRenderer: Error creating WebGL
context.`

- Turn on hardware acceleration in the browser settings (in Chrome: *Settings → System → Use graphics acceleration
  when available*) and restart the browser.
- Update the graphics driver.
- Remote desktops, some virtual machines and locked-down company browsers disable WebGL. Try on a local desktop.
- Check [get.webgl.org](https://get.webgl.org/) to see whether WebGL works at all.

## Keyboard and undo

- **Shortcuts do nothing.** The keyboard focus is in a text field or the code editor, where keys type text. Press
  <kbd>Esc</kbd> to leave the field. Shortcuts are also off while a dialog is open.
- **<kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes text instead of the last change.** In the code editor, <kbd>Ctrl</kbd>+<kbd>Z</kbd>
  is the editor's own undo. Press <kbd>Esc</kbd> first to undo project changes. In inspector fields, press
  <kbd>Enter</kbd> to commit: that also returns the keyboard to the app.
- **Undo history is gone.** It is not saved: a reload, New, Sample or Open starts a new history.

## Other surprises

- **A change shows up on several objects.** They are linked copies of one definition: the purple tint and the `◆N`
  badge show which. Select the copy and **Make unique** (<kbd>U</kbd>) before editing it on its own.
- **A rotation in code is far too big.** JSCAD's `rotate` functions take radians. Use `degToRad(30)`.
- **A shape sits half below the grid.** JSCAD centers most primitives on the origin. The templates pass
  `center: [0, 0, height / 2]` so the shape sits on the XY plane.
- **The layout is cramped or cut off.** 3Dica is built for desktop browsers, at least 1,100 pixels wide.
- **A file does not open.** The dialog lists every problem found, and your current project is untouched. See
  [the file format](/reference/files#the-3dica-json-format) for what a valid file contains.

Still stuck? Search or open an issue at [github.com/feiteira/3dica/issues](https://github.com/feiteira/3dica/issues),
with the steps to reproduce and, if you can, a small `.3dica.json` that shows the problem.
