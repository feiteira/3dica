# Tutorial 2: Linked copies

Copies in 3Dica are **linked**: they share one definition, so you edit once and every copy follows. In this tutorial
you add a third fixture to the sample, change every bolt at once, and then make one fixture different from the others.

**You need:** the sample project. Click **Sample** in the toolbar and confirm with **Load sample**, or open the app with
`?fresh` at the end of the address.

::: details What's in the sample
Two fixtures, **Fixture A** and **Fixture B**, are two instances of one **Fixture** definition: a Plate, four Washers
and four Bolts. **Bolt sizes** is a code object that builds five bolts with `part('Bolt', …)`. See
[the sample project](/guide/getting-started#the-sample-project-bracket-kit).
:::

## 1. Make a linked copy

Click the **Fixture A** row in the Scene tree, then press <kbd>Ctrl</kbd>+<kbd>D</kbd>.

**You should see** a new, selected row below Fixture A's children and above Fixture B. It's also labelled
**Fixture A**, because a copy keeps the label. It sits 65 mm along X from the original (the fixture's 60 mm width plus
5 mm), right on top of Fixture B.

Give the copy a label of its own and move it out of the way. In the inspector, with the copy still selected:

1. In **Label**, select the text, type **Fixture C** and press <kbd>Enter</kbd>.
2. In **Transform**, select the **Position Y** value, type **55** and press <kbd>Enter</kbd>.

Press <kbd>Home</kbd> to frame everything. The row now reads **Fixture C**, with **Fixture** next to it: the label
belongs to this instance, the name next to it is the definition. Moving it didn't break the link.

Look at the badges:

- Every fixture row now shows **◆3**, and the Library says **Fixture ×3**.
- The parts inside count up too: **Plate ×3**, **Washer ×12**, **Bolt ×12**.
- The inspector shows the banner *"Definition shared by 3 copies — edits affect all"*, and the other two fixtures are
  tinted purple in the view and in the tree.

![The third, linked fixture, labelled Fixture C and moved to Y 55: every fixture row shows ◆3](/shots/tut2-01-linked.png)

## 2. Edit the definition once

Click **Bolt** in the **Library**.

**You should see** the view switch to **isolate**: one bolt alone at the origin, under the banner
*"Isolated: Bolt (length 12, diameter 5) — I or Esc to return"*. The inspector shows the Bolt **definition**, with its
**Parameter defaults** table and its code. Under the table it says *"4 instance records · 12 in the scene · used by code
in 'Bolt sizes'"*: four instances inside the Fixture definition, times three fixtures.

In the **Parameter defaults** table, change the **default** of `diameter` from **5** to **4**: click the field,
select the 5, type 4 and press <kbd>Enter</kbd>.

**You should see** the isolated bolt get thinner, and the banner now says *diameter 4*. Press <kbd>Esc</kbd> to go back
to the scene: **every bolt is thinner**. That's all 12 in the three fixtures, and also the five in **Bolt sizes**,
because its code calls `part('Bolt', { length })` without a `diameter`, so it gets the default. The Bolt definition is
still selected, so its 12 occurrences are highlighted and the rest of the scene is faded.

![Back in the scene with the Bolt definition selected: every bolt, including the faded Bolt sizes rack, is now 4 mm thick](/shots/tut2-02-edit-definition.png)

::: tip Defaults versus overrides
You changed a **default**, so everything that uses the default follows. An instance that overrides `diameter` (●)
would keep its own value. The Plate's hole size didn't change: `holeDiameter` is a separate parameter of the Plate.
:::

## 3. Make one copy different

Click the **Fixture C** row in the Scene tree. Press <kbd>U</kbd> (**Make unique**). You can also use the
**Make unique** button in the inspector.

**You should see** the message *"'Fixture' → new definition 'Fixture 2'"*. The copy's row now says **Fixture C**
with **Fixture 2** next to it, without a badge. The other two fixtures show **◆2**, and the Library lists both
**Fixture ×2** and **Fixture 2 ×1**.

Now change a part inside it:

1. Expand the copy: click the **›** at the left of its row.
2. Click its **Plate** row.
3. In the inspector's **Parameters**, set `width` to **80** (select the value, type, <kbd>Enter</kbd>).

**You should see** only this fixture's plate widen to 80 mm. The other two plates stay 60 mm wide.

![Only the unique fixture's plate is 80 mm wide](/shots/tut2-03-make-unique.png)

### Why make it unique first?

An override is stored on an **instance record**, and the Plate's record lives inside a group definition. Before step 3,
that record belonged to **Fixture**, so all three fixtures shared it: setting `width` 80 there would have widened all
three plates. After **Make unique**, the copy has its own definition, **Fixture 2**, with its own records. Those
records occur once, so the override only affects this copy.

**Make unique** works one level deep. Fixture 2's children are new records of the same Plate, Washer and Bolt
definitions, which is why the Plate row still shows **◆3** and the banner still says the Plate definition is shared.
Edit the Plate's code and all three plates still change.

Notice that the plate's holes moved outwards with its edges, while the bolts and washers stayed put. They're separate
instances. To keep them together, you would drive both from one place, for example a code object that places the
bolts with `part()` from the same parameters.

::: tip Labels and F2
A label names one instance, and the tree shows the definition's name next to it. <kbd>F2</kbd> on an instance that has
a label changes only that label. On an instance without one, <kbd>F2</kbd> renames the definition, for every copy. To
rename the definition of a labelled instance, use the **Name** field in the inspector's **Definition** section, or
double-click its Library row.
:::

::: info What you learned
- <kbd>Ctrl</kbd>+<kbd>D</kbd> adds a **linked copy**: a new instance of the same definition, offset along X. Its label
  and position belong to that instance, so you can change them without breaking the link.
- **◆N** in the tree, **×N** in the Library and the **purple tint** show what is linked.
- Changing a definition's parameter defaults or code updates every occurrence, including code that uses it through
  `part()`.
- Clicking a Library row shows that definition on its own. <kbd>Esc</kbd> returns to the scene.
- Overrides belong to instance records, and a record inside a group definition is shared by every copy of that group.
- **Make unique** (<kbd>U</kbd>) gives one copy its own definition ("Fixture 2"), one level deep.
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> makes a unique copy in one step.
:::

Next: [Tutorial 3: Code objects and part()](/tutorials/code-and-parts).
