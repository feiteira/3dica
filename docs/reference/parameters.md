# Parameters

Parameters make a definition reusable. A definition declares its parameters once, with a **default** for each, and its
code reads them from `params`. Every instance of the definition can then **override** any parameter with its own
value, while the other copies keep the default.

```js
const { length, diameter } = params   // the Bolt's code reads its two parameters
```

Only Code definitions have parameters. Groups have none in v0.1: to make a parametric assembly, write it as a Code
object that builds its pieces with [`part()`](/reference/code-api#part).

An [OpenSCAD object](/guide/openscad) has parameters too, but they come from its code, Customizer style, instead of
this table. Everything below about overrides, linked copies and `part()` applies to them as well. The differences are
listed in [OpenSCAD objects](#openscad-objects) at the end of this page.

## Where you edit them

| What | Where | Affects |
|---|---|---|
| The parameter list and the defaults | **Parameter defaults** in the inspector's Definition section. Click the definition's row in the Library to see it open. For a selected instance it is folded, in the Definition section below the instance's own fields. | Every instance that does not override the parameter |
| An override | **Parameters** (this instance) in the inspector, with an object selected in the 3D view or the Scene tree | That instance only, and every linked copy of the group it sits in (see below) |

![The parameter table of the Bolt definition](/shots/inspector-definition.png)

The parameter table has one row per parameter: **name**, **type**, **default** and a ✕ that removes it. Number
parameters have a second row, **range**, with min, max and step. Choice parameters have an **options** row instead.
**Add parameter** appends a number parameter named `param` (then `param2`, `param3`…) with default 0.

A field commits when you press <kbd>Enter</kbd> or leave it. <kbd>Esc</kbd> puts back the value it had before you started
typing. A change to the table that is not valid is not committed: the problem appears under the table, and your input
stays in place so you can fix it.

## Types

| Type | Default must be | Instance control | Your code gets |
|---|---|---|---|
| `number` | a finite number | a number field, plus a slider when both min and max are set | a number |
| `boolean` | true or false | a checkbox | `true` or `false` |
| `choice` | one of the options | a drop-down list | the chosen option, as a string |

A choice needs at least one option. Type the options as a comma-separated list (`lip, flat, none`). Spaces around the
commas are trimmed and empty entries dropped. If the default is no longer among the options, the first option becomes
the default.

Changing a parameter's **type** converts it:

| New type | Result |
|---|---|
| number | The default is the old default as a number (`true` becomes 1), or 0 if it is not a number. |
| boolean | The default is `false`. |
| choice | The options are the old options if it had any, otherwise the old default if it was text, otherwise `a, b`. The default is the old one if it is among them, otherwise the first option. |

## min, max and step are hints

min, max and step shape the controls and nothing else:

- with both min and max set, the instance control gets a slider over that range;
- step sets the slider's step and the arrow-key step of the number field.

They are **not enforced**. You can type any value into the number field, and the code receives it as it is: a Bolt
`length` of 200 is accepted although its max is 80. They are not part of the cache key either, so changing them never
re-runs any code. If a value really is invalid for your shape, check it in code and throw a readable error:

```js
if (params.length < 4) throw new Error('length must be at least 4 mm')
```

## Defaults and overrides

![An instance with an overridden length: ● marks it, ↺ resets it](/shots/inspector-instance.png)

- The value your code receives is the instance's **override** if it has one, otherwise the definition's **default**.
- Editing an instance's control sets an override. The parameter name gets a **●**, and a **↺** button appears on the
  right. Its tooltip names the default, as in *Reset to the default (12)*. Click it to remove the override.
- Entering the value a parameter already has does nothing, so an inherited default stays inherited. To pin an
  override to the default value anyway, set it to something else first and then back.
- Changing a **default** in the parameter table updates every instance that does not override that parameter. Instances
  with an override keep their value.
- Each change is one undo step. Changes to the same parameter of the same instance within half a second merge into one
  step, so dragging a slider undoes in one go.
- Pressing <kbd>Enter</kbd> in a field also hands the keyboard back to the app, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> then
  undoes the edit you just made.

## Stale overrides

Overrides are stored on the instance by parameter **name**. When you rename or remove a parameter, the instances that
overrode it keep the old entry. It is ignored, and the inspector lists it as `stale override 'length'` with a ✕ that
deletes it.

::: warning Renaming a parameter does not change the code
The parameter table and the code are separate. If you rename `length` to `len` in the table, the code still reads
`params.length`, which is now `undefined`. Rename it in the code too. A missing parameter usually shows up as `NaN`
inside JSCAD, which fails with an unhelpful message such as
`TypeError: Cannot read properties of null (reading 'edges')`.
:::

An override that no longer fits its parameter, for example after you change the parameter's type, is ignored as well:
the instance gets the default, although the ● still shows. Click ↺ to remove it.

## Valid names

A parameter name must be a JavaScript identifier, unique within its definition:

- letters, digits, `_` and `$`, not starting with a digit (`width`, `hole_d`, `n2`);
- not a reserved word: `break`, `case`, `catch`, `class`, `const`, `continue`, `debugger`, `default`, `delete`, `do`,
  `else`, `enum`, `export`, `extends`, `false`, `finally`, `for`, `function`, `if`, `import`, `in`, `instanceof`, `new`,
  `null`, `return`, `super`, `switch`, `this`, `throw`, `true`, `try`, `typeof`, `var`, `void`, `while`, `with`,
  `yield`, `let`, `static`, `implements`, `interface`, `package`, `private`, `protected`, `public`, `await`,
  `arguments`, `eval`, `undefined`, `NaN`, `Infinity` and `__proto__`.

The table refuses anything else and says why:

| Message | Cause |
|---|---|
| `parameter 'my size': name must be a valid identifier` | A space, a dash, a leading digit or a reserved word |
| `parameter 'width': duplicate name` | Two rows with the same name |
| `parameter 'width': default must be a number` | An empty or non-numeric default |
| `parameter 'style': a choice needs at least one option` | An empty options list |

::: tip Destructuring and built-in names
`params.center` always works. `const { center } = params` does not, because `center` is a JSCAD function that is
already in scope, and the code fails with `Identifier 'center' has already been declared`. If you like to destructure,
avoid parameter names that are also JSCAD names (`center`, `scale`, `offset`, `align`, `line`…), and avoid `params`,
`part`, `jscad` and `Math`. See [Code API](/reference/code-api).
:::

## Parameters and linked copies

Defaults belong to the **definition**, so every linked copy shares them. That is the point of linking: change the
Bolt's default diameter once and every bolt in the scene follows.

Overrides belong to an **instance record**, and a record can be drawn more than once. In the sample, Fixture A and
Fixture B are two instances of the same Fixture group, and the four bolts inside it are records of the Fixture
definition. Overriding the length of a bolt inside Fixture A therefore changes the same bolt in Fixture B too, and the
toast says so: *Changed 'Fixture' — 2 copies updated*. To give one fixture different bolts, select the fixture and
**Make unique** (<kbd>U</kbd>) first. The tutorial [Linked copies](/tutorials/linked-copies) walks through exactly
this.

| Action | What happens to the overrides |
|---|---|
| Linked copy (<kbd>Ctrl</kbd>+<kbd>D</kbd>), paste (<kbd>Ctrl</kbd>+<kbd>V</kbd>) | The new instance starts with the same overrides. |
| Unique copy (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>), Make unique (<kbd>U</kbd>) | The instance keeps its overrides; its new definition starts with the same parameters and defaults. |
| Isolate (<kbd>I</kbd>) on an instance | The isolated view uses that instance's values. The banner lists them: *Isolated: Bolt (length 16, diameter 5) — I or Esc to return*. |
| A click on the definition in the Library | The isolated view shows the definition with its defaults. |

Copies that end up with the same values share one evaluation and one mesh, whichever way they got there.

## Parameters and part()

Code that uses another definition passes overrides to it as an object:

```js
part('Bolt', { length: 20 })   // Bolt with length 20 and its default diameter
```

- The overrides are merged over the target's defaults. Parameters you leave out keep their defaults.
- They are checked **strictly**, unlike instance overrides: an unknown name or a value of the wrong type is an error,
  for example `part("Bolt"): unknown parameter "len" — "Bolt" has parameters length, diameter`.
- The calling object's own parameters are not passed on automatically. Forward what you need:
  `part('Bracket', { width: params.width })`.
- Groups have no parameters, so `part('Fixture', { … })` with any override fails with
  `part("Fixture"): groups have no parameters`.
- Each distinct set of values is evaluated once and then served from the cache.

## OpenSCAD objects

An OpenSCAD object's parameters are its top-level assignments of a number, `true` / `false`, or a string with a list
of options, and Customizer comments such as `// [10:100]` set their range, step or options. The full mapping is in
[Parameters](/guide/openscad#parameters) of the OpenSCAD guide. What changes compared with a JavaScript object:

| | JavaScript object | OpenSCAD object |
|---|---|---|
| Where the list is defined | The **Parameter defaults** table | The code. The table is read-only, except the defaults. |
| Add, remove, rename, change a range or options | In the table | In the code, then the table follows |
| Change a default | In the table | In the table, which rewrites the value in the code (`Change length`), or in the code |
| Description and headings | None | The `//` comment above an assignment, and `/* [Tab] */` comments |
| What the code gets for a choice | The option text | The drop-down item's value: `screw = 4; // [3:M3, 4:M4]` gets 4 for `M4` |
| How an override reaches the code | `params.length` | It replaces the assigned value, like `openscad -D length=80` |

Instance overrides, the ● and ↺ controls, stale overrides and `part()` overrides work the same way. In a `part()`
call, a choice takes its option text in both languages: `part('bracket', { screw: 'M5' })` or
`part("bracket", screw = "M5")`. A choice of an OpenSCAD object also takes the drop-down item's value, wherever an
override is typed (`part()`, the AI chat, MCP): `part("bracket", screw = 5)`. A value that is neither is refused with
the list, as in `Invalid value for 'screw': it must be one of "M3", "M4", "M5"`.

## In the project file

The definition stores its parameter list, and an instance stores only the values it overrides:

```json
{
  "id": "d_bolt", "name": "Bolt", "kind": "code",
  "params": [
    { "name": "length", "type": "number", "default": 12, "min": 4, "max": 80, "step": 1 },
    { "name": "diameter", "type": "number", "default": 5, "min": 2, "max": 20, "step": 0.5 }
  ],
  "code": "const { length, diameter } = params\n…"
}
```

```json
{ "id": "i_b1", "def": "d_bolt", "xf": { "t": [-23, -13, 5], "r": [0, 0, 0], "s": [1, 1, 1] }, "params": { "length": 16 } }
```

A choice parameter also has `"options": ["lip", "flat", "none"]`. An OpenSCAD definition stores its parameter list
too, but it is read again from the code when the file is opened. See [Files, autosave and STL](/reference/files) for
the whole format.
