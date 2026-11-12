# Keyboard shortcuts

These are all the keys 3Dica handles. On macOS, <kbd>Cmd</kbd> works wherever <kbd>Ctrl</kbd> is listed, except for suspending snap during a gizmo drag, which needs <kbd>Ctrl</kbd> itself.

## Where shortcuts work

The app's shortcuts are active while the keyboard is **not** in a text field, a number field, a drop-down list or the code editor. Three keys also work inside the inspector's fields and the code editor:

| Key | Inside a field or the code editor |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Run code (see below) |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the project |
| <kbd>Esc</kbd> | Leave the field, so the other shortcuts work again |

The inline rename box in the tree and the Library is the exception: it keeps every key for itself. Inside a field, any other key belongs to the field. For example, <kbd>Ctrl</kbd>+<kbd>Z</kbd> is the field's or the editor's own text undo, and <kbd>Ctrl</kbd>+<kbd>D</kbd> in the editor selects the next match. Press <kbd>Esc</kbd> first, then use the app shortcut. After you press <kbd>Enter</kbd> in an inspector field, the keyboard returns to the app on its own.

Shortcuts are also off while a dialog is open, and <kbd>Enter</kbd> or <kbd>Space</kbd> on a focused button presses that button. Toolbar buttons give the focus back after a click, so this rarely gets in the way.

## App shortcuts

### Selection and navigation

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Enter the selected group: it becomes the context, and nothing is selected. |
| <kbd>Esc</kbd> | Step back, in this order: leave isolate, otherwise step out of the entered group (selecting it), otherwise clear the selection. |
| <kbd>I</kbd> | Toggle isolate. With nothing selected, the toast says `Select something to isolate`. |
| <kbd>G</kbd> | Toggle ghosting of everything outside the selection. |
| <kbd>F</kbd> | Frame the selection: all occurrences of a selected definition, the isolated object while isolated, or everything when nothing is selected. |
| <kbd>Home</kbd> | Frame everything. |
| <kbd>1</kbd> | Front view (looking along +Y). |
| <kbd>3</kbd> | Right view (looking along −X). |
| <kbd>7</kbd> | Top view (looking down). |

<kbd>1</kbd>, <kbd>3</kbd> and <kbd>7</kbd> work on the digit row and on the numpad, with or without Num Lock. The views keep the current target and distance.

### Editing

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate the selected object as a linked copy. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> | Duplicate as a unique copy (clones the definition). |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy the selected object. Without a selected object, the browser's own copy runs. |
| <kbd>Ctrl</kbd>+<kbd>V</kbd> | Paste a linked copy into the current group. Does nothing until you have copied an object. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | Paste a unique copy. |
| <kbd>U</kbd> | Make the selected instance unique. |
| <kbd>Ctrl</kbd>+<kbd>G</kbd> | Wrap the selected object in a new plain group. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Ungroup the selected group. |
| <kbd>Del</kbd>, <kbd>Backspace</kbd> | Delete the selected occurrence, or the selected Library definition (with a confirmation when it has instances). |
| <kbd>F2</kbd> | Rename what is selected: the label if the instance has one, otherwise the definition. |
| <kbd>H</kbd> | Hide or show the selected instance. |
| <kbd>Alt</kbd>+<kbd>H</kbd> | Unhide everything. |

[Working with objects](/reference/objects) describes each command in full.

### Gizmo

| Key | Action |
|---|---|
| <kbd>W</kbd> | Move mode. |
| <kbd>E</kbd> | Rotate mode. |
| <kbd>R</kbd> | Scale mode. |
| <kbd>Q</kbd> | Toggle World / Local axes. |
| <kbd>X</kbd> | Toggle snapping (1 mm, 15°, 0.1). |
| Hold <kbd>Ctrl</kbd> while dragging | Suspend snapping for this drag. |

