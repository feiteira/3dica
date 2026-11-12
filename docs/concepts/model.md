# The 3Dica model

Most of 3Dica follows from one idea: **you place definitions, you don't copy geometry.** This page explains what a definition, an instance and an occurrence are, how linking works, and how groups, context, isolate, ghosting, colours and hiding fit together. The examples use the sample project *Bracket kit*. Load it with **Sample** in the toolbar, or open the app with `?fresh`.

## Definitions, instances and occurrences

| Term | What it is | Where you see it |
|---|---|---|
| **Definition** | A reusable, named thing. A **code definition** is a JSCAD function body plus a parameter list. A **group definition** holds child instances and has an operation (`none`, `union`, `subtract` or `intersect`). | The **Library** lists every definition once. |
| **Instance** | One placement of a definition *inside a group*. It has a transform, an optional label, an optional colour, parameter overrides and a hidden flag. | The inspector's **Instance** section. |
| **Occurrence** | One copy that is actually drawn. An instance inside a group that is itself placed twice produces two occurrences. | Each row of the **Scene** tree, and each object in the view. |

Cube, Sphere, Cylinder and Torus are not special: each one is an ordinary code definition created from a template. The scene itself is a group definition named `Scene` (op `none`). It is never shown in the Library and you can't rename, delete or copy it.

### The sample, as a structure

```text
Scene                          (root group)
├─ Fixture A    instance i_fx1 of the group "Fixture"
│  ├─ Plate     i_plate        → code "Plate"
│  ├─ Washer    i_w1 … i_w4    → subtract group "Washer" (Disc minus Hole)
│  └─ Bolt      i_b1 … i_b4    → code "Bolt"
├─ Fixture B    instance i_fx2 of the SAME group "Fixture" (moved 75 mm in X, turned 15°)
│  └─ the same nine instance records, drawn a second time
└─ Bolt sizes   i_bs           → code "Bolt sizes" (calls part('Bolt') five times)
```

The four bolt **instance records** live inside the `Fixture` definition. `Fixture` occurs twice, so each record is drawn twice. That makes **8 occurrences** of `Bolt`. This is why:

- the Library shows `Bolt ×8`,
- every Bolt row in the tree has the badge `◆8`,
- the inspector says `4 instance records · 8 in the scene · used by code in 'Bolt sizes'`.

The `part('Bolt')` calls inside *Bolt sizes* are not counted. They are code that reads Bolt's geometry, not placements.

### Paths

An occurrence is identified by its **path**: the instance ids from the scene root down to it. The first bolt of Fixture A is `i_fx1/i_b1`, and the first bolt of Fixture B is `i_fx2/i_b1`. Both paths end in the same instance record `i_b1`. Selection, the tree, the breadcrumb and the context all work with paths, which is how 3Dica can tell two copies of the same record apart.

## The Library and the Scene

| | Library | Scene tree |
|---|---|---|
| Lists | Definitions, each once, sorted by name | Occurrences, in tree order |
| Count shown | `×N` = how many times it occurs in the scene | `◆N` badge when the definition occurs more than once |
| Click | Selects the **definition** and isolates it | Selects that **occurrence** |
| Edits from the inspector | The definition: name, colour, parameter defaults, code, group op | The instance first (transform, label, colour, overrides, hidden), then the definition below it |
| Unused | A definition with no placements shows `unused` and can be purged. If only code uses it through `part()`, it shows `part()` instead and Purge keeps it | Not shown |

See [Interface](/reference/interface) for every control of both panels.

## Linked by default

**Ctrl+D** duplicates by adding another **instance of the same definition**, not a copy of it. Anything that belongs to the definition is shared by every occurrence:

| Shared by every occurrence (definition) | Per instance record |
|---|---|
| The code and its parameter list (defaults, min, max, step) | Transform (position, rotation, scale) |
| A group's children and its operation | Label |
| The definition name and colour | Instance colour |
| | Parameter overrides |
| | Hidden flag |

When you select an occurrence, 3Dica shows you what is linked to it:

- the other occurrences of the same definition get a **purple tint** in the view and in the tree;
- the inspector shows `◆N` next to the definition name, and the banner `Definition shared by N copies — edits affect all`;
- after an edit that changed a group with more than one occurrence, a toast reports it, for example `Changed 'Fixture' — 2 copies updated`.

![A bolt of Fixture A selected: the seven other bolts, in both fixtures, are tinted purple in the view and in the tree](/shots/select-linked.png)

::: warning A child of a linked group is one record for every copy
An instance record inside a group belongs to the group's definition. If you select the first bolt of Fixture A and move it, hide it, recolour it or override its `length`, the first bolt of **Fixture B** changes too, because both are the record `i_b1` in `Fixture`. The gizmo even moves both live while you drag. To change only one fixture, give that fixture its own definition first (see the next section).
:::

