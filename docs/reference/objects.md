# Working with objects

This page lists every command that creates, selects, copies, restructures, hides, deletes or renames objects. Each one that changes the project is a single undo step. If the words *definition*, *instance* and *occurrence* are new to you, read [The 3Dica model](/concepts/model) first.

## Create

The first six toolbar buttons each add a new **definition** and one **instance** of it.

| Button | New definition | Parameters: default (min–max, step) | Shape |
|---|---|---|---|
| **Cube** | `Cube` | `width` 10, `depth` 10, `height` 10 (each 0.1–500, step 1) | A box, centred in X and Y, standing on the XY plane |
| **Sphere** | `Sphere` | `radius` 6 (0.1–500, 0.5), `segments` 32 (4–128, 1) | A sphere resting on the XY plane |
| **Cyl** | `Cylinder` | `radius` 5 (0.1–500, 0.5), `height` 10 (0.1–500, 1), `segments` 32 (4–128, 1) | A cylinder standing on the XY plane |
| **Torus** | `Torus` | `innerRadius` 1.5 (0.1–100, 0.1), `outerRadius` 6 (0.5–500, 0.5) | A ring lying on the XY plane |
| **Code** | `Object` | `size` 10 (0.1–500, 1) | A rounded cube, with a comment header that reminds you of the API |
| **Group** | `Group` | none | An empty plain group (op `none`) |

Every shape sits on Z = 0 and is centred in X and Y, so the instance position is the centre of its base. The primitives are ordinary code objects: select one and you can read and change its code in the editor. A second cube is named `Cube 2`, then `Cube 3`, and so on.

**Where it goes.** The new instance is added at the end of the **current group**: the group you are inside, or the scene's top level. If that group occurs more than once, every copy gets the object, and a toast says so (`Added to 'Fixture' — 2 copies updated`).

**Where it is placed.** 3Dica puts it 5 mm to the right of everything already in that group. The X position is `ceil(maxX + 5 + halfWidth)`, where `maxX` is the right edge (largest X) of the visible, evaluated objects in the group, and `halfWidth` is 5 for a cube, cylinder or code object, 6 for a sphere and 7.5 for a torus. Y and Z are 0. In an empty group, or before anything is evaluated, the object goes to the origin.

The new object is selected with the gizmo on it, and the view frames it if it is off screen. Each new code object gets the next colour of an eight-colour palette as its definition colour. A new group gets none. Undo label: `Add Cube`.

::: tip Adding to the top level
A tree click enters the clicked row's group. Press <kbd>Esc</kbd> until the breadcrumb shows only `Scene`, or click `Scene` in it, before you add.
:::

## Select

