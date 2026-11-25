# Coming from OpenSCAD

If you know OpenSCAD, you already know most of 3Dica. The main shift is that **an OpenSCAD program draws the whole
scene, while in 3Dica every object is its own small program**. The tree decides where each copy goes. You still write
code for shapes, but placement, copies, booleans between parts and "show me just this one" become things you click.

## Keep your OpenSCAD code

You don't have to translate. **Import** in the toolbar (or dropping `.scad` files on the window) adds each file as an
**OpenSCAD object**: its code stays OpenSCAD, and 3Dica's built-in interpreter runs it, following OpenSCAD 2021.01.
Choose a file together with the files it uses or includes, and they are attached to it. The **OpenSCAD** toolbar
button starts a blank one.

- **Parameters work like the Customizer.** Top-level variables set to a number or `true`/`false`, or to a string with
  a list of options, become the object's parameters, and comments such as `// [10:100]` give them sliders and
  drop-downs. Each copy can override them, and a default you change in the Inspector is written back into the code.
- **`part("Name", width = 20);`** places another 3Dica object, and JavaScript code can `part()` an OpenSCAD object.
- **The editor shows OpenSCAD's console:** `echo()` lines and warnings appear in the **Output** panel under the code.
- **Not supported:** `import()`, `surface()` and DXF files. `text()` uses a built-in single-stroke font, sized and
  spaced like OpenSCAD's default font, so the letter shapes differ.

[OpenSCAD objects](/guide/openscad) explains all of this, and [OpenSCAD support](/reference/openscad) lists every
built-in module and function. The two kinds of object can `part()` each other, so one project can mix them.

The rest of this page is about writing objects in JavaScript (JSCAD).

## Concepts side by side

| OpenSCAD | 3Dica |
|---|---|
| `module bolt(length = 12) { … }` | A **definition** named "Bolt", with a **parameter** `length` (default 12) and code that returns the shape. |
| Calling `bolt();` several times | **Linked instances** of the definition in the tree (<kbd>Ctrl</kbd>+<kbd>D</kbd>), or `part('Bolt')` in another object's code. |
| `bolt(length = 20);` | An instance with a **parameter override** (`length` 20) set in the inspector, or `part('Bolt', { length: 20 })`. |
| `translate()` · `rotate()` · `scale()` around a call | The instance's **transform**: Position, Rotation and Scale in the inspector, or the gizmo (<kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd>). Inside code, use the JSCAD functions `translate`, `rotate`, `scale`. |
| `difference() { a(); b(); }` | A **Subtract group** in the tree (first child minus the others), or `subtract(a, b)` in code. |
| `union()` · `intersection()` | A **Union** or **Intersect** group, or `union(…)` and `intersect(…)` in code. |
| A module whose body calls other modules | A **group definition** with child instances. Groups can be placed, copied and linked like anything else. |
| `!` (show only this) | **Isolate** (<kbd>I</kbd>): the selected object's definition alone, at the origin. |
| `#` (highlight) | **Select** it: blue highlight and outline. Select a Subtract group and its cutters show in translucent red. |
| `%` (transparent background) | **Ghost** (<kbd>G</kbd>, on by default): everything outside the selection is faded. It only changes the display. |
| `*` (disable) | **Hide** (<kbd>H</kbd>). A hidden instance is left out of the view, its group's boolean and `part()` result, and the STL. <kbd>Alt</kbd>+<kbd>H</kbd> unhides all. |
| `$fn`, `$fa`, `$fs` | The `segments` option of each JSCAD call, for example `cylinder({ radius: 5, height: 10, segments: 64 })`. The Sphere and Cylinder templates expose it as a parameter. There's no global setting. |
| Customizer (`// [0:100]` comments) | The definition's **parameter table**: number (with min, max and step for a slider), boolean (checkbox) or choice (drop-down). Each instance can override any of them. |
| `echo(x)` | `console.log(x)`. The output goes to the browser's developer console. |
| `assert(cond, "msg")` | `if (!cond) throw new Error('msg')`. The message shows in the code editor's gutter and status line, and the tree row gets a red dot. |
| `include <…>` · `use <…>` | No equivalent in JavaScript code: `part()` reuses definitions in the same project. An [OpenSCAD object](/guide/openscad#attached-files) can use and include files attached to it. |
| F5 / F6 render | No separate preview and render step. Every change re-evaluates only what it affects, in a Web Worker. Code edits run 0.4 s after you stop typing, and <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (or **Run** above the editor) runs them right away. |

## Shapes and operations

The functions of JSCAD's modeling namespaces (primitives, booleans, transforms, extrusions, hulls, expansions, colors
and a few more) are in scope by their plain names. The biggest trap is **centering**: JSCAD centers cuboids and
cylinders on the origin, while OpenSCAD puts them on the XY plane.

