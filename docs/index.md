---
layout: home
title: 3Dica manual
titleTemplate: Code-CAD with linked components

hero:
  name: 3Dica
  text: Code-CAD with linked components
  tagline: Write each part in JSCAD JavaScript or OpenSCAD, place it in a tree as live linked copies, then click, isolate and move things in a 3D view. Free, open source, and it runs in your browser.
  image:
    src: /shots/overview.png
    alt: The 3Dica workbench with the sample project open
  actions:
    - theme: brand
      text: Open the app
      link: https://feiteira.github.io/3dica/
    - theme: alt
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Tutorial
      link: /tutorials/first-part
    - theme: alt
      text: GitHub
      link: https://github.com/feiteira/3dica

features:
  - title: A tree of objects and a Library
    details: Every object is a named definition with its own code. The Scene tree shows where each copy is placed, and the Library lists every definition with how often it occurs.
    link: /concepts/model
    linkText: The 3Dica model
  - title: Linked copies
    details: Ctrl+D places another copy of the same definition. Change the definition once and every copy follows. When one copy has to differ, make it unique.
    link: /tutorials/linked-copies
    linkText: Tutorial 2
  - title: Click to isolate, ghost and hide
    details: Click a part in the view or the tree. Press I to see it on its own, or H to hide it. Ghost (G, on by default) fades everything else. Select a Subtract group and its cutters show in translucent red.
    link: /reference/objects
    linkText: Working with objects
  - title: Gizmos that write placement, not code
    details: Move, rotate and scale with the gizmo, or type exact values. 3Dica stores the result in the instance's transform and never rewrites your code.
    link: /reference/transforms
    linkText: Transforms and the gizmo
  - title: Plain JSCAD JavaScript
    details: "A code object is a function body that uses @jscad/modeling: cuboid, cylinder, subtract, extrudeLinear and the rest. Call part('Bolt', { length: 20 }) to reuse another object, like an OpenSCAD module."
    link: /reference/code-api
    linkText: Code API
  - title: OpenSCAD code, kept as OpenSCAD
    details: Import .scad files, or start a blank OpenSCAD object. A built-in interpreter runs them, following OpenSCAD 2021.01. Top-level variables become parameters, Customizer comments become sliders and drop-downs, and echo() lines show in an Output panel.
    link: /guide/openscad
    linkText: OpenSCAD objects
  - title: Runs in your browser, builds with AI
    details: There's nothing to install and no account, and the project autosaves in your browser. Ask the Chat tab (Ctrl+L) for a part or a change, with your own key for Anthropic, OpenAI, OpenRouter and others, or a local model. Every AI change is one undo step. Locally, your own assistant can drive 3Dica over MCP.
    link: /guide/ai-chat
    linkText: AI chat
---

<style>
@media (min-width: 960px) {
  .VPHero.has-image .image-container { width: 440px; height: 360px; }
  .VPHero.has-image .image-src { max-width: 440px; max-height: none; }
}
.VPHero .image-src { border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45); }
</style>

## What a part looks like

Each object's code returns a shape. This is the sample project's "Bolt sizes" object: five bolts of increasing length, built
from the "Bolt" definition with `part()`.

```js
const out = []
for (let i = 0; i < params.count; i++) {
  const length = params.start + i * params.step
  out.push(translate([i * params.spacing, 0, length], part('Bolt', { length })))
}
return out
```

`params` holds the object's parameters. You edit their defaults in a table, and each placed copy can override them.
Everything else is the [JSCAD](https://github.com/jscad/OpenJSCAD.org) modeling library, with its functions
(`translate`, `cuboid`, `union` and about 90 more) in scope by their plain names.

New here? Read the [Introduction](/guide/introduction), then build [your first part](/tutorials/first-part). Coming from OpenSCAD? [Import your .scad files](/guide/openscad) as they are, or see [Coming from OpenSCAD](/guide/coming-from-openscad).
