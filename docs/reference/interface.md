# Interface

3Dica has one window with five areas. This page describes every panel and control, in the order you meet them.

![The 3Dica window with the sample project loaded, nothing selected and the Inspector tab open](/shots/overview.png)

```text
┌ Toolbar ─────────────────────────────────────────────────────────────────────────┐
├ Scene tree ─────┬ 3D view ─────────────────────────────────┬ [Inspector] [Chat] ──┤
│                 │ breadcrumb                               │ Inspector:           │
│                 │          isolate banner / paused banner  │ instance, transform, │
├ Library ────────┤                                          │ colour, parameters,  │
│                 │                                          │ definition           │
│                 │ hint                             toasts  ├ Code editor ─────────┤
├ Status bar ─────┴──────────────────────────────────────────┴──────────────────────┤
```

The right column has two tabs: the **Inspector** with the code editor, and the [Chat](#chat).

The layout needs a window at least 1100 px wide. Below 1700 px **Snap**, **Ghost**, **Isolate**, **Frame**, **New**, **Sample** and **STL** show only their icons (**Open**, **Import** and **Save** keep their names), and below 1440 px most other toolbar buttons do too. Below 1560 px the **Manual** link is only its book icon, and below 1500 px the 3Dica name at the left is hidden. While **Run code** is shown, the file buttons (**New** to **STL**) show only their icons as well. Hover any button for its name and shortcut.

## Toolbar

![The toolbar](/shots/toolbar.png)

| Button | What it does | Key |
|---|---|---|
| **Cube**, **Sphere**, **Cyl**, **Torus** | Add a new primitive to the current group (see [Create](/reference/objects#create)). | |
| **Code** | Add a new code object named `Object`: a rounded cube under a comment header, ready for your own code. | |
| **OpenSCAD** | Add a new [OpenSCAD object](/guide/openscad) named `Object`: a cube with a `size` parameter, written in OpenSCAD instead of JavaScript. | |
| **Group** | Add a new, empty group. | |
| ∪ | Wrap the selected object in a new **Union** group. | |
| − | Wrap the selected object in a new **Subtract** group (the first child minus the others). | |
| ∩ | Wrap the selected object in a new **Intersect** group. | |
| Move | Gizmo in move mode. | <kbd>W</kbd> |
| Rotate | Gizmo in rotate mode. | <kbd>E</kbd> |
| Scale | Gizmo in scale mode. | <kbd>R</kbd> |
| **World** / **Local** | Gizmo axes aligned with the world, or with the object. The label shows the current choice. | <kbd>Q</kbd> |
| **Snap** | Snap gizmo drags to 1 mm, 15° and 0.1. | <kbd>X</kbd> |
| **Ghost** | Make everything outside the selection translucent. | <kbd>G</kbd> |
| **Isolate** | Show the selected definition alone at the origin. | <kbd>I</kbd> |
| **Frame** | Frame the selection, or everything when nothing is selected. | <kbd>F</kbd> (<kbd>Home</kbd> frames everything) |
| Undo | Undo the last step. The tooltip names it, for example `Undo Move Bolt`. | <kbd>Ctrl</kbd>+<kbd>Z</kbd> |
| Redo | Redo. | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>, <kbd>Ctrl</kbd>+<kbd>Y</kbd> |
| **New** | Replace the project with an empty one, after a confirmation. | |
| **Sample** | Replace the project with the sample *Bracket kit*, after a confirmation. | |
| **Open** | Open a `.3dica.json` file. You can also drop one anywhere on the window. | <kbd>Ctrl</kbd>+<kbd>O</kbd> |
| **Import** | Add `.scad` files to the project as [OpenSCAD objects](/guide/openscad#what-import-does), in the current group. Choose several at once: a file that another one uses or includes is attached to it instead of becoming an object. You can also drop `.scad` files on the window. | |
| **Save** | Download the project as `<name>.3dica.json`. | <kbd>Ctrl</kbd>+<kbd>S</kbd> |
| **STL** | Export the selection, or the whole scene, as binary STL. | |
| **Run code** | Shown only while the project's code is paused, for example after **Open without running**. Runs it. | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> |
| **Manual** (book icon) | Open this manual in a new tab. | |

The wrap buttons are disabled until an object is selected. **Ctrl+G** wraps in a plain group and has no button. Pressed toggles (the current gizmo mode, Snap, Ghost, Isolate, Local) are highlighted. Undo and Redo are disabled when there is nothing to undo or redo. See [Files, autosave and STL](/reference/files) for New, Open, Save and STL in detail.

## Scene tree

The top of the left column lists every **occurrence** in the scene. The header shows the project name and an **Unhide all** button (<kbd>Alt</kbd>+<kbd>H</kbd>), which is disabled while nothing is hidden. An empty scene says *The scene is empty. Add an object from the toolbar, or drag a definition in from the Library.*

![The Scene tree and the Library, with Fixture A expanded and a bolt selected](/shots/tree-library.png)

### A row

From left to right:

| Part | Meaning |
|---|---|
| ▸ / ▾ | Expand or collapse a group that has children. |
| Kind icon | `</>` for a code object, a hexagon with an S for an OpenSCAD object, a frame for a plain group, ∪ − ∩ for a boolean group. The icon of a subtract cutter is red. |
| Name | The instance label if it has one, otherwise the definition name. A labelled row also shows the definition name in grey: `Fixture A  Fixture`. |
| `◆N` | The definition occurs N times in the scene, and all those copies are linked. Shown only when N is more than 1. |
| Status dot | Evaluation state, see below. |
| Eye | Hide or show this instance (<kbd>H</kbd>). It appears when you hover the row, and stays visible, crossed out in orange, on a row you have hidden. |

| Dot | Tooltip | Meaning |
|---|---|---|
| Grey | `Not evaluated` | Nothing to evaluate here in the current view: the row is hidden, it is an operand of a boolean that is not on show, or the code is paused. |
| Amber, blinking | `Evaluating…` | Queued or running. |
| Green | `Up to date` | The result is ready. |
| Red | `Error: <message>` | The evaluation failed. Hover the dot for the message. A group row says `Something inside has an error`. |

A plain group row shows the worst state of everything inside it, so a red dot on Fixture A tells you to look inside.

| Row look | Meaning |
|---|---|
| Blue background | Selected. |
| Purple background | Another occurrence of the selected definition (linked). |
| Blue bar on the left edge | The group you are inside (the context). |
| Dimmed | Hidden, or inside a hidden group. |
| Blue highlight while dragging | Dropping here puts the object inside this group. |
| Red line or red highlight while dragging | You can't drop there. |

### Mouse

| Action | Result |
|---|---|
| Click a row | Select that occurrence. Its parent group becomes the context. The view frames it if it is off screen or tiny. |
| Click ▸ / ▾ | Expand or collapse. |
| Click the eye | Hide or show. |
| Double-click the name | Rename (see [Rename](/reference/objects#rename)). |
| Double-click elsewhere on a group row | Expand or collapse. |
| Drag a row | Move it to another place in the tree. Hold <kbd>Ctrl</kbd> when you drop to place a linked copy instead (see [Drag and drop](/reference/objects#drag-and-drop)). |

Selecting something in the view expands the tree down to it and scrolls it into sight.

## Library

The bottom of the left column lists every **definition**, sorted by name. The header shows how many there are and a **Purge** button that removes the unused ones (disabled while there are none).

| Part | Meaning |
|---|---|
| Kind icon | As in the tree. |
| Name | The definition name. |
| `×N` | Number of occurrences in the scene. |
| `unused` (greyed) | No instances, and no code calls it with `part()`. **Purge** removes it. |
| `part()` | No instances, but code calls it with `part()`, so it is kept. |
| Status dot | As in the tree. A plain group is never evaluated as a whole, so its dot stays grey. |

The selected definition has a blue background. When an occurrence is selected, the row of its definition gets a purple bar on the left.

| Action | Result |
|---|---|
| Click a row | Select the definition and isolate it (see [Context and isolate](/concepts/model#context-and-isolate)). |
| Double-click a row, or <kbd>F2</kbd> | Rename the definition. |
| Drag a row into the tree | Add an instance of it there. |
| <kbd>Del</kbd> | Delete the definition (see [Delete](/reference/objects#delete)). |

## 3D view

The view is Z-up, like OpenSCAD, and every unit is a millimetre. A 200 mm grid with 10 mm cells lies on the XY plane, with a short red X line and a green Y line from the origin.

| Mouse | Action |
|---|---|
| Left-drag | Orbit |
| Right-drag | Pan |
| Wheel, or middle-drag | Zoom |
| Click | Select (see [Select](/reference/objects#select)) |
| <kbd>Ctrl</kbd>+click | Select the deepest part under the pointer |
| Double-click | Enter a group |

<kbd>1</kbd>, <kbd>3</kbd> and <kbd>7</kbd> (digit row or numpad) switch to the front, right and top views. The camera position is remembered with the autosave. Without one, the view frames everything once the first evaluation is done.

### Overlays

| Overlay | Where | What it shows |
|---|---|---|
| **Breadcrumb** | Top left | The path to the selection, for example `Scene › Fixture A ◆2 › Bolt ◆8`. Hidden while isolated. |
| **Isolate banner** | Top centre | `Isolated: Bolt (length 12, diameter 5) — I or Esc to return`, with a × button that returns to the scene. |
| **Paused banner** | Top centre | `This project's code has not run. Run it only if you trust the file.` with a **Run code** button. |
| **Hint** | Bottom left | A one-line reminder of the mouse and keys for the current mode. Hidden while the code is paused. |
| **Toasts** | Bottom right of the view | Short messages, see [Toasts](#toasts). |

Clicking a breadcrumb segment:

| Segment | Result |
|---|---|
| `Scene` | Leave every group and clear the selection. |
| A group in the middle | Enter that group and select the next segment. **Esc** then selects the group itself. |
| The last segment | Select it, and enter the group that holds it. |

![Inside Fixture A: the breadcrumb at the top left](/shots/context-breadcrumb.png)

## Right column tabs

The tab bar at the top of the right column switches between **Inspector** and **Chat**. <kbd>Ctrl</kbd>+<kbd>L</kbd>
switches to the Chat and puts the cursor in its message box, and pressed again goes back to the Inspector, with the
cursor where it was before. It works everywhere, in the code editor too. With the keyboard on a tab, the arrow keys, <kbd>Home</kbd> and <kbd>End</kbd> move
between the tabs. The browser remembers the tab you had open, and selecting an object never switches tabs.

A dot on the Chat tab shows what the assistant is doing, so you can follow it from the Inspector too:

| Dot | Meaning |
|---|---|
| Blue, blinking | The assistant is working. |
| Amber | It is waiting for you to approve an action (see [Chat](#chat)). |

## Inspector

The Inspector tab shows what is selected. Edit a field and press <kbd>Enter</kbd>, or leave the field, to apply the change. <kbd>Esc</kbd> puts the previous value back. After <kbd>Enter</kbd> the keyboard goes back to the app, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the edit you just made.

### Nothing selected

The project name, `Nothing selected`, the number of definitions and objects, a short help text and a list of the most useful shortcuts.

### Header

| Line | Occurrence selected | Library definition selected |
|---|---|---|
| Kind | `CODE OBJECT`, `OPENSCAD OBJECT` (with an **OpenSCAD** badge), `GROUP` or `BOOLEAN SUBTRACT` (union, intersect) | The same, followed by `· DEFINITION` |
| Title | The label, or the definition name | The definition name |
| Below | `instance of Bolt ◆8`. Click the definition name to select the definition, as from the Library. | `definition · 8 occurrences in the scene ◆8`, or `definition · not used in the scene` |

### Instance section

Shown when an occurrence is selected.

![The inspector for a bolt of Fixture A, with its length overridden to 16](/shots/inspector-instance.png)

| Control | What it does |
|---|---|
| **Label** | A name for this instance only. Empty means no label, and the tree shows the definition name (shown as the placeholder). |
| **Make unique** | Give this instance its own copy of the definition (<kbd>U</kbd>). Disabled when the definition has a single instance record. The tooltip then says what to do instead. |
| **Hidden** | Hide or show this instance (<kbd>H</kbd>). |
| **Transform** | Position (mm), Rotation (°) and Scale (×), each for X, Y and Z, plus **Reset** (position 0, rotation 0, scale 1). See [Transforms](/reference/transforms#numeric-fields). |
| **Color** | A colour picker, **clear** to go back to the definition colour, and a note: `own color`, `from definition` or `default`. |
| **Parameters** · *this instance* | Code and OpenSCAD objects. One control per parameter, showing the value this instance uses. For an OpenSCAD object, the Customizer tabs are headings and the descriptions are tooltips. |

Parameter controls:

| Parameter type | Control |
|---|---|
| number | A number field, plus a slider when the parameter has both a min and a max |
| boolean | A checkbox |
| choice | A drop-down list |

When you change a value, it becomes an **override** for this instance. The parameter name then shows a **●**, and a **↺** button appears that removes the override. Its tooltip shows the default, for example `Reset to the default (12)`. If the instance overrides a parameter the definition no longer has, the list shows `stale override 'len' ✕`. Click ✕ to remove it. A code object without parameters says `This object has no parameters.` See [Parameters](/reference/parameters).

### Shared-definition banner

When the definition occurs more than once, a purple banner reads `Definition shared by 8 copies — edits affect all`. For an occurrence it carries a second **Make unique** button. Everything below the banner edits the definition, and so every copy.

### Definition section

![The inspector for the Bolt definition, selected from the Library, with its parameter table](/shots/inspector-definition.png)

| Control | What it does |
|---|---|
| **Name** | Rename the definition. A refused name shows the reason under the field and nothing changes. |
| **Color** | The definition colour, and **clear** to remove it. |
| **Operation** | Groups only: `none — plain assembly`, `union (∪)`, `subtract (−) — child 0 minus the rest` or `intersect (∩)`. Below it, a summary such as `2 children · the first visible child is the base, the others cut`, and the group's evaluation status. A plain group says `Assembly — its children are evaluated one by one`. |
| **Parameter defaults** | Code objects only: the parameter table. One row per parameter, with name, type (`number`, `boolean`, `choice`), default and a ✕ to remove it. A number has a range row (min, max, step). A choice has an options field (comma-separated). **Add parameter** adds a number named `param`. A problem is shown under the table, and the change is not applied. |
| **Parameter defaults** (OpenSCAD) | For an OpenSCAD object the table is read from the code: one row per parameter with its type, default, description and range, under its Customizer heading. Only the default can be changed, and the new value is written into the code. A note says so. See [Parameters](/guide/openscad#parameters). |
| **Files** | OpenSCAD objects only: the files the code uses or includes, attached or `missing`, with Replace, Download and Remove buttons (or **Attach…** for a missing one), then **Attach files…** and **Export .scad**. The title counts them: `1 file · 1 missing`. See [Attached files](/guide/openscad#attached-files). |
| Usage line | For example `4 instance records · 8 in the scene · used by code in 'Bolt sizes'`. |
| **Delete definition…** | Library selection only: delete the definition and all its instances (<kbd>Del</kbd>). |

The parameter table is open when you select a definition from the Library, and folded when you select an occurrence. Click its title to open or fold it. 3Dica remembers your choice for each case until you reload.

### Code editor

Code objects get a CodeMirror editor under the inspector. Its header shows `CODE` (or `OPENSCAD` for an OpenSCAD object) and the definition name, a `Ctrl+Enter` hint and a **Run** button. An OpenSCAD object's code is highlighted and completed as OpenSCAD.

![The code editor showing the Plate's code](/shots/code-editor.png)

- Your edit is applied 0.4 s after you stop typing, and the object re-evaluates.
- **Run**, or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in the editor, applies the edit at once and retries this object if it failed, for example after a timeout.
- Long lines wrap. Groups have no editor.
- An error marks its line in the gutter and underlines it. Hover the marker for the message.
- An OpenSCAD object has an **Output** panel under the status line, like OpenSCAD's console: its `ECHO`, `WARNING`, `ERROR` and `TRACE` lines, each with a `line N` link that puts the cursor on that line. See [The Output panel](/guide/openscad#the-output-panel).

The **status line** under the editor shows the state of the selected object:

| Status line | Meaning |
|---|---|
| `✓ 18 ms · 4,382 triangles` | Evaluated, in that time, with that many triangles. Warnings follow as `· ⚠ Returned nothing`. An OpenSCAD object with more than one warning shows `· ⚠ 3 warnings — see Output`. |
| `✕ boom (line 2:7)` | This code failed, at line 2, column 7. |
| `✕ depends on "Bolt" (failed): …` | Code it calls with `part()` failed. The rest of the line is Bolt's own message, and the line number counts in Bolt's code. Fix that definition. |
| `Evaluating…` | Queued or running. |
| `Code is paused — click Run code to evaluate this project` | The project was opened without running its code. |
| `Hidden — not evaluated` | The selected instance is hidden. |
| `Operand of a boolean — shown when the boolean is selected` | Select the boolean group to evaluate it. |
| `Not evaluated in this view` | Nothing in the current view needs it. |

![A failing Bolt: the error marker in the gutter and the message in the status line](/shots/code-error.png)

The [Code API](/reference/code-api) lists what you can call in the code, and [Troubleshooting](/help/troubleshooting) explains the error messages.

## Chat

The Chat tab is an AI assistant that works on the open project. [AI chat](/guide/ai-chat) explains how to set it up and what it can do. This is what you see in it.

![A conversation in the Chat tab: the provider button and context size at the top, the user's message, the assistant's reply, two tool cards with a screenshot thumbnail, and the message box at the bottom](/shots/chat-panel.png)

| Part | Where | What it does |
|---|---|---|
| Provider button | top left | Shows the provider and model, for example `Anthropic · claude-opus-5-5`, or `Set up a provider`. Click it for the chat settings. |
| Context | top right | How many tokens the model read in its last turn, for example `8.5k context`. Hover it for the output tokens of the whole chat. |
| **New chat** | top right | Clear the conversation and start a fresh one. Disabled while the chat is empty. |
| Empty state | middle | Before the first message: what the assistant can do, and four example prompts that fill the message box (or **Set up a provider** when none is set up). |
| Your messages | right-aligned | What you sent. |
| Replies | left | The assistant's text, with lists, code blocks (with a **Copy** button), tables and links. **Thinking** is the model's reasoning, folded, when the model sends it. A reply from another model than the one you chose (a provider's fallback) says *Answered by …*. |
| Tool cards | between replies | One per tool call: its name, a one-line summary and its state: a spinner, ✓, ✕, *declined* or *cancelled*. Click the card for the call's input and result. The target button selects the object it created or changed. Screenshots show a thumbnail that opens full size. |
| Approval card | in the conversation | Before **New project** or **Load sample**: what the assistant wants to do, with **Decline** and **Approve**. While it waits, its tool card says *waiting for you* and the line under the message box *Waiting for your approval above.* |
| Notices | in the conversation | Pauses, stops and errors, with **Continue**, **Retry**, **New chat** or **Open settings** where they help. **Retry** shows only when trying again can work. |
| Message box | bottom | Grows up to 8 lines. Disabled, with a **Set up** link, until a provider is set up. |
| Send / Stop | right of the message box | Sends the message. While the assistant works it becomes **Stop**. |

| Key in the message box | Action |
|---|---|
| <kbd>Enter</kbd>, <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Send |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | New line |
| <kbd>Esc</kbd> | Leave the message box |

The chat settings replace the conversation in the panel until you click **Save** or **Cancel** (or press <kbd>Esc</kbd>). Their fields are listed in [AI chat › Settings](/guide/ai-chat#settings).

## Status bar

![The status bar](/shots/status-bar.png)

| Field | Example | Meaning |
|---|---|---|
| Evaluator | `● Ready · last 54 ms (Bolt sizes)` | Green: idle, with the time of the last evaluation. Amber, blinking: `Evaluating 2` (jobs left), plus the running object and its time once it takes more than a second, or `Starting evaluator…`. Amber: `Paused — code not run`. Red: the evaluator stopped, for example `Evaluator keeps crashing — reload the page`. |
| Errors | `2 errors` | Results in the current view that failed. Hidden when there are none. |
| Where you are | `Inside Fixture A`, `Isolate` | The entered group, or isolate mode. Hidden at the top level. |
| Scene | `36 meshes · 69,052 tris` | Meshes drawn in the view right now, and their triangles. |
| Saved | `saved 15:03:40` | Time of the last autosave. See [Files, autosave and STL](/reference/files). |

When you turn on the bridge for a local AI assistant (a local copy opened with `?mcp`), a pill at the far right shows the connection: `MCP · connecting…`, `MCP · connected` or `MCP · superseded`. Click it for a menu with **Disconnect and disable** (and **Use this tab** when superseded). See [AI assistants (MCP)](/guide/mcp).

## Toasts

Toasts are short messages at the bottom right of the view. Information stays 3.5 s, a warning 5 s and an error 6.5 s. Click one to dismiss it. At most five are shown, and a message that is already shown is refreshed instead of repeated. Some you will see often:

| Toast | Meaning |
|---|---|
| `Changed 'Fixture' — 2 copies updated` | You edited something inside a linked group: every copy changed. |
| `Added to 'Fixture' — 2 copies updated` | You added or pasted into a linked group. |
| `'Bolt' → new definition 'Bolt 2'` | Make unique created a new definition. |
| `Copied 'Bolt sizes'` | Ctrl+C put the object in 3Dica's clipboard. |
| `Kept local transform` (warning) | A tree move could not keep the world position, see [World-preserving moves](/reference/transforms#world-preserving-moves). |
| `Select an object to duplicate`, `Select something to isolate`, … | The command needs a selection. |
| `Can't delete 'Bolt': used by code in 'Bolt sizes'` (error) | A refused edit. Error toasts always say why, and nothing changes. |
| `Removed 3 unused definitions`, `Nothing to purge` | The result of **Purge**. |
| `Opened '…' without running its code — click Run code when you trust it` (warning) | See [Files](/reference/files). |
| `3Dica is also open in another tab. …` (warning) | Two tabs share one autosave slot. Close one of them. |
| `'lid' needs 'lib/sizes.scad' — attach it in the Inspector` (warning) | An imported file uses or includes a file you did not choose. See [Import](/guide/openscad#what-import-does). |
| `Only .scad files can be imported — skipped 'part.stl'` (warning) | Import takes `.scad` files only. |
| `Exported bracket.scad` | **Export .scad** downloaded an OpenSCAD object's code. |

## Dialogs

Dialogs are modal. While one is open, the app's keyboard shortcuts are off. **Esc** chooses the left button (Cancel, or **Open without running**), and **Enter** presses the focused button.

| Dialog | Appears when | Buttons |
|---|---|---|
| **New project** | You click **New**. | **Cancel**, **New project** (focused) |
| **Load sample** | You click **Sample**. | **Cancel**, **Load sample** (focused) |
| **Open** *file name* | The file you open contains code: `This file contains code that runs on your computer. Run it?` | **Open without running**, **Run code** (focused) |
| **Delete definition** | You delete a definition that still has instances: `Delete 'Washer' and its 4 instances (8 copies in the scene)?` | **Cancel** (focused), **Delete** |
| **Can't open** *file name* | The file is not a valid project. It lists every problem and says `The current project was not changed.` | **OK** |

![The dialog shown when an opened file contains code](/shots/dialog-run-code.png)

![The confirmation shown before a definition and its instances are deleted](/shots/dialog-delete.png)
