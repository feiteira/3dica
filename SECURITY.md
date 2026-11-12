# Security policy

## Supported versions

3Dica is young, and only the latest release gets fixes. The hosted app at <https://feiteira.github.io/3dica/> always
runs the latest `main`.

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/feiteira/3dica/security/advisories/new) (the repository's
**Security** tab, then **Report a vulnerability**).

Include the version or commit, your browser and OS, the steps to reproduce, and what an attacker could do. A small
`.3dica.json` that shows the problem is the most useful thing you can send. You will get an answer as soon as a
maintainer can look at it. Once a fix is out, the advisory is published with credit to you, unless you prefer
otherwise.

## The security model, in short

### Project code runs in your browser, and it is not sandboxed

Every Code object in a project is JavaScript. 3Dica runs it in a Web Worker in your browser tab, with the page's
origin. A few globals (`self`, `globalThis`, `postMessage`, `importScripts`, `fetch`, `XMLHttpRequest`, `WebSocket`) are
shadowed in its scope, but that is hygiene, **not a sandbox**: code that wants to can still reach what a worker of
this page can reach, including the network. Treat a `.3dica.json` file like any other script you download, and only run
code you trust.

- **Open asks first.** When you open or drop a file that contains code, 3Dica asks
  *"This file contains code that runs on your computer. Run it?"* before running anything. If you choose
  **Open without running**, that choice is saved with the autosave, so a reload or a reopened tab still waits until you
  click **Run code**.
- **Your own work runs without asking.** The built-in sample, the templates and the project restored from your own
  autosave run straight away.
- 3Dica has no accounts and no server of its own. Projects stay in your browser's `localStorage` and in the files you
  save.

Reports of code escaping the worker in ways that matter more than this (for example reaching the page's DOM, or
running before you confirm the dialog) are very welcome.

### The MCP bridge is local and opt-in

The MCP server in `mcp/` lets an AI assistant on your machine drive a running 3Dica. It is opt-in: nothing happens
unless you start the server (or register it with your assistant) and connect the app to it, and its bridge listens on
`localhost` only. While the bridge is connected, the assistant
can read and change the open project, which includes writing code that then runs in your browser as described above,
and it can take screenshots of the app. Turn the bridge off when you are not using it, and only connect assistants you
trust. Details are in the manual: [AI assistants (MCP)](https://feiteira.github.io/3dica/manual/guide/mcp.html).

Reports of the bridge being reachable from other machines or from other web pages are in scope and very welcome.