## Unique copies and Make unique

There are two ways to get a copy that is **not** linked:

- **Ctrl+Shift+D** (duplicate unique) clones the definition and places the clone next to the original.
- **Make unique** (**U**, or the button in the inspector) points the selected instance at a clone of its definition.

Both make a **shallow** clone, one level deep. The clone gets a new name (`Fixture 2`, `Bolt 2`, …) and the same code, parameters and colour. A group clone gets **new instance records** for its children, but they point at the **same child definitions**. The children of a cloned group are still linked to the original's children by definition.

Make unique works on the selected **instance record**, and it needs a definition with at least two records. Here is what happens in the sample:

| You do | Result | Why |
|---|---|---|
| Select Fixture A › Bolt, press **U** | The Library gains `Bolt 2`. The first bolt of **both** fixtures now uses `Bolt 2` (`◆2`), the other six still use `Bolt` (`◆6`). Toasts: `'Bolt' → new definition 'Bolt 2'` and `Changed 'Fixture' — 2 copies updated`. | The record `i_b1` is inside `Fixture`, so it is the same record in both fixtures. |
| Select Fixture A › Plate, press **U** | Refused: `Only instance of 'Plate'. To diverge a copy of a linked group's child, Make Unique the group first.` | `Plate` has a single record, `i_plate` in `Fixture`. One record can't be split from itself. |
| Select **Fixture A**, press **U** | The Library gains `Fixture 2`. Fixture A now places `Fixture 2`, Fixture B still places `Fixture`. | `Fixture` had two records (`i_fx1`, `i_fx2`) in the scene root, which is not shared. |
| Then select Fixture A › Plate and set its `width` override | Only Fixture A's plate changes. | The plate record now belongs to `Fixture 2`, which occurs once. `Plate` now has two records, so **U** on it would work too. |

So the rule is: **to diverge one copy of something inside a linked group, make the group unique first, then work inside it.** [Tutorial 2](/tutorials/linked-copies) walks through exactly this.

## Groups and their operations

A group definition has one of four operations. You choose it with the **Operation** selector in the inspector, or you get one directly by wrapping the selection with the toolbar buttons ∪ − ∩ (**Ctrl+G** wraps in a plain group).

| Op | Result | Drawn as |
|---|---|---|
| `none` | A plain assembly. The children are drawn separately and never merged. | Each child on its own. |
| `union` | All visible children merged into one solid. | One result mesh. |
| `subtract` | The **first visible child** minus all the other visible children. | One result mesh. |
| `intersect` | Only the volume common to every visible child. If one child is empty, the result is empty, with a warning. | One result mesh. |

Hidden children take no part in an operation. If you hide the first child of a subtract, the next visible child becomes the base.

A boolean group (union, subtract or intersect) normally shows only its **result**. When you select the boolean, or anything inside it, or enter it, its **operands** appear as well, and you can click them:

- the base (first visible child) as a wireframe in its own colour,
- subtract cutters as translucent red,
- the other operands of a union or intersect translucent in their own colour.

When an operand itself is selected, the result is ghosted so you can see what you are editing. In the tree, the kind icon of a cutter row is red.

![The Washer occurrence selected and framed: its Disc base as a wireframe and its Hole cutter in translucent red](/shots/operands.png)

