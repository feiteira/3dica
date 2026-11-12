# Transforms and the gizmo

Every instance has a **transform**: a position, a rotation and a scale, relative to the group that holds it. You change it with the gizmo in the view or with the numbers in the inspector. Neither ever edits code: the code describes the shape, and the transform places it.

## Units, axes and rotation order

| | |
|---|---|
| Length | Millimetres |
| Angles | Degrees |
| Up | +Z, as in OpenSCAD. The grid lies on the XY plane. |
| Axis colours | X red, Y green, Z blue, in the gizmo and in the inspector fields |
| Frame | The parent group's space. A top-level instance is in world space. |

A transform is applied as **scale, then rotate about X, then Y, then Z (fixed axes), then translate**. As a matrix, `M = T(t) · Rz(rz) · Ry(ry) · Rx(rx) · S(s)`. That is exactly OpenSCAD's order, so a 3Dica instance with position `t`, rotation `r` and scale `s` matches:

```js
// OpenSCAD:  translate([tx, ty, tz]) rotate([rx, ry, rz]) scale([sx, sy, sz]) shape();
// the same placement in 3Dica code (JSCAD angles are radians):
const d = Math.PI / 180
translate([tx, ty, tz], rotate([rx * d, ry * d, rz * d], scale([sx, sy, sz], shape)))
```

Nested groups multiply. A bolt's world placement is the fixture's transform times the bolt's own. Fixture B in the sample sits at X = 75 mm and is turned 15° about Z, so its bolts are too, although their own transforms are the same as in Fixture A.

## The gizmo

The gizmo appears on the selected object when the view is not isolated and the object is not hidden. It sits at the object's origin, which for the toolbar primitives is the centre of the base. A definition selected from the Library has no gizmo, because it is not placed anywhere.

| Mode | Key | Handles |
|---|---|---|
| Move | <kbd>W</kbd> | Drag an arrow to move along one axis, a square to move in that plane, or the centre to move in the screen plane. |
| Rotate | <kbd>E</kbd> | Drag a ring to turn about that axis, the outer ring to turn about your view direction, or inside the rings to turn freely. |
| Scale | <kbd>R</kbd> | Drag a handle to scale along one axis, a square to scale two axes, or the centre to scale uniformly. |

![Move mode on Bolt sizes](/shots/gizmo-translate.png)

![Rotate mode on Bolt sizes](/shots/gizmo-rotate.png)

![Scale mode on Bolt sizes](/shots/gizmo-scale.png)

| Setting | Key | Effect |
|---|---|---|
| **World** / **Local** | <kbd>Q</kbd> | Align the move and rotate handles with the world axes, or with the object's own axes. Scale always uses the object's own axes. |
| **Snap** | <kbd>X</kbd> | On by default. Moves go in 1 mm steps, rotations in 15° steps and scaling in steps of 0.1. |
| Suspend snap | Hold <kbd>Ctrl</kbd> while dragging | Snapping is off until you release <kbd>Ctrl</kbd>. |

The camera does not orbit while you drag a handle.

### Live linked preview

While you drag, every other occurrence of the **same instance record** follows live. Drag the first bolt of Fixture A, and the first bolt of Fixture B moves with it, in Fixture B's frame, because both are one record in the `Fixture` definition. Nothing is evaluated during the drag. A boolean that contains the object keeps its previous result until you release, and then re-evaluates.

### One drag, one undo step

Releasing the mouse commits the drag as **one undo step**, named after the mode: `Move Bolt sizes`, `Rotate Bolt sizes`, `Scale Bolt sizes`.

- The values are stored as the instance's transform in its group, even in World mode, rounded to 0.0001.
- The parts of the transform the drag did not change keep their exact stored values, so a move never rewrites the rotation.
- A press on a handle without moving it changes nothing.
- Inside a linked group, a toast says how many copies changed (`Changed 'Fixture' — 2 copies updated`).

## Numeric fields

The inspector's **Transform** section has nine fields:

| Row | Unit | Arrow and spinner step |
|---|---|---|
| Position X, Y, Z | mm | 1 |
| Rotation X, Y, Z | ° | 15 |
| Scale X, Y, Z | × | 0.1 |

- Type a value and press <kbd>Enter</kbd>, or leave the field, to apply it. <kbd>Enter</kbd> also hands the keyboard back to the app, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the change.
- <kbd>Esc</kbd> puts the previous value back. An empty field, or text that is not a number, is ignored and the stored value comes back.
- A scale of 0 is refused with `Scale can't be 0`.
- Changes to the same field less than 0.5 s apart merge into one undo step, so clicking the spinner several times is one step.
- **Reset** sets position 0, rotation 0 and scale 1 (`Reset transform Bolt`).

The fields show at most four decimals.

## Mirroring

A negative scale mirrors. Set **Scale X** to `-1` to mirror an object across its YZ plane, and the same for Y and Z. Mirrored objects draw, combine in booleans and export to STL correctly. Only a scale of exactly 0 is refused.

When 3Dica has to re-express a mirrored transform for a new group (a tree move between groups with different transforms, or ungroup), it puts the mirror on **Scale X** and turns the rest into a rotation. For example, scale `[1, -1, 1]` can come back as scale `[-1, 1, 1]` with rotation Z 180°. The object looks exactly the same.

## World-preserving moves

Some commands change which group an object belongs to. They keep it where it is in the world:

| Command | What happens to the transform |
|---|---|
| Drag a row to another group | Recomputed for the new group, so the object stays put. If both groups have the same world transform, it is kept as it was. |
| <kbd>Ctrl</kbd>+drop | The copy gets the recomputed transform, the original is unchanged. |
| Wrap (∪ − ∩, <kbd>Ctrl</kbd>+<kbd>G</kbd>) | Unchanged: the new group has no transform of its own. |
| Ungroup | The group's transform is folded into each child. |

Recomputed values are rounded to 0.000001 mm and degrees, and scales to 10 significant digits, so no drift builds up.

A transform can't always be expressed as position, rotation and scale. A group with a **non-uniform scale** (for example `[2, 1, 1]`) around a **rotated** child shears that child. 3Dica draws it correctly, but it can't move that child out of the group without changing its shape:

- a tree move then keeps the child's local transform and warns `Kept local transform`, so the object jumps;
- ungroup is refused with `Can't ungroup 'Group': a child would be sheared (non-uniform scale with rotation)`.

These commands place things **in the group's own frame** and do not preserve a world position:

| Command | Placement |
|---|---|
| Toolbar **Add** | 5 mm to the right (+X) of the group's existing contents, see [Create](/reference/objects#create) |
| <kbd>Ctrl</kbd>+<kbd>D</kbd>, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> | The original's transform, moved along the group's +X by the object's width plus 5 mm |
| <kbd>Ctrl</kbd>+<kbd>V</kbd>, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | The copied transform, moved along +X the same way, in the group you paste into |
| Library row dropped into the tree | No transform: the origin of the group it lands in |

Inside a rotated group, "+X" is the group's own X axis.