| Where | Action | Selects | Group you are inside afterwards |
|---|---|---|---|
| Scene tree | Click a row | That occurrence | Its parent group |
| Library | Click a row | The definition, and isolates it | Unchanged |
| View | Click | The outermost object under the pointer at the current level | Unchanged |
| View | <kbd>Ctrl</kbd>+click | The deepest part under the pointer | The group that holds that part |
| View | Double-click a group | The part under the pointer, one level inside the group | The group |
| View | Click empty space | Nothing | Unchanged |
| View | Click an object outside the current group | Its outermost object at the top level | The top level |
| View | Click the result of the boolean group you are inside | That boolean group | One level up |
| Keyboard | <kbd>Enter</kbd> with a group selected | Nothing | That group |
| Keyboard | <kbd>Esc</kbd> | See below | |
| Breadcrumb | Click a segment | See [Overlays](/reference/interface#overlays) | |

In the view, a click is a left-button press and release less than 4 px apart. A second click within 400 ms at the same spot is a double-click. Hidden objects can't be clicked, but ghosts and the operands of a selected boolean can. Where two surfaces coincide, as a boolean result and its base do, the deeper part wins, so operands stay clickable. Releasing the mouse after a gizmo drag never selects. The view does not pick at all while isolated.

**Esc** works in this order:

1. If the keyboard is in a text field or the code editor, it leaves the field.
2. If the view is isolated, it returns to the scene.
3. If you are inside a group, it selects that group and steps out one level.
4. Otherwise it clears the selection.

::: tip See every copy of a definition
Click a Library row, then press <kbd>Esc</kbd>. You are back in the scene with the definition still selected, and every occurrence of it is highlighted. <kbd>F</kbd> frames them all.
:::

## Duplicate

| Key | Command | Result |
|---|---|---|
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate (linked) | A new instance of the **same** definition, right after the original in the same group. It copies the label, the parameter overrides and the colour, and is never hidden. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> | Duplicate unique | The same, but the new instance places a **clone** of the definition (`Fixture 2`). A group clone keeps the same child definitions. |

The copy is offset along the group's +X by the object's width plus 5 mm, rounded up (15 mm before the object has been evaluated). It is selected with the gizmo on it. A linked duplicate raises the `◆N` count of the definition. Undo labels: `Duplicate Bolt`, `Duplicate unique Fixture A`.

## Copy and paste

| Key | Command | Result |
|---|---|---|
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy | Remembers the selected instance: its definition, transform, parameter overrides, colour and label. Toast: `Copied 'Bolt sizes'`. |
| <kbd>Ctrl</kbd>+<kbd>V</kbd> | Paste | Adds a new instance of the copied definition at the end of the **current group**, offset in +X by the copied object's width plus 5 mm. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | Paste unique | The same, with a clone of the definition. |

- Each paste lands one offset further than the previous one, so repeated pastes make a row.
- The pasted object is selected. Pasting into a group that occurs more than once adds the object to every copy, with a toast.
- The clipboard is 3Dica's own and lives in memory: it is not the system clipboard, and a reload empties it. Copy and paste work within one project.
- <kbd>Ctrl</kbd>+<kbd>C</kbd> without a selected object, and <kbd>Ctrl</kbd>+<kbd>V</kbd> with nothing copied, are left to the browser.
- Refused: pasting a group into itself (`Can't paste 'Fixture' inside itself`), or pasting after the copied definition was deleted (`The copied object no longer exists`).

Copy is not an undo step. Paste is: `Paste Bolt sizes`, `Paste unique Bolt sizes`.

## Make unique

<kbd>U</kbd>, or **Make unique** in the inspector, points the selected instance at a clone of its definition. The clone gets a new name and the same code, parameters and colour. A group clone gets new instance records for its children, with the same child definitions. A toast names the result: `'Bolt' → new definition 'Bolt 2'`.

It needs a definition with at least two instance records. Otherwise it is refused with `Only instance of 'Plate'. To diverge a copy of a linked group's child, Make Unique the group first.` Making a child of a linked group unique changes that child in every copy of the group. [Unique copies and Make unique](/concepts/model#unique-copies-and-make-unique) explains why, with the sample. Undo label: `Make unique Bolt`.

## Wrap and ungroup

**Wrap** puts the selected object into a new group:

| Button or key | New group | Op |
|---|---|---|
| ∪ | `Union` | union |
| − | `Subtract` | subtract |
| ∩ | `Intersect` | intersect |
| <kbd>Ctrl</kbd>+<kbd>G</kbd> | `Group` | none |

The selected instance, with its transform, becomes the only child of a new group definition (`Subtract 2` if `Subtract` is taken). An instance of the group, with no transform, takes its place, so nothing moves. The group is selected and expanded in the tree. Undo label: `Wrap in Subtract`.

To build a boolean, wrap the first operand, then add the others to the group: drag them onto the middle of the group's row, or paste with the group entered. For a subtract, the order matters. The first visible child is the base, and every later child cuts. Drag rows above or below each other to reorder them.

**Ungroup** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>, with a group selected) replaces the group's instance with copies of its children:

- The group's transform is folded into each child, so nothing moves.
- A colour on the group instance replaces the children's own instance colours, and a hidden group gives hidden children.
- A boolean's operation is lost: the children become separate objects.
- The group definition stays in the Library. If nothing else uses it, it shows `unused`.
- The first former child is selected.

It is refused for a code object (`'Bolt' is not a group`), and when a child would be sheared by a non-uniform scale under a rotation. Undo label: `Ungroup Group`.

## Drag and drop

Drag a row of the Scene tree to move it. Where it lands depends on where you release it:

| Pointer over | Drop result | Indicator |
|---|---|---|
| The top third of a row | Before that row, in the same group | Blue line above the row, indented to its level |
| The bottom third of a row | After that row, in the same group | Blue line below the row |
| The middle third of a **group** row | Inside that group, at the end | The row is highlighted in blue |
| The middle third of a code row | Before or after, whichever half is nearer | Blue line |
| The empty area below the rows | At the end of the top level | Blue line under the last row |

![Dragging a row: the blue insertion line shows where it will land](/shots/drag-drop.png)

- **A move keeps the world position.** 3Dica rewrites the moved instance's transform for its new group, so the object stays where it is on screen. The instance keeps its id. If the new group's transform can't express that, for example with a non-uniform scale under a rotation, the old local transform is kept, with the warning toast `Kept local transform`.
- **Hold <kbd>Ctrl</kbd> when you release** to place a linked copy at the same world position and leave the original where it was.
- **Drag a Library row** into the tree to add a new instance of that definition at the drop position. It has no transform, so it sits at the origin of the group it lands in.
- **Invalid targets** show a red line or a red highlight, and dropping there does nothing. You can't drop an object into itself or into its own children, or put a group inside itself, even indirectly through `part()`.
- Moving into or out of a group that occurs more than once changes every copy, with a toast.

Undo labels: `Move Bolt`, `Copy Bolt`, `Add Plate`. A file dropped anywhere on the window opens it instead (see [Files](/reference/files)).

## Hide and unhide

| Key or control | Result |
|---|---|
| <kbd>H</kbd>, the eye in the tree, or **Hidden** in the inspector | Hide or show the selected instance. |
| <kbd>Alt</kbd>+<kbd>H</kbd>, or **Unhide all** in the tree header | Show every hidden instance in the project. With nothing hidden, the toast says `Nothing is hidden`. |

The hidden flag belongs to the instance record, so hiding a child of a linked group hides it in every copy. A hidden object is not drawn, evaluated, used in booleans or exported. [Hidden](/concepts/model#hidden) lists the details. The gizmo does not attach to a hidden object. Undo labels: `Hide Bolt`, `Show Bolt`, `Unhide all`.

## Delete

<kbd>Del</kbd> or <kbd>Backspace</kbd> deletes the selection. What that means depends on what is selected:

| Selected | Result |
|---|---|
| An occurrence (tree or view) | Its **instance record** is removed from its group, in every copy of that group. The definition stays in the Library and shows `unused` if this was its last use. The selection is cleared, and you stay inside the same group. Undo label: `Delete Bolt`. |
| A definition (Library) | The **definition and every instance of it**, in every group, are removed. Groups emptied this way stay, empty. Undo label: `Delete definition Washer`. |

Deleting a definition (also with **Delete definition…** in the inspector):

- is **refused** while code calls it with `part()`, for example `Can't delete 'Bolt': used by code in 'Bolt sizes'`. In the sample, that is why Bolt can't be deleted;
- asks first when the definition still has instances: `Delete 'Washer' and its 4 instances (8 copies in the scene)?` **Cancel** is focused, so <kbd>Enter</kbd> or <kbd>Esc</kbd> keeps everything;
- happens at once when it has no instances.

A toast confirms it: `Deleted 'Washer'`. The scene itself can't be deleted.

![The confirmation before a definition with instances is deleted](/shots/dialog-delete.png)

## Purge unused

**Purge** in the Library header removes every definition that has no instances and that no code calls with `part()`. It repeats until nothing more can go, because removing an unused group can leave its children unused. The toast reports `Removed 3 unused definitions` or `Nothing to purge`. The button is disabled while nothing is unused. Undo label: `Purge unused`.

## Rename

Press <kbd>F2</kbd> with something selected, or double-click a name in the tree or the Library. An input opens in place. What you rename is the text you see:

| Where | Renames |
|---|---|
| A tree row whose instance has a label | The **label**. Clearing it removes the label, and the row shows the definition name again. |
| A tree row without a label | The **definition**, everywhere |
| A Library row | The **definition** |
| The inspector's **Label** field | The label |
| The inspector's **Name** field (Definition section) | The definition |

In the inline input, <kbd>Enter</kbd> applies the name, <kbd>Esc</kbd> cancels, and clicking elsewhere applies it too. A refused name keeps the input open with the reason under it after <kbd>Enter</kbd>. After a click elsewhere, it shows an error toast and keeps the old name.

A **definition name**:

- can't be empty, and spaces around it are trimmed;
- is at most 64 characters;
- can't contain quotes (`'`, `"`, `` ` ``), backslashes or line breaks;
- can't be `Scene`;
- must be unique (case-sensitive): `'Plate' is already used`.

Renaming a definition **rewrites every `part('Old'` and `part("Old"` call** in every code object to the new name, and the editor reloads if it shows one of them. Undo label: `Rename Bolt → Screw`.

A **label** can be any text up to 200 characters, and two instances can share one. The sample's fixtures are labelled `Fixture A` and `Fixture B`, so <kbd>F2</kbd> on their rows edits the label. Rename the `Fixture` definition from the Library or the inspector's **Name** field. Undo label: `Label Fixture A`.
