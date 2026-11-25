# Code API

Every Code object in 3Dica is a short piece of JavaScript that builds a solid with
[JSCAD](https://github.com/jscad/OpenJSCAD.org) (`@jscad/modeling` 2.13). Cube, Sphere, Cylinder and Torus are Code
objects too. They are made from templates, so you can open their code and change it.

This page is the complete reference for that code: what it must return, which names it can use, how `part()` works,
what the error messages mean, and the limits that keep a runaway script from freezing the page.

![The code editor under the inspector, showing the Plate definition](/shots/code-editor.png)

## The contract

The code is the **body of a function**. 3Dica wraps it, runs it in a Web Worker and expects it to `return` the
geometry:

```js
const { width, depth, height } = params
return cuboid({ size: [width, depth, height], center: [0, 0, height / 2] })
```

| Rule | Details |
|---|---|
| Return a 3D geometry | A JSCAD `Geom3`, such as the result of `cuboid()`, `union()` or `extrudeLinear()`. |
| …or an array of them | Each item becomes its own mesh. Nested arrays are flattened, so `[[a], [b, [c]]]` is fine. |
| Returning nothing is allowed | `undefined`, `null` or `[]` gives an empty object and the warning **Returned nothing**. |
| Strict mode | The body runs with `"use strict"`. Assigning to an undeclared variable throws `ReferenceError: y is not defined`. |
| Synchronous | No `await`, no `import`, no `require`. The result must be ready when the function returns. |
| Units and axes | Millimetres, Z up. |
| Angles are radians | JSCAD's `rotate`, `rotateZ`, `twistAngle` and so on take **radians**. Use `degToRad(90)`. The inspector's Rotation fields are in degrees. |

The code runs again when its text changes (0.4 s after you stop typing), when the parameter values it receives change,
or when a definition it uses through `part()` changes. Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (or the **Run** button
above the editor) to commit and run it at once. Moving an object never runs its code: the transform is applied in the
3D view.

::: warning Rotations in code are in radians
`rotateZ(90, shape)` turns the shape by 90 *radians*. Write `rotateZ(degToRad(90), shape)` or
`rotateZ(Math.PI / 2, shape)`. This catches almost everyone who comes from OpenSCAD, where `rotate([0, 0, 90])` means
degrees.
:::

## Names in scope

| Name | What it is |
|---|---|
| `params` | The definition's parameter defaults, merged with this instance's overrides (or with the overrides passed to `part()`). It holds only the declared parameters, in table order. It is **frozen**: `params.width = 3` throws `TypeError: Cannot assign to read only property 'width' of object '#<Object>'`. See [Parameters](/reference/parameters). |
| `part(name, overrides?)` | Another definition's geometry, as an array of `Geom3`. See [part()](#part) below. |
| `jscad` | The whole `@jscad/modeling` library, for the things that are not flattened: `jscad.geometries`, `jscad.maths`, `jscad.modifiers`, `jscad.minkowski`. |
| `Math` | The normal `Math`, except that `Math.random()` is **seeded**: the same code with the same parameter values always gets the same numbers, so a re-run gives the same shape. Different parameter values give a different sequence. |
| 93 JSCAD names | Every entry of the modeling namespaces below, by its plain name: `cuboid`, `union`, `translate`, `extrudeLinear`, `colorize`… |
| `self`, `globalThis`, `postMessage`, `importScripts`, `fetch`, `XMLHttpRequest`, `WebSocket` | Set to `undefined`. This is hygiene, **not a sandbox**: see [FAQ and limitations](/help/faq). |

Other worker globals are not hidden. `console.log()` works and prints to the browser's developer console (the worker's
context), which is handy for debugging.

::: warning The built-in names are taken
All of these names are parameters of the wrapper function, so you cannot declare a variable with the same name.
`const center = [0, 0, 5]` fails with:

