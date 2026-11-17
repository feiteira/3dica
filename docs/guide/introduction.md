# Introduction

3Dica is a code-CAD workbench that runs in your browser. You describe each part in JavaScript with the
[JSCAD](https://github.com/jscad/OpenJSCAD.org) modeling library, as you would in OpenSCAD or OpenJSCAD. Then you place
those parts in a tree as **linked copies**, and you can click, isolate and move them in a 3D view.

![The 3Dica workbench with the sample project "Bracket kit"](/shots/overview.png)

Think of OpenSCAD modules that you can click on, drag around and copy, and that stay linked to their definition.

## Who it is for

- **OpenSCAD and JSCAD users** who like describing shapes in code but miss a way to click on a part, see it on its
  own, or nudge it into place.
- **Makers designing parts for 3D printing**, who want exact dimensions, parameters they can tweak, and an STL at the
  end.
- **Programmers** who would rather write a loop than draw a sketch.
- **AI-assisted modeling.** The [AI chat](/guide/ai-chat) in the right column builds and changes parts for you,
  with your own API key or a local model, and checks its work in screenshots. When you run 3Dica locally, an
  assistant such as Claude Code can also drive it through an MCP server. See [AI assistants (MCP)](/guide/mcp).

## The core idea

A 3Dica project has three kinds of things:

| Term | What it is | OpenSCAD analogy |
|---|---|---|
| **Definition** | A named, reusable thing. A **code** definition is a JSCAD function body with parameters. A **group** definition holds child instances and has an operation: none (a plain assembly), union, subtract or intersect. | a `module` |
| **Instance** | One placement of a definition inside a group, with a position, rotation and scale. It can also have a label, a color, parameter overrides and a hidden flag. | one call of a module |
| **Occurrence** | One copy you actually see. If a group is placed twice, each of its children occurs twice. | one copy in the render |

Two rules shape everything else:

1. **Copies are linked by default.** <kbd>Ctrl</kbd>+<kbd>D</kbd> adds another instance of the *same* definition.
   Edit the definition and every copy updates, including a child moved inside a linked group. Purple tints and `◆N`
   badges show you what is linked. **Make unique** (<kbd>U</kbd>) gives one copy its own definition.
2. **Code owns the shape, the tree owns the placement.** A definition's code says what the part looks like in its own
   coordinates. Where each copy sits, and how it's turned and scaled, lives in the instance. The gizmo and the
   transform fields only ever change the instance, and never touch your code.

Code can also reuse another definition directly: `part('Bolt', { length: 20 })` returns the Bolt's geometry with
`length` overridden, like calling an OpenSCAD module. [The 3Dica model](/concepts/model) explains all of this in
detail.

## How it compares

3Dica uses the same modeling library as OpenJSCAD and borrows a lot of ideas from OpenSCAD. It doesn't replace either
of them. Here is an honest comparison:

| | OpenSCAD | OpenJSCAD | 3Dica |
|---|---|---|---|
| Language | the OpenSCAD language | JavaScript + `@jscad/modeling` | JavaScript + `@jscad/modeling` (the same library) |
| Structure | modules in text files | one script | a tree of named definitions, each with its own code |
| Reusing a part | call the module again | call the function again | a linked instance in the tree, or `part()` in code |
| Placing a part | edit `translate()` / `rotate()` in code | edit the code | drag the gizmo or type values. Code is optional. |
| Picking a part in the view | mark it with `#` in the code to highlight it | no | click it, then isolate, ghost or hide it |
| Parameters | Customizer | parameter UI from `getParameterDefinitions()` | a parameter table per definition, plus overrides per instance |
| Geometry kernel | native C++ (CGAL, Manifold) | JavaScript (JSCAD) | JavaScript (JSCAD), in a Web Worker, with results cached |
| Libraries and includes | yes (BOSL2, MCAD, and others) | yes | no. `part()` reuses definitions in the same project. |
| Export formats | many (STL, 3MF, OFF, AMF, DXF, SVG, and others) | many (STL, OBJ, 3MF, DXF, SVG, and others) | binary STL |
| Maturity | over a decade of use | mature | v0.1 |

If you need libraries such as BOSL2, 2D export or very heavy booleans, OpenSCAD is the better tool today. If you want
to work with a tree of parts you can click on and copy, while keeping code for the shapes, try 3Dica.

## What 3Dica is not

- **It isn't a sketch-and-constraint CAD.** There are no 2D sketches with constraints, no feature history and no
  fillet tool, as in FreeCAD, Fusion or Onshape. You round an edge in code, for example with `roundedCuboid`,
  `expand` or `minkowski`.
- **It isn't a sandbox.** Your code runs in a Web Worker, but nothing isolates it from the page: a project's code can
  do anything a script on a web page can do. When you open a file that contains code, 3Dica asks before running it,
  so only run files you trust.
- **It isn't fast at big booleans.** JSCAD is written in JavaScript. A boolean between two detailed meshes can take
  seconds. 3Dica caches results by content (the 8 bolts of the sample share one mesh), keeps the last good shape on
  screen while you type, and stops runaway code after 20 seconds. It also refuses geometry above 2,000,000 triangles
  before it can take the page down.
- **It doesn't import or exchange CAD files yet.** Version 0.1 opens and saves its own `.3dica.json` project files
  and exports binary STL. It can't import STL, STEP or SVG files.

## Next steps

- [Getting started](/guide/getting-started): open the app, find your way around, look at the sample project.
- [Your first part](/tutorials/first-part): a plate with a hole, made in the tree without writing any code.
- [Coming from OpenSCAD](/guide/coming-from-openscad): how OpenSCAD concepts and code translate to 3Dica.
