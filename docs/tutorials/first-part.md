# Tutorial 1: Your first part

In this tutorial you build a 40 × 30 × 5 mm plate with a hole through it, and export it as STL, without writing any
code. Along the way you meet the toolbar, the inspector, boolean groups and drag and drop in the tree.

**You need:** the app open ([feiteira.github.io/3dica](https://feiteira.github.io/3dica/) or a
[local copy](/guide/getting-started#or-run-it-locally)). It takes about ten minutes.

## 1. Start an empty project

Click **New** in the toolbar. 3Dica asks *"Replace the current project with an empty one? Save it first if you want
to keep it."* Click **New project**.

**You should see** an empty grid, `Untitled` next to **Scene** at the top of the tree, the message *"The scene is
empty"*, and an empty Library.

![An empty project called Untitled](/shots/tut1-01-new.png)

## 2. Add a cube and size it

Click **Cube** in the toolbar. The new cube is selected right away: the gizmo sits on it and the inspector shows
**Cube**.

In the inspector, find the **Parameters** section (marked *this instance*). Set the values one at a time: click the
field, select its current value (<kbd>Ctrl</kbd>+<kbd>A</kbd>), type the new number and press <kbd>Enter</kbd>. If you
only click and type, the digits are added to the old value, and `10` becomes `1040`.

| Parameter | Value |
|---|---|
| `width` | 40 |
| `depth` | 30 |
| `height` | 5 |

**You should see** the cube flatten into a 40 × 30 × 5 mm slab, sitting on the grid and centered on the origin.
A blue **●** next to each changed parameter means "overridden on this instance", and the **↺** button sets it back to
the default.

![The cube sized to 40 × 30 × 5](/shots/tut1-02-cube.png)

::: details Instance values or definition defaults?
**Cube** made a new definition named "Cube" with defaults of 10 × 10 × 10, and placed one instance of it. The values
you just typed are **overrides** on that instance. The definition's defaults are still 10. With a single instance it
makes no difference. [Tutorial 2](/tutorials/linked-copies) shows when it does.
:::

## 3. Add the cylinder that makes the hole

Click **Cyl**. A cylinder appears next to the slab (at X 30) and is selected.

1. In **Parameters**, set `radius` to **4**, the same way as before. `height` is already 10, so leave it.
2. In **Transform**, set **Position** to **X 0**, **Y 0**, **Z -2**. Select each value, type the new one and press
   <kbd>Enter</kbd>.

**You should see** the cylinder move into the middle of the slab. It now runs from 2 mm below the slab to 3 mm above
it, so it pokes through both faces. That overlap matters: a cutter that only just touches a face can leave a
paper-thin skin behind.

![A cylinder through the middle of the slab](/shots/tut1-03-cylinder.png)

::: tip Units and axes
Every number is in millimetres, and Z points up. You could also drag the gizmo's blue arrow down. **Snap** is on by
default, so it moves in 1 mm steps.
:::

## 4. Wrap the cube in a Subtract group

Click the **Cube** row in the Scene tree, then click the **Subtract** button (**−**) in the toolbar. It's the middle
one of the three boolean icons after **Group**, and its tooltip says *Wrap the selection in a Subtract*.

**You should see** a new row named **Subtract**, selected and expanded, with **Cube** inside it. The Library has a new
**Subtract** entry too. The inspector shows *Boolean subtract*, with the operation *"subtract (−) — child 0 minus the
rest"*. The view hasn't changed yet: a Subtract keeps its first child and cuts away all the others, and so far it only
has the cube.

![The cube wrapped in a Subtract group](/shots/tut1-04-wrap.png)

## 5. Drop the cylinder into the group

Drag the **Cylinder** row onto the **middle** of the **Subtract** row. When the whole Subtract row lights up blue,
release.

::: tip Where you drop matters
The middle of a group's row puts the object *inside* the group, as its last child. The top or bottom third of any row
shows a blue line instead, and places the object *before* or *after* that row.
:::

**You should see** the Cylinder move under Subtract, after Cube. Its icon turns red: it's a cutter now. The slab has a
hole. The cylinder didn't move, because dropping into a group keeps an object's position in the world.

Now click the **Subtract** row to select the group itself.

**You should see** the plate with its hole, and the cylinder drawn as a **translucent red cutter**. The inspector says
*"2 children · the first visible child is the base, the others cut"*.

![The finished hole, with the red cutter shown while the group is selected](/shots/tut1-05-hole.png)

## 6. Name it and export it

With the Subtract row still selected, press <kbd>F2</kbd>. The row's name becomes a text field. Type
**Plate with hole** and press <kbd>Enter</kbd>. Then press <kbd>Esc</kbd> to clear the selection.

**You should see** **Plate with hole** in the tree and in the Library. You renamed the definition, because the instance
had no label of its own.

![The finished plate with a hole](/shots/tut1-06-done.png)

Click **STL** in the toolbar. With nothing selected, 3Dica exports the whole scene and downloads `Untitled-scene.stl`.
A message confirms the file name and the triangle count. If an object is selected, only that object is exported, and
its name replaces `scene` in the file name.

To keep the project itself, click **Save** (<kbd>Ctrl</kbd>+<kbd>S</kbd>). It downloads `Untitled.3dica.json`, which
**Open** reads back later. 3Dica also autosaves in your browser as you work.

::: tip The same part in code
You built this in the tree. As a single code object, the same plate is three lines:

```js
const slab = cuboid({ size: [40, 30, 5], center: [0, 0, 2.5] })
const hole = cylinder({ radius: 4, height: 10, center: [0, 0, 3] })
return subtract(slab, hole)
```

Both ways are fine, and you can mix them. [Tutorial 3](/tutorials/code-and-parts) covers code objects.
:::

::: info What you learned
- **Cube**, **Cyl** and the other toolbar buttons add a new code object to the scene, already selected.
- **Parameters** in the inspector are per-instance overrides (●). **↺** resets one to the definition's default.
- **Position**, **Rotation** and **Scale** are typed in mm, degrees and × in the **Transform** section, or set with
  the gizmo.
- **∪ − ∩** wrap the selection in a boolean group. **Subtract** keeps the first child and cuts away the rest.
- Dragging a row onto the **middle** of a group row moves it inside, and keeps its position in the world.
- Selecting a boolean group shows its cutters in translucent red.
- <kbd>F2</kbd> renames, <kbd>Esc</kbd> clears the selection, and **STL** exports the selection or the whole scene.
:::

Next: [Tutorial 2: Linked copies](/tutorials/linked-copies).