`Identifier 'center' has already been declared — "center" is a built-in name here (a jscad function, params, part or Math); pick another name`

Names that people often reach for by accident: `center`, `scale`, `align`, `mirror`, `offset`, `expand`, `project`,
`slice`, `flatten`, `hull`, `line`, `arc`, `circle`, `square`, `star`, `polygon`, `triangle`, `transform`, `union`,
`params`, `part`, `jscad` and `Math`. Pick another name, such as `mid` or `pos`. The same applies when you destructure
parameters: `const { center } = params` fails, while `params.center` is fine.
:::

### The flattened JSCAD functions

3Dica walks these namespaces of `@jscad/modeling` in this order and puts every entry in scope under its own name.
There are 93 of them and no two collide. This list is generated from the engine (`FLAT_NAMES` in
`src/eval/engine.ts`).

| Namespace | Names in scope |
|---|---|
| `primitives` (21) | `arc`, `circle`, `cube`, `cuboid`, `cylinder`, `cylinderElliptic`, `ellipse`, `ellipsoid`, `geodesicSphere`, `line`, `polygon`, `polyhedron`, `rectangle`, `roundedCuboid`, `roundedCylinder`, `roundedRectangle`, `sphere`, `square`, `star`, `torus`, `triangle` |
| `booleans` (5) | `intersect`, `minkowski`, `scission`, `subtract`, `union` |
| `transforms` (22) | `align`, `center`, `centerX`, `centerY`, `centerZ`, `mirror`, `mirrorX`, `mirrorY`, `mirrorZ`, `rotate`, `rotateX`, `rotateY`, `rotateZ`, `scale`, `scaleX`, `scaleY`, `scaleZ`, `transform`, `translate`, `translateX`, `translateY`, `translateZ` |
| `extrusions` (7) | `extrudeFromSlices`, `extrudeLinear`, `extrudeRectangular`, `extrudeRotate`, `extrudeHelical`, `project`, `slice` |
| `hulls` (4) | `hull`, `hullChain`, `hullPoints2`, `hullPoints3` |
| `expansions` (2) | `expand`, `offset` |
| `colors` (10) | `colorize`, `colorNameToRgb`, `cssColors`, `hexToRgb`, `hslToRgb`, `hsvToRgb`, `hueToColorComponent`, `rgbToHex`, `rgbToHsl`, `rgbToHsv` |
| `measurements` (12) | `measureAggregateArea`, `measureAggregateBoundingBox`, `measureAggregateEpsilon`, `measureAggregateVolume`, `measureArea`, `measureBoundingBox`, `measureBoundingSphere`, `measureCenter`, `measureCenterOfMass`, `measureDimensions`, `measureEpsilon`, `measureVolume` |
| `text` (2) | `vectorChar`, `vectorText` |
| `utils` (7) | `areAllShapesTheSameType`, `degToRad`, `flatten`, `fnNumberSort`, `insertSorted`, `radiusToSegments`, `radToDeg` |
| `curves` (1) | `bezier` (an object: `bezier.create`, `bezier.valueAt`, `bezier.tangentAt`, `bezier.lengths`, `bezier.length`, `bezier.arcLengthToT`) |

Three of these are objects, not functions: `cssColors` (named colors), `slice` (the slice helpers used with
`extrudeFromSlices`, such as `slice.fromPoints`) and `bezier`. Everything else is reachable through `jscad`:

```js
const { path2, geom2 } = jscad.geometries      // geom2, geom3, path2, poly2, poly3
const { vec3, mat4 } = jscad.maths             // constants, line2, line3, mat4, plane, utils, vec2, vec3, vec4
const { retessellate } = jscad.modifiers       // generalize, snap, retessellate
const { minkowskiSum } = jscad.minkowski
```