::: tip
Booleans drop colours that code baked in with `colorize()`. See [Colours](#colours) for the colour a result gets instead.
:::

## Context and isolate

Both modes help you work on one part of a bigger model, in different ways:

| | Context (inside a group) | Isolate |
|---|---|---|
| What you see | The whole scene at world positions. With **Ghost** on, everything outside the selection (or outside the group, when nothing is selected) is translucent. | Only the selected **definition**, alone, at the origin, with no transform. |
| Parameters used | Each occurrence's own | The selected occurrence's overrides, or the defaults for a Library selection |
| Enter it | Double-click a group in the view, press **Enter** with a group selected, or click a breadcrumb segment. Clicking a tree row also puts you in that row's parent group. | Press **I** or **Isolate** with something selected, or click a Library row. |
| Leave it | **Esc** steps out one level. Clicking an object outside the group leaves it. **Scene** in the breadcrumb goes to the top. | **I**, **Esc**, or the × on the banner. Clicking a tree row also leaves an isolate that a Library click started. |
| Picking and gizmo | On. Clicks select at the level you are in. | Off. The view frames the object automatically. |
| Toolbar **Add** and **Paste** | Add into the entered group, and so into every copy of it | Add into the group you were in, select the new object and return to the scene |
| Shown by | The breadcrumb (`Scene › Fixture A ◆2 › …`), `Inside Fixture A` in the status bar, and a blue bar on the group's tree row | The banner `Isolated: Bolt (length 12, diameter 5) — I or Esc to return` and `Isolate` in the status bar |

![Fixture A entered: the breadcrumb reads Scene › Fixture A](/shots/context-breadcrumb.png)

![The Plate isolated: it is drawn alone at the origin with the isolate banner on top](/shots/isolate.png)

::: warning Adding inside a linked group
Because a tree click enters the clicked row's parent, adding a Cube right after you clicked a bolt in Fixture A puts the cube **inside `Fixture`**, in both fixtures (`Added to 'Fixture' — 2 copies updated`). Press **Esc** until the breadcrumb shows only `Scene`, or click `Scene` in it, to add at the top level.
:::

Exiting isolate brings the camera back to where it was before.

## Ghosting

**Ghost** (**G**, on by default) makes everything that is not part of your current focus translucent, so you can see the selection in place and still click through to anything else. Ghosts stay pickable.

| Situation | Ghost on | Ghost off |
|---|---|---|
| An occurrence is selected | Everything outside its subtree is translucent. Other occurrences of its definition are a purple translucent ghost. | Everything stays solid. Other occurrences of its definition get a purple tint. |
| Inside a group, nothing selected | Everything outside the group is translucent | Everything stays solid |
| Nothing selected, top level | Everything solid | Everything solid |

The selected occurrence is always solid with a blue tint and a light-blue outline.

![Ghost toggled off: a selected bolt, with the other bolts tinted purple and everything else solid](/shots/ghost-off.png)

## Colours

Colours are a display setting. Changing one never re-evaluates any code. A colour can be set in three places: on an **instance** (inspector, Instance section), on a **definition** (inspector, Definition section), or **in code** with `colorize()`.

A code object is drawn in the first colour that applies:

1. the **outermost instance colour** on its path (a colour on Fixture A wins over a colour on a bolt inside it);
2. the colour baked into the geometry by `colorize()`;
3. the definition colour;
4. the default grey `#9aa4b2`.

A boolean result is drawn in:

1. the outermost instance colour on its path;
2. the group definition's colour;
3. the first visible operand's colour (its instance colour, otherwise its definition colour);
4. the default grey.

A new object from the toolbar's Cube, Sphere, Cyl, Torus or Code button gets the next colour of an eight-colour palette as its definition colour. A new group gets no colour.

::: tip
The note next to the inspector's instance colour (`own color`, `from definition` or `default`) describes that instance only. A colour set on an enclosing group still wins in the view.
:::

## Hidden

**H**, the eye icon in the tree and the inspector's **Hidden** box toggle the hidden flag of an **instance record**. A hidden instance and everything inside it:

- is not drawn and not evaluated,
- takes no part in its group's boolean,
- is left out of a group's geometry when code reads it with `part()`,
- is not exported to STL,
- is ignored when 3Dica works out where to place a new object.

Hidden rows stay in the tree, dimmed. The eye stays visible, crossed out in orange, on the row you hid. Because the flag is on the record, hiding a child of a linked group hides it in every copy. **Alt+H** or **Unhide all** in the tree header clears every hidden flag in the project.

## What you can undo

Every change to the project is **one undo step**, labelled after what it did (`Move Bolt`, `Wrap in Subtract`, `Rename Bolt → Screw`). Hover the undo button to see the label of the next step. The history keeps 200 steps.

| Undoable | Not undoable (view state) |
|---|---|
| Adding, duplicating, pasting, deleting, purging | Selection, context and isolate |
| Moving, rotating, scaling (gizmo or fields), Reset | Camera position |
| Wrapping, ungrouping, drag and drop in the tree | Ghost, gizmo mode, World/Local, Snap |
| Make unique | Expanded and collapsed tree rows |
| Renaming definitions and labels | Whether the code is paused |
| Colours, hidden flags, Unhide all | Copy (**Ctrl+C**) |
| Parameter overrides, parameter defaults, group op | |
| Code edits | |

Some edits merge into one step. Repeated edits of the same transform field merge within 0.5 s, and so does dragging a parameter slider. Dragging in a colour picker merges within 1 s, and code typed into the same editor merges within 2 s.

::: warning New, Sample and Open clear the history
Replacing the project clears both undo and redo. Save first (**Ctrl+S**) if you may want the old project back.
:::

While the code editor has the focus, **Ctrl+Z** is the editor's own text undo. Press **Esc** to leave the editor, and **Ctrl+Z** undoes whole project steps again.

## Related pages

- [Working with objects](/reference/objects): every command that changes the structure.
- [Transforms and the gizmo](/reference/transforms): placement, rotation order and world-preserving moves.
- [Parameters](/reference/parameters) and the [Code API](/reference/code-api): what goes inside a code definition.