### History, files and code

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>, <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Redo. |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the project as `<name>.3dica.json`. Also works in fields and the editor. |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open a `.3dica.json` file. |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Run code: apply the code you are typing now, run a paused project, and retry what failed (for the selected object's definition, or everything when nothing is selected). Also works in fields and the editor. |

Letter shortcuts ignore the key when <kbd>Shift</kbd> is held, and the app ignores <kbd>Alt</kbd> combinations other than <kbd>Alt</kbd>+<kbd>H</kbd>. Other <kbd>Ctrl</kbd> combinations are left to the browser.

## Keys in fields and dialogs

### Inline rename (tree and Library)

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Apply the name. If it is refused, the input stays open and shows why. |
| <kbd>Esc</kbd> | Cancel. |
| Click elsewhere | Apply the name. If it is refused, the old name stays and an error toast says why. |

### Inspector fields

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Apply the value and give the keyboard back to the app. A refused definition name keeps the field open. |
| <kbd>Esc</kbd> | Put the previous value back and leave the field. |
| <kbd>Tab</kbd> | Apply and move to the next field. |
| <kbd>↑</kbd> <kbd>↓</kbd> in a number field | Step the value and apply it (1 mm, 15° or 0.1 for transforms, the parameter's step for parameters). Steps less than 0.5 s apart are one undo step. |

### Code editor

3Dica adds three keys to CodeMirror's own:

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Apply the code now and retry this definition if it failed. Otherwise edits apply 0.4 s after you stop typing. |
| <kbd>Esc</kbd> | Leave the editor. If the completion list or the search panel is open, <kbd>Esc</kbd> closes that first. |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the project. |

The most useful CodeMirror keys:

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Z</kbd>, <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Undo and redo typing. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> also redoes on Linux, and <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> on macOS. This history starts fresh each time you select another definition. |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Find and replace. <kbd>F3</kbd> or <kbd>Ctrl</kbd>+<kbd>G</kbd> finds the next match, with <kbd>Shift</kbd> the previous one. |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> | Go to line. |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Select the next occurrence of the selection. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | Select all occurrences of the selection. |
| <kbd>Ctrl</kbd>+<kbd>/</kbd> | Comment or uncomment the line. |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> | Block comment. |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd> | Move the line up or down. |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> | Copy the line up or down. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> | Delete the line. |
| <kbd>Ctrl</kbd>+<kbd>]</kbd> / <kbd>Ctrl</kbd>+<kbd>[</kbd> | Indent or outdent. |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd> | Show completions. |
| <kbd>F8</kbd> | Jump to the error. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> | Open the list of errors. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> / <kbd>]</kbd> | Fold or unfold the block. |

<kbd>Tab</kbd> does not indent in the editor: it moves the keyboard to the next control. Use <kbd>Ctrl</kbd>+<kbd>]</kbd> to indent.

On macOS, CodeMirror uses its own Mac keys for a few of these: <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>[</kbd> / <kbd>]</kbd> folds and unfolds, and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> toggles a block comment.

### Dialogs

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Press the focused button: the confirming button, except in **Delete definition**, where **Cancel** has the focus. |
| <kbd>Esc</kbd> | Choose the left button: **Cancel**, or **Open without running** when you open a file that contains code. |
| <kbd>Tab</kbd> | Move between the buttons. |

## Mouse

| Where | Action | Result |
|---|---|---|
| View | Left-drag | Orbit |
| View | Right-drag | Pan |
| View | Wheel, middle-drag | Zoom |
| View | Click | Select the outermost object at the current level, or clear the selection on empty space |
| View | <kbd>Ctrl</kbd>+click | Select the deepest part |
| View | Double-click | Enter a group |
| View | Drag a gizmo handle | Move, rotate or scale. Hold <kbd>Ctrl</kbd> to suspend snapping. |
| Tree | Click a row, ▸, or the eye | Select, expand or collapse, hide or show |
| Tree | Double-click a name | Rename |
| Tree | Double-click elsewhere on a group row | Expand or collapse |
| Tree | Drag a row | Move it. Hold <kbd>Ctrl</kbd> when you drop to make a linked copy. |
| Library | Click, double-click, drag | Select and isolate, rename, add to the tree |
| Breadcrumb | Click a segment | Select or enter that level |
| Anywhere | Drop a `.3dica.json` file | Open it |
