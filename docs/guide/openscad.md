# OpenSCAD objects

An **OpenSCAD object** is a code object whose code is OpenSCAD instead of JavaScript. 3Dica has its own OpenSCAD
interpreter: it runs the code in the browser, following OpenSCAD 2021.01, and builds the shapes on the same geometry
engine as every other object. You don't need OpenSCAD installed, and nothing is converted. The code stays OpenSCAD:
you can edit it, export it again and open it in OpenSCAD.

In the tree, an OpenSCAD object is an ordinary definition. You can place linked copies, override its parameters per
copy, use it in Union, Subtract and Intersect groups, hide it, isolate it and export it to STL, as with any other
object.

![An imported bracket.scad, selected in the sample project: the OpenSCAD badge in the Inspector, its parameters, the code and the Output panel](/shots/openscad-import.png)

## Add one

| How | What you get |
|---|---|
| **Import** in the toolbar | One object per `.scad` file you choose. You can choose several files at once. |
| Drop `.scad` files on the window | The same as **Import**. |
| **OpenSCAD** in the toolbar | A new object named `Object`: a cube with a `size` parameter and a comment header. |
| The [AI chat](/guide/ai-chat) or an [MCP assistant](/guide/mcp) | `create_object` with `language: "openscad"`. |

New objects go into the **current group** (the group you are inside, or the top level), like the other toolbar
buttons. Import **adds** to the open project. To open a `.3dica.json` project file, use **Open**.

### What Import does

1. **Each file becomes one object**, named after the file: `bracket.scad` becomes `bracket`. If the name is taken, it
   gets a number (`bracket 2`). Quotes, backticks and backslashes are dropped from the name.
2. **Files that another chosen file uses or includes are attached to it** instead of becoming objects. 3Dica matches
   them by file name: `use <lib/holes.scad>` takes a chosen file named `holes.scad`, from whatever folder you picked it
   in. It is stored as `lib/holes.scad`, the path the `use` names. Files used through other files are followed too,
   stored next to the file that names them (a library that names its own folder, like `MCAD/shapes.scad` including
   `<MCAD/units.scad>`, gets `MCAD/units.scad`).
