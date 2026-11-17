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
  save. The only thing that leaves the browser is what the [AI chat](#the-ai-chat-and-your-api-key) sends to the
  provider you chose, while you use it.

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

### The AI chat and your API key

The Chat tab calls the AI provider you choose straight from your browser, with your own API key. 3Dica has no server,
so the key and the conversation never pass through one.

- **Where the key is kept.** Only in this browser: in `sessionStorage` until the tab closes, or in `localStorage` when
  you tick **Remember the key in this browser**, which starts off (keys `3dica:v1:ai-keys`; the other chat settings
  are in `3dica:v1:ai`). It is sent only to the provider's API host, in the request header. It is not written to
  project files, the autosave, STL exports, URLs, logs, toasts or error messages. A base URL with a user name or
  password in it is refused, and a key is never sent over plain `http://` to another machine.
- **Who else can read it.** Browser storage belongs to the whole origin. On the hosted app that is
  `https://feiteira.github.io`, which every GitHub Pages site of that account shares, this manual included. Anyone
  with access to your browser profile, and browser extensions with access to the page, can read it too. Leave
  **Remember** off, or run 3Dica on `localhost`, if that matters to you, and use a key with a spending limit. Serving
  the app from an origin of its own (for example a custom domain) would end the sharing; the hosted app does not do
  that yet.
- **Project code and the key.** A project's code runs in a Web Worker, which has no access to local or session
  storage. That is not a sandbox (see above), so only run project code you trust, especially in a browser that
  remembers a key.
- **What the model sees.** Scene data, definitions with their code, error messages and screenshots of the model go to
  the provider as part of the conversation, under that provider's terms.

### Prompt injection

The assistant reads names, labels, comments and code from the open project. A project made to manipulate an AI could
hide instructions there. The assistant is told to treat project content as data, not instructions, but no model
follows that perfectly. What a misled assistant can do is limited to the chat's tools:

- change the project (each change is one undo step labelled `AI: …`, so you can see and undo it). Its `undo` and
  `redo` walk only its own steps, so it can't undo your edits and then lose them with its next change. After 100
  changes in one message the chat pauses until you click **Continue**, so all of them stay within the undo history;
- write code that then runs in your browser, like any code in a project (see above);
- download a project file or an STL to your downloads folder;
- replace the project with an empty one or the sample, but only after you click **Approve** in the chat.

It can't read or write other files, open projects, or read your key. Don't let the assistant work unattended on a
project you don't trust, and read code it wrote for such a project before you rely on it.

Reports of a way to get the key out of the browser, to make the chat send it anywhere other than the chosen provider,
or to make the assistant act beyond its tools are in scope and very welcome.