For what each function takes, see the [JSCAD API documentation](https://openjscad.xyz/v2/docs/). The functions that
**create** polygons (the `primitives`, `extrusions`, `hulls` and `expansions` namespaces) are wrapped by a geometry
guard, also when you reach them as `jscad.primitives.sphere`. See [Limits](#limits).

## part()

`part(name, overrides?)` returns another definition's geometry, like calling a module in OpenSCAD. It is how one
object is built from others, and how you make arrays and variants in code.

```js
// "Bolt sizes" in the sample: five bolts of increasing length, built from the Bolt definition
const out = []
for (let i = 0; i < params.count; i++) {
  const length = params.start + i * params.step
  out.push(translate([i * params.spacing, 0, length], part('Bolt', { length })))
}
return out
```

### The name must be a string literal

Before 3Dica runs any code, it scans the text for `part('Name'` and `part("Name"` to learn which definitions the code
depends on. That static list feeds the cache keys and the cycle check, so a name that only exists at run time cannot
work.

| You write | Result |
|---|---|
| `part('Bolt')` or `part("Bolt")` | Works. |
| `part('Bolt', { length: 20 })` | Works. |
| `// part('Bolt')` | Ignored: the scan skips `//` and `/* */` comments, so a commented-out call is not a dependency. |
| `const n = 'Bolt'; part(n)` | Fails when it runs: `part("Bolt"): not a dependency of "Rack" — call part with a string literal, e.g. part('Bolt')` |
| `` part(`Bolt`) `` (template literal) | Fails the same way. Only `'…'` and `"…"` count. |
| `part ('Bolt')` (space before the parenthesis) | Fails the same way. Write `part(` with no space. |
| `part('Nut')` with no definition named Nut | The code does not run. Error `Unknown part "Nut" — no definition with that name`, on the line of the call. |

If you need to choose between parts at run time, name each one literally and pick between the results:

```js
const head = params.style === 'hex' ? part('Hex head') : part('Round head')
```

Both names are in the text, so both definitions must exist and both are dependencies. Only the one you call is
evaluated.

### Overrides

`overrides` is an object of parameter values for the target. They are merged over the target's defaults, and they are
checked strictly:

| Problem | Error |
|---|---|
| A name the target does not declare | `part("Hex nut"): unknown parameters "len", "foo" — "Hex nut" has parameters size, thickness, hole` |
| A value of the wrong type | `part("Hex nut"): size must be a finite number` (or `true or false`, or `one of "lip", "flat"`) |
| Not an object | `part("Hex nut", overrides): overrides must be an object, e.g. { length: 20 }` |
| Any override for a group | `part("Fixture"): groups have no parameters` |

The calling object's own parameters do not flow into the part. Pass what you need explicitly, as in
`part('Bracket', { width: params.width })`.

### What part() returns

- An **array** of `Geom3`, in the target's **own local coordinates**: the shape as if it were placed at the origin
  with no transform. Place it with `translate`, `rotate` and friends, which accept arrays too.
- For a **group** target, the transforms of the children inside the group are applied, the children's own parameter
  overrides apply, a boolean group (union, subtract, intersect) returns its result, and **hidden children are left
  out**.
- **Colors:** only colors that code baked in with `colorize` come along. The target's definition color and instance
  colors do not, because they belong to the tree, not to the geometry.
- The array is new on every call, so you can `push` to it or `map` over it. The geometries themselves are shared, which
  is safe because JSCAD functions never modify their inputs.
- Calling `part()` again with the same overrides is cheap: the worker remembers recent results (see
  [Caching](#caching-and-performance)).

### OpenSCAD objects

The target of `part()` can be an [OpenSCAD object](/guide/openscad). Its geometry comes back like any other: an array
in its own coordinates, with the colours its `color()` calls set. Pass its parameters by name, and give a choice
parameter its option text, as the Inspector shows it, or the drop-down item's value from the OpenSCAD code:
`part('bracket', { length: 80, screw: 'M5' })` and `part('bracket', { length: 80, screw: 5 })` are the same.

It works the other way round too: OpenSCAD code can place this definition with `part("Name", width = 20);`. See
[part() both ways](/guide/openscad#part-both-ways).

### Dependencies and the rest of the app

- **Renaming** a definition rewrites `part('Old'` and `part("Old"` in every code object, so calls keep working.
- **Deleting** a definition is refused while code uses it: `Can't delete 'Bolt': used by code in 'Bolt sizes'`.
- In the Library, a definition that has no instances but is used by code shows **part()** instead of **unused**, and
  **Purge** keeps it.
- **Cycles** are reported, not run. If A calls `part('B')` and B calls `part('A')`, both show
  `Cycle: A → B → A`. The tree refuses to put a group inside itself, directly or through a `part()` call, with a
  message such as `Can't put 'Fixture' inside itself`.
- If a part fails, the code that uses it fails too, with `depends on "Bolt" (failed)`. Fix the inner object first: its
  own error message and line number are on its definition.

## Return values and their messages

| Your code returns | Outcome |
|---|---|
| One `Geom3`, or an array of them (nested arrays are fine) | OK. One mesh per geometry. |
| `undefined`, `null` or `[]` | OK, with the warning `Returned nothing`. |
| 2D geometry (`circle()`, `rectangle()`, a `path2`…) | Error `Returned 2D geometry — extrude it first (e.g. extrudeLinear)` |
| Anything else: a number, a string, a Promise… | Error `Return a 3D geometry or an array of them; got number` (or `string`, `Promise`, `object`…) |
| Geometry with a `NaN` or infinite coordinate | Error `Result has invalid vertex positions (NaN or Infinity)`. Usually a parameter that is `undefined`. |
| More than 2,000,000 triangles in total | Error `Too many triangles: <count> (the limit is 2,000,000) — lower the segments` |
| Geometry with no triangles at all | OK, with the warning `Result has no triangles`. |

Warnings show after a ⚠ on the status line under the editor, as in `✓ 3 ms · 0 triangles · ⚠ Returned nothing`.

## Errors and line numbers

When code fails, 3Dica shows the error in four places:

- **The editor**: a red marker in the gutter and a wavy underline on the line. Hover it for the message.
- **The status line** under the editor: `✕ <message> (line <line>:<column>)`.
- **A red dot** on the object's row in the Scene tree and in the Library. Its tooltip says `Error: <message>`. A group
  row turns red when something inside it fails.
- **The 3D view** keeps the last good mesh, tinted red, so the model does not vanish while you type. An object that
  never evaluated successfully draws nothing.

![A runtime error: gutter marker on line 2 and the status line](/shots/code-error.png)

Line and column numbers refer to **your** code, counted from 1. That holds for errors thrown by a JSCAD function you
called too: `roundedCuboid({ size: [2, 2, 2], roundRadius: 5 })` reports
`roundRadius must be smaller than the radius of all dimensions` on the line of the `roundedCuboid` call.

| Kind | When | Line number |
|---|---|---|
| Syntax | The code does not parse: `Unexpected token 'return'`, `Cannot use import statement outside a module`, `await is only valid in async functions…` | The JavaScript engine gives none, so the editor marks the first syntax error it finds itself. |
| Runtime | Your code or a JSCAD function throws: `ReferenceError: cubiod is not defined`, your own `throw new Error(…)` | Yes |
| Result | The return value is wrong (see the table above) | No |
| Dependency | `Unknown part "Nut" — …`, or `depends on "Bolt" (failed)` | On the `part()` call |
| Cycle | `Cycle: A → B → A` | On the `part()` call |
| Timeout | `Timed out after 20 s (infinite loop or very slow boolean?)` | No |
| Crash | `The evaluator crashed (…)`: the worker itself failed, for example because it ran out of memory | No |

Throwing your own error is a good way to reject parameter values that make no sense, because the message shows up
right where the user is looking:

```js
const { width, wall } = params
if (2 * wall >= width) throw new Error(`wall ${wall} is too thick for width ${width}`)
```

A failed result is not retried automatically. It runs again when its code or parameters change, or when you press
<kbd>Ctrl</kbd>+<kbd>Enter</kbd>. See [Troubleshooting](/help/troubleshooting) for what to do about each message.

## Limits

These limits keep a runaway script from freezing or crashing the tab. A Web Worker that runs out of memory takes the
whole page down before a timeout can act, so 3Dica stops geometry that is growing out of control while it is still
being built.

| Limit | Value | What happens |
|---|---|---|
| Time per evaluation | 20 s | `Timed out after 20 s (infinite loop or very slow boolean?)`. The worker is restarted. Add `?evalTimeout=<ms>` to the URL to change it, for example `?evalTimeout=60000`. |
| Abandoned work | 1 s | An evaluation whose result is no longer wanted (you typed over the code, or deleted the object) is stopped once it has run for 1 s. That is how a `while (true)` disappears about a second after you fix it. |
| A single call | 2,000,000 triangles | A primitive or extrusion whose arguments alone would make too much geometry fails before it is built: `Too much geometry: sphere with segments 5,000 makes about 12,500,000 polygons (the limit is 2,000,000 triangles) — lower the segments` |
| Geometry created per evaluation | 2,000,000 polygons | Counted over every primitive, extrusion, hull and expansion call, including those inside `part()`: `Too much geometry: this code made more than 2,000,000 polygons (a loop that never ends?) — stopped before the page runs out of memory` |
| Triangles per result | 2,000,000 | `Too many triangles: … — lower the segments` |
| `part()` and group nesting | 64 levels | `Cycle: nesting deeper than 64 levels (…)` |
| STL export | 60 s | `STL export timed out after 60 s` |
| Crashes | 3 within 10 s | The worker is restarted after each crash. After the third, evaluation stops with `Evaluator keeps crashing — reload the page`. |

OpenSCAD objects share these limits and add a few of their own, for recursion, list and string sizes and runaway
loops: see [OpenSCAD support › Limits](/reference/openscad#limits).

If the whole tab dies while evaluating (out of memory), the next start restores your project with its code **paused**
and tells you which object was running. Fix that object's code, then click **Run code**. See
[Files, autosave and STL](/reference/files).

::: details How the geometry guard estimates a call
The estimate uses only the call's arguments, so it is a lower bound that can be checked before JSCAD allocates
anything (`s` is `segments`):

| Function | Estimated polygons |
|---|---|
| `sphere`, `ellipsoid`, `roundedCuboid`, `roundedCylinder` | s² / 2 (default s = 32) |
| `cylinder`, `cylinderElliptic` | 3 · s |
| `torus` | 2 · `innerSegments` · `outerSegments` |
| `geodesicSphere` | 20 · (`frequency` / 6)² |
| `circle`, `ellipse`, `arc`, `roundedRectangle` | s (points) |
| `extrudeLinear` | `twistSteps` × points of the outline |
| `extrudeRotate` | s × points of the outline (default s = 12) |
| `extrudeHelical` | `segmentsPerRotation` × turns × points of the outline |

So a sphere is refused from about 2,000 segments, and a cylinder from about 667,000.
:::

## Caching and performance

### How results are cached

Every result is stored under a key made of:

- the code text,
- the parameter definitions (names, types, defaults and choice options),
- the keys of every definition named in a `part()` call, and
- the parameter values this evaluation receives.

Names and colors are **not** part of the key, and neither are min, max and step. Renaming or recoloring an object never
re-runs anything. Copies with the same parameter values share one result: the eight bolts of the sample are evaluated
once and drawn eight times.

Booleans in the tree are cached the same way. Moving the cutter of a subtract group re-runs the boolean, but not the
cutter's or the base's own code.

The worker keeps up to 200 recent results (and at most about 2,000,000 polygon vertices of them) and the last 100
compiled code texts. The page keeps up to 300 meshes (and at most 256 MB). Going back to a value you had a moment ago,
or pressing undo, is usually instant.

### Tips

1. **Keep `segments` modest.** The templates use 32. A sphere's polygon count grows with the square of its segments:
   doubling them makes the sphere four times heavier.
2. **Booleans are the slow part of JSCAD.** `union`, `subtract` and `intersect` (and `hull` and `minkowski`) cost far
   more than primitives and transforms. When parts only need to touch or overlap, return them as an array instead of a
   union: the sample's Bolt returns `[head, shank]` and needs no boolean at all.
3. **Split expensive pieces into their own definitions** and combine them with `part()` or with groups. Each piece is
   cached on its own, so editing one does not recompute the others.
4. **Use parameters for variants** instead of editing code. Every set of values is cached, so switching back and forth
   costs nothing after the first time.
5. **Keep code deterministic.** Results are cached by key, so code that reads the clock or other changing state does
   not re-run when that state changes. `Math.random()` is seeded, so it is safe.
6. **Work on the selected object.** The selected object, and the definition selected in the Library, are evaluated
   before everything else.
7. **Watch the status line.** `✓ 18 ms · 4,382 triangles` tells you what each change costs, and the status bar shows
   the object that is running and for how long.

## Worked examples

Each example below is a complete definition: add a **Code** object, set up the parameter table as shown (see
[Parameters](/reference/parameters)), and paste the code. All of them were run in the 3Dica engine.

### A parametric box with a lid

An open box, and a lid printed upside down next to it. The `lid` parameter is a choice: a lid with a lip that fits
inside the box, a flat lid, or no lid.

| Parameter | Type | Default | Min | Max | Step |
|---|---|---|---|---|---|
| `width` | number | 60 | 20 | 200 | 1 |
| `depth` | number | 40 | 20 | 200 | 1 |
| `height` | number | 30 | 10 | 150 | 1 |
| `wall` | number | 2 | 0.8 | 6 | 0.2 |
| `clearance` | number | 0.3 | 0 | 1 | 0.05 |
| `lid` | choice: `lip, flat, none` | lip | | | |

```js
const { width, depth, height, wall, clearance, lid } = params
// the box: an open-topped shell
const outer = cuboid({ size: [width, depth, height], center: [0, 0, height / 2] })
const cavity = cuboid({ size: [width - 2 * wall, depth - 2 * wall, height], center: [0, 0, height / 2 + wall] })
const box = subtract(outer, cavity)
if (lid === 'none') return box

// the lid, printed upside down next to the box
const plate = cuboid({ size: [width, depth, wall], center: [0, 0, wall / 2] })
if (lid === 'flat') return [box, translateX(width + 10, plate)]
const lw = width - 2 * wall - 2 * clearance   // the lip fits inside the cavity
const ld = depth - 2 * wall - 2 * clearance
const lip = subtract(
  cuboid({ size: [lw, ld, 4], center: [0, 0, wall + 2] }),
  cuboid({ size: [lw - 2 * wall, ld - 2 * wall, 6], center: [0, 0, wall + 2] }),
)
return [box, translateX(width + 10, union(plate, lip))]
```

The cavity is as tall as the box but starts `wall` higher, so it cuts through the top and leaves a floor. The lip's
inner cutter is taller than the lip, so the two never share a face, which keeps the boolean clean.

### A hex nut

A 6-segment cylinder is a hexagonal prism, which is the classic trick from OpenSCAD. Its `radius` goes to the corners,
so convert the width across the flats first.

| Parameter | Type | Default | Min | Max | Step |
|---|---|---|---|---|---|
| `size` | number | 8 | 3 | 50 | 0.5 |
| `thickness` | number | 4 | 1 | 30 | 0.5 |
| `hole` | number | 5 | 1 | 40 | 0.5 |

```js
const { size, thickness, hole } = params   // size = width across the flats
// a 6-segment cylinder is a hexagonal prism; its radius goes to the corners
const r = size / 2 / Math.cos(Math.PI / 6)
const body = cylinder({ radius: r, height: thickness, segments: 6, center: [0, 0, thickness / 2] })
const bore = cylinder({ radius: hole / 2, height: thickness + 2, segments: 32, center: [0, 0, thickness / 2] })
return subtract(body, bore)
```

With the defaults (an M5 nut) the result is 8 mm across the flats, about 9.24 mm across the corners and 212 triangles.
The bore is 2 mm taller than the nut so that it cuts cleanly through both faces. Name this definition **Hex nut**: the
array examples below use it.

### A twisted vase

`extrudeLinear` can twist its outline as it rises. The vase twists a star-shaped outline, hollows it out with the same
outline shrunk by `offset`, and adds a floor.

| Parameter | Type | Default | Min | Max | Step |
|---|---|---|---|---|---|
| `height` | number | 80 | 20 | 200 | 1 |
| `radius` | number | 30 | 10 | 80 | 1 |
| `lobes` | number | 7 | 3 | 16 | 1 |
| `twist` | number | 90 | -360 | 360 | 5 |
| `wall` | number | 1.6 | 0.8 | 5 | 0.2 |

```js
const { height, radius, lobes, twist, wall } = params
const outline = star({ vertices: lobes, outerRadius: radius, innerRadius: radius * 0.8 })
const inside = offset({ delta: -wall }, outline)
// the same twist rate everywhere, so the wall stays even
const rate = degToRad(twist) / height
const twisted = (shape, h) => extrudeLinear({ height: h, twistAngle: rate * h, twistSteps: Math.ceil(h / 2) }, shape)
const walls = subtract(twisted(outline, height), twisted(inside, height))
return union(walls, twisted(outline, wall))   // add a floor
```

`twist` is in degrees for the person using the parameter table and converted with `degToRad`, because `twistAngle` is
in radians. The floor twists at the same rate as the walls, so it lines up with them. The two booleans make this the
slowest example here: about half a second and 2,500 triangles.

::: tip Printing in vase mode
If your slicer has a vase (spiral) mode, it wants a **solid**: return `twisted(outline, height)` alone and let the
slicer make the single wall. That needs no booleans at all.
:::

### Arrays with part()

Code is the way to make arrays in 3Dica: build the item once as its own definition, then place copies with `part()`.
Both examples use the **Hex nut** definition above.

A ring of nuts:

| Parameter | Type | Default | Min | Max | Step |
|---|---|---|---|---|---|
| `count` | number | 8 | 1 | 36 | 1 |
| `radius` | number | 30 | 5 | 200 | 1 |

```js
const { count, radius } = params
const nut = part('Hex nut')   // Geom3[] in the nut's own coordinates
const out = []
for (let i = 0; i < count; i++) {
  out.push(rotateZ((i * 2 * Math.PI) / count, translateX(radius, nut)))
}
return out   // an array of arrays is fine: it is flattened
```

A row of different sizes, with overrides (this one needs no parameters):

```js
const out = []
let x = 0
for (const size of [6, 8, 10, 13]) {
  out.push(translateX(x, part('Hex nut', { size, thickness: size / 2, hole: size * 0.6 })))
  x += size + 4
}
return out
```

Edit the Hex nut definition and both arrays follow. Each distinct set of overrides is evaluated once, so the ring
costs one nut no matter how many copies it has.

::: tip Arrays in the tree instead of code
If the copies should stay individually selectable, movable and overridable, place them in the tree as linked
instances (<kbd>Ctrl</kbd>+<kbd>D</kbd>) instead. See [Linked copies](/tutorials/linked-copies) and
[Code objects and part()](/tutorials/code-and-parts).
:::