| OpenSCAD | JSCAD in 3Dica | Watch out |
|---|---|---|
| `cube([x, y, z])` | `cuboid({ size: [x, y, z] })` | Centered on the origin. Add `center: [x / 2, y / 2, z / 2]` to match OpenSCAD's corner-at-origin cube. |
| `cylinder(h = h, r = r)` | `cylinder({ height: h, radius: r })` | Centered on the origin. Use `center: [0, 0, h / 2]` to stand it on the XY plane. |
| `cylinder(h = h, r1 = a, r2 = b)` | `cylinderElliptic({ height: h, startRadius: [a, a], endRadius: [b, b] })` | The radii are `[x, y]` pairs. |
| `sphere(r = r)` | `sphere({ radius: r })` | |
| `square([x, y])` · `circle(r = r)` | `rectangle({ size: [x, y] })` · `circle({ radius: r })` | 2D shapes. They're centered too. |
| `linear_extrude(height = h) …` | `extrudeLinear({ height: h }, shape)` | Twist is `twistAngle`, in radians. |
| `rotate_extrude() …` | `extrudeRotate({ segments: 64 }, shape)` | |
| `rotate([x, y, z])` | `rotate([x, y, z], g)` | **Radians.** Write `rotate([0, 0, degToRad(45)], g)` or `rotateZ(degToRad(45), g)`. |
| `translate([x, y, z])` · `scale(s)` · `mirror([1, 0, 0])` | `translate([x, y, z], g)` · `scale([s, s, s], g)` · `mirror({ normal: [1, 0, 0] }, g)` | There are also shortcuts like `translateX`, `rotateZ` and `mirrorX`. |
| `hull() { … }` · `minkowski() { … }` | `hull(a, b)` · `minkowski(a, b)` | For `minkowski`, the second shape should be convex. |
| `color("red")` | `colorize([1, 0, 0], g)`, or the **Color** field in the inspector | An instance color beats a `colorize()` color, which beats the definition color. Booleans drop `colorize()` colors. |
| `for (i = [0 : n - 1]) …` | `for (let i = 0; i < n; i++) out.push(…)`, then `return out` | Code returns a shape or an array of shapes. |

The [Code API](/reference/code-api) lists everything that's in scope.

## A translation, step by step

A flange with a center bore and a ring of bolt holes, placed twice. In OpenSCAD:

::: code-group

```c [OpenSCAD]
$fn = 48;

module flange(d = 30, t = 4, holes = 4, hole_d = 4) {
  difference() {
    cylinder(h = t, d = d);
    translate([0, 0, -1]) cylinder(h = t + 2, d = 10);
    for (i = [0 : holes - 1])
      rotate([0, 0, i * 360 / holes])
        translate([d / 2 - 5, 0, -1]) cylinder(h = t + 2, d = hole_d);
  }
}

flange();
translate([40, 0, 0]) flange(d = 40, holes = 6);
```

```js [3Dica: the Flange definition]
// parameters: d 30, t 4, holes 4, holeD 4 (set in the parameter table)
const { d, t, holes, holeD } = params
const disc = cylinder({ radius: d / 2, height: t, segments: 48, center: [0, 0, t / 2] })
const bore = cylinder({ radius: 5, height: t + 2, segments: 48, center: [0, 0, t / 2] })
const cuts = []
for (let i = 0; i < holes; i++) {
  const hole = cylinder({ radius: holeD / 2, height: t + 2, segments: 24, center: [d / 2 - 5, 0, t / 2] })
  cuts.push(rotateZ(i * 2 * Math.PI / holes, hole))
}
return subtract(disc, bore, cuts)
```

:::

What changed:

- **The module becomes a definition.** Click **Code** in the toolbar and rename the object to "Flange" (<kbd>F2</kbd>).
  In the inspector's **Parameter defaults** table (click it open), replace `size` with `d`, `t`, `holes` and `holeD`,
  then paste the code. Parameter names must be valid JavaScript identifiers, so `hole_d` would work too.
- **Diameters become radii**, and **degrees become radians** (`2 * Math.PI / holes`).
- **Centering is explicit.** `center: [0, 0, t / 2]` stands the disc on the XY plane. The cutters are taller than the
  disc and share its center, so they poke through both faces.
- **`subtract` takes arrays.** `subtract(disc, bore, cuts)` cuts the bore and every hole in `cuts`.

The two placements at the bottom of the OpenSCAD file aren't code in 3Dica. You can make them in either of two ways:

**In the tree.** The Flange you just made is the first placement. Select it and press <kbd>Ctrl</kbd>+<kbd>D</kbd> to
add a linked copy, set its **Position X** to 40, and in **Parameters** set `d` to 40 and `holes` to 6. The two flanges
share one definition: change the code and both update.

**In code.** Make another code object that places both:

```js
return [
  part('Flange'),
  translateX(40, part('Flange', { d: 40, holes: 6 })),
]
```

`part()` returns the definition's geometry in its own coordinates, with the overrides you pass. The name must be a
string literal, so that 3Dica can see the dependency.

## Coordinates and conventions

- **Units are millimetres.** Every number is in mm, and STL files carry no units, so slicers read them as mm.
- **Z is up.** The grid is the XY plane. X is red and Y is green, as in OpenSCAD.
- **Rotation order matches OpenSCAD.** An instance's Rotation `[x, y, z]` (in degrees) turns about X first, then Y,
  then Z, exactly like `rotate([x, y, z])`. The whole transform works like
  `translate(position) rotate(rotation) scale(scale) child();`. JSCAD's `rotate([x, y, z], g)` in code uses the same
  order, but takes radians.
- **View presets:** <kbd>1</kbd> front, <kbd>3</kbd> right and <kbd>7</kbd> top, as on a numeric keypad.

## What doesn't carry over

In JavaScript (JSCAD) objects:

- **No libraries.** You can't include BOSL2 or MCAD in JavaScript code. Each definition sees JSCAD and `part()`.
  An OpenSCAD object can use or include library files you attach to it.
- **No shared functions between objects.** A helper function lives inside one definition's code. Reuse geometry
  with `part()`, not code.
- **No `children()`.** A group holds its own child instances. You can't pass children into a definition.
- **No `import()`** of STL or SVG files, and no animation (`$t`).
- **Slower booleans.** JSCAD is JavaScript, so keep `segments` sensible. 3Dica caches results and stops runaway
  code. See [Troubleshooting](/help/troubleshooting) when something is slow.

Ready to try it? [Tutorial 3: Code objects and part()](/tutorials/code-and-parts) walks through the code workflow.
