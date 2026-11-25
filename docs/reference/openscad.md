# OpenSCAD support

This page lists what 3Dica's OpenSCAD interpreter supports, item by item, against OpenSCAD 2021.01, the version it
follows. [OpenSCAD objects](/guide/openscad) explains how to import and use them.

| Status | Meaning |
|---|---|
| **Supported** | Works as in OpenSCAD 2021.01: the same values, echo text, warnings and shapes. |
| **Approximate** | Works, with a difference the note describes. |
| **Not supported** | Stops the object with an error that says so, or does nothing, as the note says. |

Unknown modules, functions and variables behave as in OpenSCAD: a warning (`Ignoring unknown module 'foo'`) and the
call is skipped, or the value is `undef`.

## Language

| Feature | Status | Notes |
|---|---|---|
| Numbers, strings, booleans, `undef`, vectors, ranges `[a : b]` and `[a : step : b]` | Supported | Numbers print with 6 significant digits, as in OpenSCAD's console. A range with a fractional step has as many values as in OpenSCAD: `[0 : 0.1 : 0.3]` has 4, `[1 : 0.05 : 1.4]` has 8. |
| Operators `+ - * / % ^ ! && \|\| == != < <= > >=`, `?:`, indexing `v[i]`, `.x .y .z` | Supported | Vector and matrix arithmetic, and `undef` plus a warning for a type mismatch, as in OpenSCAD. |
| Variables and scopes | Supported | All assignments of a block run before its modules. A variable assigned twice takes the last value, at the place of the first. |
| `$` variables | Supported | Dynamically scoped: a `$fn` set on a call reaches everything inside it. |
| `module`, `function`, default arguments, named arguments | Supported | Default values are evaluated on each call, as in OpenSCAD. A named argument that is not a parameter warns (`variable size not specified as parameter`) and is still set inside the call, as in OpenSCAD 2021.01. |
| Function literals `function(x) x * 2` | Supported | |
| Recursion | Supported | Tail calls run as loops, with no depth limit. Other recursion stops at about 340–880 nested function calls or 200–430 nested module calls in Chrome, depending on the body (see [Limits](#limits)). |
| `if` / `else`, `for`, `let`, `each`, `intersection_for` | Supported | `for` over a range of 1,000,000 values or more is skipped with OpenSCAD's warning `Bad range parameter in for statement: too many elements (N)`. `intersection_for` intersects every statement of every round. |
| List comprehensions: `for`, `if`, `else`, `let`, `each`, C-style `for (i = 0; i < n; i = i + 1)` | Supported | The updates of a C-style `for` run in order, each seeing the ones before it. |
| `echo()` and `assert()`, as statements and in expressions | Supported | Output goes to the [Output panel](/guide/openscad#the-output-panel). A failed `assert` stops the object: `Assertion 'false' failed: "msg"`. |
| `children()`, `children(i)`, `children([i, j])`, `children([a : b])`, `$children` | Supported | |
| `include <file>` | Supported | Reads an [attached file](/guide/openscad#attached-files) and inserts it, as OpenSCAD does. A missing one is an error, `Can't open include file 'x.scad'`, where OpenSCAD only warns. A file that includes itself is not read again, with OpenSCAD's warning. |
| `use <file>` | Supported | Makes the modules and functions of an attached file available. A missing one is an error, `Can't open library 'x.scad'`, where OpenSCAD only warns. |
| Modifier `!` (show only this) | Supported | The first `!` in the code wins; a `!` inside it gets OpenSCAD's warning `More than one Root Modifier (!)`. |
| Modifier `*` (disable) | Supported | |
| Modifier `#` (highlight) | Approximate | Drawn like any other shape. Select the object to highlight it. |
| Modifier `%` (background) | Approximate | Left out of the result, as in OpenSCAD's render (F6). Its preview (F5) shows it transparent. |
| Comments, Unicode strings and escapes | Supported | A byte-order mark at the start is accepted (OpenSCAD refuses the file). A Windows line end counts as one line (OpenSCAD counts two, so its line numbers differ). |
| Customizer comments | Supported | Read as 3Dica parameters. See [the mapping](/guide/openscad#how-the-customizer-maps-to-3dica). |

## 3D shapes

| Module | Status | Notes |
|---|---|---|
| `cube(size, center)` | Supported | A number or `[x, y, z]`. |
| `sphere(r \| d)` | Supported | OpenSCAD's rings and vertex positions. |
| `cylinder(h, r \| d, r1 \| d1, r2 \| d2, center)` | Supported | Cones too. |
| `polyhedron(points, faces, convexity)` | Supported | Non-planar faces are split into triangles as OpenSCAD splits them. Faces with bad indices are dropped with OpenSCAD's warning. An inside-out polyhedron is turned right side out, with a warning. |
| `import()` | Not supported | Error: `import() is not supported in 3Dica: OpenSCAD objects cannot read STL, OFF, DXF or SVG files`. |
| `surface()` | Not supported | Error: `surface() is not supported in 3Dica: OpenSCAD objects cannot read height-map files`. |

## 2D shapes

| Module | Status | Notes |
|---|---|---|
| `square(size, center)` | Supported | |
| `circle(r \| d)` | Supported | |
| `polygon(points, paths, convexity)` | Supported | Filled even-odd, collinear points dropped, as OpenSCAD's 2D engine does. |
| `text(text, size, font, halign, valign, spacing, direction, language, script)` | Approximate | A built-in single-stroke font, fitted to the size, spacing and kerning of OpenSCAD's default font, Liberation Sans. The letter shapes differ, so the area differs by a few per cent. `font`, `language` and `script` are ignored: bold and italic look like the regular font. A warning says so once per object. |

A 2D result at the top level is shown 1 mm thick. See [2D results](/guide/openscad#2d-results).

## Transforms

| Module | Status | Notes |
|---|---|---|
| `translate(v)` | Supported | |
| `rotate(a)`, `rotate(a, v)` | Supported | Degrees, X then Y then Z, exact at multiples of 90°. |
| `scale(v)` | Supported | |
| `resize(newsize, auto)` | Supported | |
| `mirror(v)` | Supported | |
| `multmatrix(m)` | Supported | |
| `color(c, alpha)` | Approximate | Names (the CSS / SVG colour names, in any case), `"#rgb"`, `"#rgba"`, `"#rrggbb"`, `"#rrggbbaa"` and `[r, g, b, a]`. The view ignores alpha, and an instance colour set in 3Dica wins over `color()`. |
| `offset(r \| delta, chamfer)` | Supported | Round, mitred and chamfered corners as in OpenSCAD. Vertices can differ by up to 0.000015 mm, because OpenSCAD snaps 2D work to a grid. |
| `hull()` | Supported | 2D and 3D. |
| `minkowski()` | Supported | Exact for convex shapes. Non-convex shapes are split into convex pieces first; more than 2,000 pairs of pieces is refused with `minkowski() is too heavy: …`. |

## Booleans and extrusions

| Module | Status | Notes |
|---|---|---|
| `union()` | Supported | Children of different colours stay one solid per colour. Solids that meet only along an edge or at a corner (a checkerboard, stairs) stay separate solids, so later booleans on them stay exact; they export as separate pieces. |
| `difference()` | Supported | The result keeps the first child's colour. An empty first child (an empty module, `union() {}`, a result that came out empty) makes the whole result empty, as in OpenSCAD. |
| `intersection()` | Supported | As `difference()`. Any empty child makes the result empty. |
| `linear_extrude(height, center, twist, slices, scale, convexity)` | Supported | OpenSCAD's slice counts and vertex positions, also twisted and scaled. A number as the first argument is the height. `file =` is not supported. |
| `rotate_extrude(angle, convexity)` | Supported | A profile across the Y axis gives a warning and no shape, where OpenSCAD stops with an error. `rotate_extrude(180)` with the angle as a positional argument reads a DXF file in 2021.01: 3Dica warns and makes nothing. |
| `projection(cut)` | Supported | |
| `render(convexity)` | Supported | A plain group: every result is already a full solid. |
| `group()` | Supported | A plain group, as in OpenSCAD. |

## Built-in functions

| Function | Status | Notes |
|---|---|---|
| `abs`, `sign`, `floor`, `round`, `ceil`, `ln`, `log`, `pow`, `sqrt`, `exp`, `min`, `max` | Supported | |
| `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2` | Supported | Degrees, exact at the special angles (`sin(30)` is 0.5, `cos(90)` is 0). |
| `norm`, `cross`, `len`, `concat`, `lookup` | Supported | |
| `str`, `chr`, `ord`, `search` | Supported | |
| `rands(min, max, count, seed)` | Supported | With an integer seed, OpenSCAD's own numbers. Without a seed, the same numbers on every run of the same code and parameters (OpenSCAD gives new ones each time). |
| `is_undef`, `is_bool`, `is_num`, `is_string`, `is_list`, `is_function` | Supported | |
| `version()`, `version_num()` | Supported | `[2021, 1, 0]` and `20210100`. |
| `parent_module(n)`, `$parent_modules` | Supported | |
| `dxf_dim()`, `dxf_cross()` | Not supported | Error: they read DXF files. |

## Special variables

| Variable | Status | Value or notes |
|---|---|---|
| `$fn`, `$fa`, `$fs` | Supported | Defaults 0, 12 and 2. The number of fragments of a circle of radius r is `$fn` (at least 3) when `$fn > 0`, otherwise `ceil(max(min(360 / $fa, 2πr / $fs), 5))`, as in the OpenSCAD manual. `$fa` and `$fs` below 0.01 are clamped with OpenSCAD's warning. |
| `$children` | Supported | |
| `$parent_modules` | Supported | |
| `$preview` | Approximate | Always `true`. |
| `$t` | Approximate | Always 0: there is no animation. |
| `$vpr`, `$vpt`, `$vpd`, `$vpf` | Approximate | Fixed at `[55, 0, 25]`, `[0, 0, 0]`, 140 and 22.5, OpenSCAD's defaults. They don't follow the 3Dica camera. |
| `PI` | Supported | |

## Deprecated features

These still work in 2021.01, with a deprecation warning, and work the same way in 3Dica:

| Feature | Notes |
|---|---|
| `assign(a = 1) …` | `The assign() module will be removed in future releases. Use a regular assignment instead.` |
| `child(i)` | `child() will be removed in future releases. Use children() instead.` |

## 3Dica additions

| Module | Notes |
|---|---|
| `part("Name", param = value, …)` | Places another 3Dica definition, in its own coordinates. The name must be a string literal. Overrides are named, with a number, `true` / `false` or a string. A choice takes its option text or, for an OpenSCAD drop-down, the item's value: `holes = 3` for `// [0, 1, 2, 3]`, `size = 30` for `// [10:Small, 30:Large]`. If the code defines its own `module part`, that module is used instead. See [part() both ways](/guide/openscad#part-both-ways). |

## Limits

OpenSCAD code runs in the same evaluation worker as JavaScript code, with the same timeout and geometry limits (see
[Code API › Limits](/reference/code-api#limits)). These limits are added for OpenSCAD code. They stop a runaway model
before it fills the tab's memory, and are far above what real models need: OpenSCAD's own examples and MCAD stay well
under each.

| Limit | Value | Message |
|---|---|---|
| Nested calls | 5,000, or fewer when the browser's stack runs out first (about 340–880 functions or 200–430 modules in Chrome, depending on the body) | `Recursion too deep calling function 'f' (812 nested calls, as deep as this page can go; OpenSCAD allows about 9,000) — if it ends, rewrite it with tail recursion or a list comprehension` (for a module: `— if it ends, nest fewer levels (a for loop instead of recursion)`), with the calls in the Output panel |
| Steps | 10,000,000 function and module calls and loop rounds per run | `The code ran too long (more than 10,000,000 function calls and loop rounds) — a loop or recursion that never ends?` |
| One list | 1,000,000 elements | `List too long (more than 1,000,000 elements)` |
| One string | 1,000,000 characters | `String too long (more than 1,000,000 characters)` |
| All values together | 20,000,000 list elements and characters per run, each shape or transform counting as 16 | `The model creates too much data (…)`, or `Too much geometry: this code made N shapes and transforms — stopped before the page runs out of memory` |
| Code size | 2,000,000 words, numbers and symbols per file | `The code is too long (more than 2,000,000 words, numbers and symbols)` |
| Code with its includes | 2,000,000 statements once every `include <…>` is read in | `The code expands to too much: more than 2,000,000 statements after its include <…> files are read in (a file included again and again?)` |
| Include depth | 32 files, each including the next (a file that includes itself, directly or round a loop, is skipped with OpenSCAD's warning `Can't open include file 'a.scad'.`) | `include <f.scad> nests too deeply (more than 32 files, each including the next)` |
| One shape | 2,000,000 polygons | `Too much geometry: sphere() with $fn = 10000000 makes about … polygons (…) — lower $fn`, or `— raise $fa / $fs` |
| Polygons per evaluation | 2,000,000, shared with `part()` calls | `Too much geometry: this code made more than 2,000,000 polygons (a loop that never ends?) — stopped before the page runs out of memory` |
| `minkowski()` | 2,000 pairs of convex pieces | `minkowski() is too heavy: …` |
| Console | 10,000 lines kept per run, 1,000 shown per result; an echo line is cut at 100,000 characters | `… N more lines not shown (the limit is 1,000)`, counting every line left out |
| Values in messages | A value or expression quoted in a warning or error is cut at about 1,000 characters, any message at 10,000 | The text ends in ` …` or ` … (cut)` |
| Attached files | 2 MB per file, 200 files and 16 MB per object | Shown when you attach or import |
| Time | 20 s per evaluation | `Timed out after 20 s (infinite loop or very slow boolean?)` |
