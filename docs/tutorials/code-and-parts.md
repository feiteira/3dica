# Tutorial 3: Code objects and part()

Templates only get you so far. In this tutorial you write a code object, an L-shaped bracket with its own parameters,
and then a second object that reuses it four times with `part()`, the way you would call an OpenSCAD module.

**You need:** an empty project. Click **New** and confirm with **New project**.

## 1. Write the Bracket

### Create and name it

Click **Code** in the toolbar. A code object named **Object** appears, a small rounded cube, and the editor at the
bottom right shows its starter code. Press <kbd>F2</kbd>, type **Bracket** and press <kbd>Enter</kbd>.

### Set up its parameters

In the inspector's **Definition** section, click **Parameter defaults** to open the table. While an instance is
selected it starts closed, and once you open it, it stays open until you reload the page. The table has one
parameter, `size`.

1. Click the **✕** at the end of the `size` row. The status line under the editor now shows an error, because the
   code still reads `size`. That's expected: the new code in a moment fixes it.
2. Click **Add parameter**. A row named `param` (a number, default 0) appears, with its name field focused. Select
   the name (<kbd>Ctrl</kbd>+<kbd>A</kbd>), type `width` and press <kbd>Enter</kbd>. Then click its **default** field,
   select the `0` (<kbd>Ctrl</kbd>+<kbd>A</kbd>), type `30` and press <kbd>Enter</kbd>.
3. Do the same for the other two:

| name | type | default |
|---|---|---|
| `width` | number | 30 |
| `height` | number | 25 |
| `thickness` | number | 3 |

![The Bracket's parameter table: width 30, height 25, thickness 3](/shots/tut3-02-params.png)

### Write the code

Click in the code editor, select everything (<kbd>Ctrl</kbd>+<kbd>A</kbd>) and paste this in its place. If you type it
instead, the editor adds closing brackets and indentation for you as you go.

```js
const { width, height, thickness } = params
const base = cuboid({ size: [width, 20, thickness], center: [0, 0, thickness / 2] })
const wall = cuboid({ size: [width, thickness, height], center: [0, 10 - thickness / 2, height / 2] })
return union(base, wall)
```

The code runs 0.4 s after you stop typing (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs it right away).

**You should see** an L-shaped bracket: a 30 × 20 × 3 mm base with a 25 mm wall along its back edge. The status line
reads something like *"✓ 3 ms · 20 triangles"*.

![The Bracket: code on the right, the bracket in the view](/shots/tut3-01-code.png)

How the code works:

- The code is the **body of a function**. It must `return` a 3D shape or an array of shapes.
- `params` holds the parameter defaults merged with this instance's overrides. It's read-only.
- `cuboid` and `union` come from [@jscad/modeling](https://github.com/jscad/OpenJSCAD.org). The functions of its
  main namespaces are in scope by their plain names; the rest are reached through `jscad`. See
  [Code API](/reference/code-api).
- `cuboid` is centered on its `center` point. `thickness / 2` and `height / 2` stand both pieces on the XY plane, and
  `10 - thickness / 2` puts the wall flush with the back edge of the 20 mm deep base.

::: tip Sliders
The **Parameters** section of the instance now has `width`, `height` and `thickness` fields. Fill in the **range**
(min and max) of a parameter in the table and its field gets a slider too.
:::

## 2. Reuse it with part()

### Create the Bracket row

Click **Code** again. A new **Object** appears next to the bracket. Press <kbd>F2</kbd> and rename it to
**Bracket row**.

In **Parameter defaults** (open it if it's closed), remove `size` and add two parameters. The error shows up again
until you replace the code.

| name | type | default |
|---|---|---|
| `count` | number | 4 |
| `width` | number | 20 |

Replace its code with:

```js
const out = []
for (let i = 0; i < params.count; i++) {
  out.push(translateX(i * (params.width + 5), part('Bracket', { width: params.width })))
}
return out
```

**You should see** four brackets in a row, each 20 mm wide with a 5 mm gap between them. The Library now lists
**Bracket** and **Bracket row**.

`part('Bracket', { width: params.width })` returns the Bracket definition's geometry with `width` overridden.
`height` and `thickness` keep Bracket's defaults. The geometry comes in Bracket's own coordinates, and `translateX`
moves each copy along the row.

### Hide the original

You don't need the first bracket in the scene any more. Click its **Bracket** row in the Scene tree and press
<kbd>H</kbd>.

**You should see** the original bracket disappear. Its row fades and its eye icon is crossed out, and the
**Unhide all** button at the top of the tree becomes active. The row of brackets is still there, because `part()`
reads the **definition**, not the instance you hid.

Click the **Bracket row** row to select it.

![Four brackets built with part(), with the Bracket row selected](/shots/tut3-03-part.png)

## 3. Things to try

- **Change the Bracket once.** Click **Bracket** in the Library and set the default `thickness` to 5. Every bracket in
  the row gets thicker. Press <kbd>Esc</kbd> to leave the isolate view.
- **Override on the instance.** Select the **Bracket row** in the tree and set `count` to 6 in its **Parameters**.
  Six brackets.
- **Make a mistake.** In Bracket row's code, change `width:` to `widht:` inside the `part()` call. The line is
  underlined, the status line says *✕ part("Bracket"): unknown parameter "widht" — "Bracket" has parameters width,
  height, thickness (line 3:47)*, and the tree row gets a red dot. The last good shape stays on screen, tinted red,
  until you fix it. Change it back to `width:`.
- **Rename a definition.** Double-click **Bracket** in the Library and call it **Angle**. The code of Bracket row is
  rewritten to `part('Angle', …)` for you.
- **Try to delete it.** Select **Angle** in the Library and press <kbd>Del</kbd>. 3Dica refuses: *"Can't delete
  'Angle': used by code in 'Bracket row'"*.

![An error in the code editor, here a throw on line 2 of the sample's Bolt: the red gutter marker, the underlined line and the status line](/shots/code-error.png)

::: warning part() needs a string literal
Write `part('Bracket')`, not `part(name)`. 3Dica reads the names from your code to know what depends on what, so
`const n = 'Bracket'; part(n)` fails with
`part("Bracket"): not a dependency of "Bracket row" — call part with a string literal, e.g. part('Bolt')`.
:::

::: info What you learned
- A code object's code is a function body that returns a shape or an array of shapes. The main JSCAD functions are in scope by name.
- The **Parameter defaults** table defines `params`: name, type, default, and optionally a range for a slider.
- Code edits run 0.4 s after you stop typing. Errors show in the gutter, the status line and as a red dot in the
  tree.
- `part('Name', { … })` reuses another definition's geometry with overrides, in that definition's own coordinates.
- Hiding an instance doesn't affect `part()`, which reads the definition.
- Renaming a definition rewrites its `part()` calls, and a definition that code still uses can't be deleted.
:::

Where next? [Coming from OpenSCAD](/guide/coming-from-openscad) maps OpenSCAD functions to JSCAD, and the
[Code API](/reference/code-api) lists everything you can use in code.