3. **Missing files are reported.** If a `use <…>` or `include <…>` names a file you did not choose, a toast says so,
   for example `'lid' needs 'lib/sizes.scad' — attach it in the Inspector`. The object then fails with OpenSCAD's
   message (`Can't open include file 'lib/sizes.scad'`) until you [attach the file](#attached-files).
4. **The objects are placed** 5 mm to the right of what is already in the group. When several files become objects,
   they are moved side by side, 5 mm apart, once they have been evaluated.
5. **The last new object is selected** and the view frames it.

The whole import is **one undo step**: `Import bracket.scad`, or `Import 3 files` when several objects are made.

Files that don't end in `.scad` are skipped with a toast (`Only .scad files can be imported — skipped 'part.stl'`),
and so are files larger than 2 MB. When you drop several files on the window and one of them is a `.scad` file, they
are all handed to Import. Otherwise the first file is opened as a project.

::: tip No "Run it?" prompt
Import does not ask before running the code. OpenSCAD code is read by 3Dica's interpreter and never runs as
JavaScript, so it can only make shapes. Opening a project file still asks, because a project can contain JavaScript
objects. See [the Run it? prompt](/reference/files#the-run-it-prompt-and-paused-mode).
:::

## Edit the code

Select the object, and its code opens in the editor under the Inspector. The header says **OpenSCAD** and the
definition's name, and the Inspector shows an **OpenSCAD** badge next to the kind. Editing works as for any code
object: your edit is applied 0.4 s after you stop typing, and <kbd>Ctrl</kbd>+<kbd>Enter</kbd> applies it at once.

![The bracket's definition: the parameter table read from its Customizer comments, the OpenSCAD code with syntax highlighting, the status line and the Output panel with the echo line](/shots/openscad-editor.png)

- **Highlighting** knows OpenSCAD's keywords, built-in modules and functions, `$` variables, strings, numbers,
  comments and `use` / `include` paths.
- **Completion** (as you type, or <kbd>Ctrl</kbd>+<kbd>Space</kbd>) offers the built-in modules and functions with
  their arguments, the keywords, the special variables, and the modules, functions and top-level variables of the
  object's own code.
- <kbd>Ctrl</kbd>+<kbd>/</kbd> comments a line out with `//`.
- **Errors** are marked in the gutter at their line, and the status line shows the message with the line and column:
  `✕ Parser error: syntax error, expected ')', found ';' (line 3:7)`. An error inside an attached file starts with the
  file and its line (`lib/gear.scad:12: …`), and the gutter marks the line of your code that called into the file
  (`gear(3);`), or the `use` or `include` line when the file failed while it was being read.
- The **status line** shows the time and the triangle count, and a warning when there is one. With several warnings
  it says `⚠ 3 warnings — see Output`.

### The Output panel

Under the status line, an OpenSCAD object has an **Output** panel, like OpenSCAD's console. It lists, in order:

| Line | Comes from |
|---|---|
| `ECHO: "Hole spacing: 20 mm"` | `echo()` |
| `WARNING: Ignoring unknown variable 'w'` | A warning from the interpreter or the geometry, with OpenSCAD's wording |
| `ERROR: Assertion 'false' failed: "no teeth"` | The error that stopped the object |
| `TRACE: called by gear() at line 2` | The module and function calls that led to the error |

A `line 20` link at the end of a line puts the cursor on that line of the code. A line from an attached file shows
`lib/holes.scad:4` instead. The panel shows the output of the result on screen: for a selected copy with overrides,
the run with those values. It keeps the first 1,000 lines of a run, and the last line then counts the rest:
`… 49,001 more lines not shown (the limit is 1,000)`. When there is nothing to show, it says
`No output. echo() lines and warnings show here.`

`echo()` lines, warnings and the error also reach the AI chat and MCP assistants, as `output` in their tool results.

## Parameters

The code is the only place where an OpenSCAD object's parameters are defined, as in OpenSCAD's Customizer. 3Dica reads
the top-level assignments of the code and turns each one that holds a plain value into a parameter. Customizer
comments give them ranges, steps and drop-down lists.

```c
/* [Size] */
// Length of the base in mm
length = 60;     // [30:5:150]
wall = 3;        // .5
/* [Holes] */
holes = 3;       // [2, 3, 4, 5]
screw = 4;       // [3:M3, 4:M4, 5:M5]
countersink = true;
spacing = (length - 20) / (holes - 1);
```

### How the Customizer maps to 3Dica

| In the code | Parameter in 3Dica |
|---|---|
| `width = 40;` | A number, default 40 |
| `width = 40; // [10:100]` | A number from 10 to 100: a slider |
| `width = 40; // [100]` | A number from 0 to 100 |
| `width = 40; // [10:5:100]` | A number from 10 to 100 in steps of 5 |
| `wall = 2; // .5` | A number with step 0.5 |
| `holes = 2; // [0, 1, 2, 3]` | A choice with the options `0`, `1`, `2`, `3`, default `2` |
| `screw = 4; // [3:M3, 4:M4, 5:M5]` | A choice with the options `M3`, `M4`, `M5`, default `M4`. The code still gets the number. |
| `style = "flat"; // [flat, round]` | A choice with the options `flat` and `round` |
| `center = true;` | A boolean: a checkbox |
| `// Wall thickness` on the line just above | The description, shown under the row and in its tooltip |
| `/* [Holes] */` | A heading (a Customizer tab) above the parameters that follow |
| `/* [Hidden] */` | The assignments that follow are not parameters |
| `name = "bracket";` | Not a parameter: a string needs a list of options |
| `size = [10, 20];` | Not a parameter: a vector |
| `spacing = length / 4;` | Not a parameter: an expression |
| `$fn = 32;` | A number parameter named `$fn` |

The rules in detail:

- Only assignments at the top level of the object's own code count, and only those before the first `{` of the file,
  as in OpenSCAD. Assignments in attached files are never parameters.
- The value must be a literal: a number (a leading `-` is fine), `true`, `false`, or a string with a list of options.
- The widget comment is the first comment after the `;`, on the same line. The description is a `//` comment that
  starts at the beginning of the line just above.
- A drop-down item can be `value` or `value:label`. If the assigned value is not among the items, it is added as the
  first option. Two items with the same label are told apart by their value, as in `One (2)`.
- A name assigned twice is one parameter, defined by the last assignment, because that is the value OpenSCAD uses.
- Names that start with a digit (`2d`), which OpenSCAD allows, and names that are reserved words in JavaScript
  (`default`, `class`, `new` and the others listed in [Valid names](/reference/parameters#valid-names)) can't be 3Dica
  parameters, so they are skipped. The code still runs with its own value.
- Below the table, a line names the literals that OpenSCAD's Customizer would show but 3Dica can't make parameters:
  `Not parameters here: name (text without options), size (a vector) — edit them in the code.` Computed values and the
  Hidden tab are not listed: they are not parameters in OpenSCAD either.

### Overrides on a copy

Select a placed copy, and **Parameters** (*this instance*) shows a control for each parameter, with the Customizer
headings and the descriptions as tooltips. A change is an override for that copy, marked with ● and reset with ↺,
exactly as for a JavaScript object. See [Parameters](/reference/parameters).

3Dica runs the code with the override in place of the assigned value, like `openscad -D length=80`: everything the
code computes from `length` follows. For a choice, the code gets the item's value, not its label: picking `M5` above
runs the code with `screw = 5`. Where you type an override (a `part()` call, the AI chat, MCP), the item's value works
as well as the label: `screw = 5` and `screw = "M5"` are the same override.

### Changing a default

The **Parameter defaults** table of an OpenSCAD object (in the Definition section, open when you select the
definition in the Library) shows each parameter with its type, default, description and range, under its heading.
Its rows are read-only, except the default. A default you change there is **written into the code**: only the value
changes, the comments stay. The field shows the value exactly as the code writes it (`1.61803`, not rounded), and
pressing Enter without changing it leaves the code alone.

```c
length = 60; // [30:5:150]   →   length = 80; // [30:5:150]
```

It is one undo step, labelled `Change length`. To add, remove or rename a parameter, or change its range or options,
edit the code. The table says so in its note, and the AI chat and MCP tools refuse a `params` list for an OpenSCAD
object with the same hint.

## Attached files

`use <file>` and `include <file>` read the object's **attached files**. 3Dica can't read files from your disk, so
every library an object needs travels with it, inside the project. The Definition section lists them under
**Files**.

![The Files section of an object: lib/holes.scad is attached, lib/sizes.scad is missing, with an Attach… button](/shots/openscad-files.png)

| Row | Buttons |
|---|---|
| An attached file the code uses | Replace (↻), Download, Remove |
| An attached file the code doesn't use | The same, with `not used by the code` |
| A missing file (warning sign, `missing`) | **Attach…**: pick the file, and it is stored under the path the code expects |

- The list shows every file the code needs, in the order it names them, including the files that attached files use
  or include. Hover a name for its size and which file uses it.
- **Attach files…** picks one or more `.scad` files. A file whose name matches a missing `use` or `include` fills it,
  at the path that names. Any other file is stored under its own name.
- **Export .scad** downloads the object's own code as `<name>.scad`. Attached files are downloaded one by one with
  their Download button.
- Attach, replace and remove are undo steps: `Attach holes.scad`, `Attach 2 files`, `Remove holes.scad`.
- The files are saved in the project file and the autosave, under the object's `files` (see
  [the file format](/reference/files#definitions)).

**How a name is found.** For `use <lib/holes.scad>` written in file `F`, 3Dica looks for an attached file at
`lib/holes.scad` next to `F` first, then at `lib/holes.scad` from the top of the attached files (OpenSCAD's library
folder). If neither exists and exactly one attached file is called `holes.scad`, that one is used. Paths are always
relative, and a `..` can't climb above the top.

**Libraries.** To use MCAD or another library, attach the files you use, in the folders the code names: for
`use <MCAD/involute_gears.scad>`, attach `involute_gears.scad` (it is stored as `MCAD/involute_gears.scad`) and any
file it uses in turn. The files list shows what is still missing. The easiest way is to choose them all at once in
Import.

**Limits.** A file can have at most 2 MB, an object at most 200 attached files and 16 MB in all. The browser's
storage for the autosave holds about 5 MB in Chromium, so an object with large libraries can make the project too
big to autosave. You then see *Autosave unavailable* once: **Save** still works.

## part() both ways

An OpenSCAD object and the rest of the project can use each other's geometry.

**From OpenSCAD code**, `part()` is a built-in module that places another 3Dica definition, in its own coordinates:

```c
// three bolts of increasing length, from the sample's Bolt definition
for (i = [0 : 2])
  translate([i * 15, 0, 0]) part("Bolt", length = 10 + i * 5);
```

- The first argument is the definition's name, as a string literal in double quotes. 3Dica reads the code before it
  runs to find the names it uses, as it does for JavaScript, so `n = "Bolt"; part(n);` fails with
  `part("Bolt"): not a dependency of "Rack" — write the name as a string literal, e.g. part("Bolt"), and check that an
  object with that name exists`.
- The other arguments are parameter overrides, by name. Each value must be a number, `true` / `false` or a string.
  For a choice parameter, give the option text as the Inspector shows it (`screw = "M5"`) or, when the definition is
  an OpenSCAD object, the drop-down item's value as its code writes it: `holes = 4` for `holes = 2; // [2, 3, 4, 5]`,
  `screw = 5` for `screw = 4; // [3:M3, 4:M4, 5:M5]`.
- Transforms, `color()` and booleans around `part()` work as on any shape.
- If the code (or an attached file it uses or includes) defines its own `module part`, that module is used instead
  and the call is not a 3Dica reference.

**From JavaScript code**, `part('bracket', { length: 80, screw: 'M5' })` returns an OpenSCAD object's geometry as an
array, like any other definition's. See [part()](/reference/code-api#part).

Either way, the rest of 3Dica knows about the reference: renaming the definition rewrites the `part("Old"` calls (in
OpenSCAD code and its attached files too), deleting it is refused while code uses it, **Purge** keeps it, and a loop
of `part()` calls is reported as a cycle. The errors are the same as for JavaScript code, for example
`Unknown part "Nut" — no definition with that name` or `part("Bolt"): unknown parameter "size" — "Bolt" has
parameters length`.

## 2D results

3Dica shows 3D solids. What OpenSCAD code leaves at the top level decides what you see:

| Top level | Result |
|---|---|
| 3D shapes only | Shown as they are. |
| 2D shapes only | A 1 mm thick plate, from z = −0.5 to 0.5, like OpenSCAD's preview (F5). The warning says `2D result shown 1 mm thick, like OpenSCAD's preview — use linear_extrude() for a solid`. |
| 2D and 3D shapes | The 3D shapes, with the warnings `Mixing 2D and 3D objects is not supported` and `Ignoring 2D child object for 3D operation`. |
| Nothing | No geometry, with the warning `No top-level geometry`. |

The plate is real geometry: it is what `part()`, booleans and STL export get. To print a 2D shape, extrude it with
`linear_extrude()`. 2D work inside the code (`offset()`, `projection()`, 2D booleans, `hull()` of 2D shapes) works as
in OpenSCAD.

## What differs from OpenSCAD

3Dica's interpreter was checked against OpenSCAD 2021.01 with OpenSCAD's own example files, the MCAD library and a
few hundred small test files. Apart from the differences below, the echo output is the same, line for line, and the
volumes agree to within 0.01 %. These are the differences you can run into, and why.

| Topic | In 3Dica | Why |
|---|---|---|
| `import()`, `surface()`, `dxf_dim()`, `dxf_cross()`, `linear_extrude(file = …)` | An error: `import() is not supported in 3Dica: …` | 3Dica only makes shapes from code. It can't read meshes, height maps or drawings. |
| `rotate_extrude(180)` with a positional argument | A warning and no shape: in 2021.01 that argument is a DXF file name | Use `rotate_extrude(angle = 180)`. |
| `text()` | Approximate: a built-in single-stroke font, sized, spaced and kerned like OpenSCAD's default font (Liberation Sans), with a warning | 3Dica has no font files. The letters have the right size and place, but different shapes, so the volume differs by a few per cent. `font` is ignored: bold, italic and other fonts look the same. |
| Libraries | Only attached files: there is no library folder, and MCAD is not built in | The browser can't read your disk. Attach the files. |
| A missing `use <…>` or `include <…>` file | An error that names the file | OpenSCAD only warns and goes on without it, which is easy to miss. |
| 2D next to 3D at the top level | The 3D shapes are kept, the 2D ones dropped with a warning | 3Dica shows solids. OpenSCAD 2021.01 keeps whichever kind comes first. |
| `#` modifier | Drawn normally, not highlighted | Select the object to highlight it. |
| `%` modifier | Left out, as in OpenSCAD's render (F6) | 3Dica has no transparent background objects. |
| `!` and `*` | As in OpenSCAD: show only this, or leave it out | |
| `$preview` | Always `true` | 3Dica has one mode. Code that checks `$preview` behaves as in OpenSCAD's preview (F5), but the result is a full solid, as after F6. |
| `$t` | Always 0 | There is no animation. |
| `$vpr`, `$vpt`, `$vpd`, `$vpf` | Fixed at OpenSCAD's defaults: `[55, 0, 25]`, `[0, 0, 0]`, 140, 22.5 | The code runs once per change, not per camera move. |
| Colours | `color()` works, but transparency (alpha) is ignored in the view, and an instance colour wins over `color()` | 3Dica draws solids opaque. See [Colours](/concepts/model#colours). |
| `union()` of differently coloured children | One solid per colour, overlapping | So the colours stay visible, as in OpenSCAD's preview. `difference()` and `intersection()` keep the first child's colour. |
| `union()` of solids that meet only along an edge or at a corner | Separate solids, also in the STL | A checkerboard or a staircase of cubes. Kept apart, the later booleans on them stay exact. OpenSCAD makes one solid that is not a valid 2-manifold. |
| Top-level shapes | Separate pieces, also in the STL, where overlapping pieces are not merged | Wrap them in `union()` if your slicer needs one solid. OpenSCAD's export unions everything. |
| `rands()` without a seed | The same numbers on every run | A re-run must give the same shape: the seed comes from the code and the parameter values. With an integer seed you get OpenSCAD's own numbers. |
| Recursion | About 340–880 nested function calls and 200–430 nested module calls in Chrome, depending on what the body does (a module recursing through `translate()`, or a function building a list with `concat()`, gets the lower number), then `Recursion too deep calling function 'f' (812 nested calls, as deep as this page can go; OpenSCAD allows about 9,000) — if it ends, rewrite it with tail recursion or a list comprehension` | The browser's stack is smaller. OpenSCAD manages about 9,000 and 3,500. Tail recursion, as in `function f(n, acc = 0) = n == 0 ? acc : f(n - 1, acc + n);`, has no limit, also between two functions. |
| A polygon that crosses itself, extruded | Filled even-odd | OpenSCAD fails with a mesh that is not closed. |
| A `rotate_extrude()` profile across the Y axis | A warning and no shape | OpenSCAD prints an error, makes no shape and goes on. In 3Dica an error would stop the whole object. |
| Inside-out `polyhedron()` | Turned right side out, with a warning | OpenSCAD fixes it only when the polyhedron goes through a boolean; on its own it is exported inside out, with a negative volume. |
| Tiny differences in 2D | Vertices of 2D booleans, `offset()` and `projection()` can differ by up to 0.000015 mm | OpenSCAD snaps 2D work to a 1/65,536 mm grid. |
| Error positions | A missing `)`, `]`, `}`, `"` or `*/` at the end of the file points at where it was opened | OpenSCAD reports a line past the end. |

## Performance

Interpreting the code is fast: most models run in milliseconds. The time goes into geometry, mostly booleans.
OpenSCAD objects have their own boolean engine, and a model with real geometry usually builds faster in 3Dica than
OpenSCAD 2021.01 renders it with F6. OpenSCAD's preview (F5) is faster than both, because it only draws the shapes and
never computes the booleans. Some things stay slow:

- **Detail.** `$fn`, `$fa` and `$fs` work as in OpenSCAD. `$fn = 100` on every curve multiplies the work. Set a high
  `$fn` only where it shows, and use `$fa` and `$fs` (for example `$fa = 6; $fs = 0.5;`) for the rest.
- **`hull()` of many detailed shapes**, such as 100 smooth spheres, takes seconds.
- **`minkowski()` with non-convex shapes** is split into convex pieces first, and the work grows with the product of
  the pieces. More than 2,000 pairs is refused with `minkowski() is too heavy: …`.
- **Many top-level pieces.** A top-level `for` loop of thousands of objects makes thousands of separate meshes. Put a
  `union()` around it if you don't need them separate.
- **Split big models.** Each 3Dica object is cached on its own. If one part of a model is slow, move it into its own
  OpenSCAD object and bring it in with `part()`: then editing the rest does not rebuild it.
- **Linked copies cost nothing extra.** Ten copies of one definition with the same parameters are one evaluation.

The geometry limits are the same as for JavaScript objects (2,000,000 polygons per evaluation, 2,000,000 triangles per
result, 20 s per evaluation), plus limits for runaway OpenSCAD code. See [OpenSCAD support](/reference/openscad#limits)
for the list and their messages.

## A worked example

An angle bracket with a row of countersunk screw holes, in two files: the bracket and a small library.

::: code-group

```c [bracket.scad]
// An angle bracket with a row of screw holes
use <lib/holes.scad>

/* [Size] */
// Length of the base in mm
length = 60; // [30:5:150]
// Width and height in mm
width = 20; // [10:40]
// Wall thickness
wall = 3; // [2:0.5:6]

/* [Holes] */
// Number of screw holes
holes = 3; // [2, 3, 4, 5]
// Screw size
screw = 4; // [3:M3, 4:M4, 5:M5]
countersink = true;

spacing = (length - width) / (holes - 1);
echo(str("Hole spacing: ", spacing, " mm"));

difference() {
  union() {
    cube([length, width, wall]);
    cube([wall, width, width]);
  }
  for (i = [0 : holes - 1])
    translate([width / 2 + i * spacing, width / 2, 0])
      screw_hole(screw, wall, countersink);
}
```

```c [lib/holes.scad]
// A through hole for a screw, with an optional countersink at the top
module screw_hole(d, depth, countersink = true) {
  translate([0, 0, -1]) cylinder(d = d + 0.4, h = depth + 2, $fn = 24);
  if (countersink)
    translate([0, 0, depth - d / 2]) cylinder(d1 = d, d2 = d * 2, h = d / 2 + 0.01, $fn = 24);
}
```

:::

1. Save the two files, `holes.scad` in a folder `lib` next to `bracket.scad`, so OpenSCAD finds it too.
2. Click **Import** and choose both files. You get one object, `bracket`, with `lib/holes.scad` attached. The undo
   history says `Import bracket.scad`.
3. It is selected. The Output panel shows `ECHO: "Hole spacing: 20 mm"`, and the Parameters show the Customizer
   tabs `Size` and `Holes`.
4. Under **Parameters**, set `holes` to 4 and `screw` to M5. This copy now has four holes for M5 screws, and the
   Output panel shows `ECHO: "Hole spacing: 13.3333 mm"`, the same as `openscad -D holes=4 -D screw=5` prints.
5. Press <kbd>Ctrl</kbd>+<kbd>D</kbd> for a linked copy. It keeps the overrides. Reset them with ↺ to get the
   three-hole bracket back on the copy only.
6. Click `bracket` in the Library and change the default of `length` to 80. The code now says `length = 80;`, and
   every copy that doesn't override `length` gets longer.
7. **Export .scad** in the Files section downloads `bracket.scad` with the new default. Open it in OpenSCAD next to the
   `lib` folder and it builds the same bracket.

The bracket is 60 × 20 × 20 mm and has the same volume in 3Dica and OpenSCAD (4,400.8 mm³). To use it in a
JavaScript object, write `part('bracket', { length: 100, holes: 5 })`.

## Next

- [OpenSCAD support](/reference/openscad): every built-in module, function and special variable, and the limits.
- [Coming from OpenSCAD](/guide/coming-from-openscad): how OpenSCAD maps to JavaScript objects, if you want to write
  some of your parts in JSCAD.
- [Troubleshooting › OpenSCAD objects](/help/troubleshooting#openscad-objects): the common error messages.
