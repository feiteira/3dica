# AI chat

The **Chat** tab in the right column is an AI assistant that works on the project you have open. Ask it for a part,
a change or a check. It reads the scene and the code, creates and edits objects, and takes screenshots of the 3D view
to see what it built. You watch the tree, the code and the view change as it works.

![The chat built a 40 × 30 × 5 mm plate with a 6 mm hole: the conversation with two tool cards and a screenshot thumbnail in the right column, the new part in the 3D view](/shots/chat-conversation.png)

The chat runs entirely in your browser, also on the hosted app. You bring your own API key from a provider such as
Anthropic, OpenAI or OpenRouter, or you use a model on your own computer with Ollama or LM Studio. The tab talks to the
provider directly. 3Dica has no server, so your key and your project never pass through one.

The assistant uses the same tools as the [MCP server](/guide/mcp), the way for an assistant outside the browser, such
as Claude Code, to drive 3Dica. [Chat or MCP?](#chat-or-mcp) compares the two.

## Open the chat

Click the **Chat** tab at the top of the right column, or press <kbd>Ctrl</kbd>+<kbd>L</kbd>. The shortcut switches to
the chat and puts the cursor in the message box. Press it again to go back to the **Inspector**: the cursor returns
to where it was, for example in the code editor. It works everywhere, also in the code editor. The browser remembers
which tab you had open.

![The Chat tab the first time: a short description, the Set up a provider button, and the message box, disabled until a provider is set up](/shots/chat-empty.png)

Selecting objects never switches tabs. A dot on the Chat tab shows what the assistant is doing, also while you work in
the Inspector: blue and blinking while it works, amber when it waits for you to approve something.

## Set up a provider

1. Click **Set up a provider** (or the provider name at the top of the chat). The chat settings open in the panel.
2. Choose the **Provider**.
3. Paste your **API key**. **Get a key** next to the field opens the provider's key page. Local servers don't need one.
4. Choose a **Model**. When you leave the key field, the list of models your key can use loads, and you can type to
   filter it. **Refresh** loads it again. You can also type any model id.
5. Click **Save**.

The message box is ready when the header shows the provider and the model, for example
**Anthropic · claude-opus-5-5**.

### Providers

| Provider | Get a key | Default model | Notes |
|---|---|---|---|
| **Anthropic** | [platform.claude.com](https://platform.claude.com/settings/keys) | `claude-opus-5-5` | The Claude models, with effort and prompt caching |
| **OpenAI** | [platform.openai.com](https://platform.openai.com/api-keys) | pick one | |
| **OpenRouter** | [openrouter.ai](https://openrouter.ai/settings/keys) | `anthropic/claude-opus-5.5` | One key for models from many providers. The list shows only models that can use tools. |
| **Google Gemini** | [aistudio.google.com](https://aistudio.google.com/apikey) | pick one | Through Gemini's OpenAI-compatible API |
| **Groq** | [console.groq.com](https://console.groq.com/keys) | pick one | |
| **Mistral** | [console.mistral.ai](https://console.mistral.ai/api-keys) | pick one | |
| **DeepSeek** | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | pick one | |
| **Ollama (local)** | not needed | pick one | See [Local models](#local-models) |
| **LM Studio (local)** | not needed | pick one | See [Local models](#local-models) |
| **Custom (OpenAI-compatible)** | optional | type one | Any server with the OpenAI Chat Completions API, see [Custom servers](#custom-servers) |

An API key is billed by the provider, separately from a chat subscription such as Claude.ai or ChatGPT. Most providers
want credit on the account before the key works.

The chat sends its requests, and your key, only to the provider's API:

| Provider | API address |
|---|---|
| Anthropic | `https://api.anthropic.com` |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `https://api.groq.com/openai/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Ollama | `http://localhost:11434/v1`, or the base URL you enter |
| LM Studio | `http://localhost:1234/v1`, or the base URL you enter |
| Custom | the base URL you enter |

A browser only lets a web page call an API that allows it (CORS). Every hosted provider in the list was checked for
that. Others, such as xAI, are left out because their API does not allow it in every browser. You can still try one
of them as **Custom**.

### Local models

**Ollama** and **LM Studio** run models on your own computer, with no key and no cost per token. Pick a model that
supports tool calling: in Ollama's library these carry the *tools* tag. The model list loads only when you click
**Refresh**.

The browser treats a local server like any other site, so the server must allow requests from the page:

| Server | 3Dica on the hosted site | 3Dica on `localhost` (a local copy) |
|---|---|---|
| **Ollama** | Start Ollama with `OLLAMA_ORIGINS=https://feiteira.github.io`, for example `OLLAMA_ORIGINS=https://feiteira.github.io ollama serve` | Works as is: Ollama allows `localhost` pages by default |
| **LM Studio** | Turn on CORS in LM Studio's server settings | Turn on CORS too: a different port counts as a different site |

If Ollama runs as a desktop app or a system service, set the variable there and restart it (Ollama's FAQ explains
how). When the hosted site calls a server on your computer, your browser may ask whether the page may connect to
devices on your local network: allow it. If your browser refuses to let a secure page call an `http://` address at
all, run [3Dica locally](/guide/getting-started#or-run-it-locally) instead.

### Custom servers

**Custom** takes any server with the OpenAI Chat Completions API. Enter its base URL, usually ending in `/v1`, for
example `https://llm.example.com/v1`. The key is optional. The server must answer the browser's CORS check: allow the
3Dica address as an origin and the `authorization` and `content-type` request headers. On the hosted site, a server
that isn't on your computer must use `https://`.

## Talk to it

Type in the message box at the bottom and press <kbd>Enter</kbd>. <kbd>Shift</kbd>+<kbd>Enter</kbd> starts a new
line, and <kbd>Esc</kbd> leaves the box so the app's shortcuts work again. While the assistant works, the send button
becomes **Stop**.

Every message also tells the assistant what you have selected, so *make this one 10 mm taller* means the object
selected when you sent it.

The reply streams in. Between the lines of text you see what the assistant does, one card per tool call:

- A ✓ means the call worked and ✕ that it failed. The assistant reads the failure and usually fixes it on its own.
- Click a card to see the call's input and result. Code in them is shown as code.
- The target button on a card selects the object the call created or changed.
- Screenshot cards show a thumbnail. Click it to see it full size.
- **Thinking** is the model's reasoning, for models that send it (Claude sends a summary). Click it to read it.

If a message fails (see [Troubleshooting](#troubleshooting)) and you send the same text again, the chat retries it
rather than sending it twice. A different message after a failure goes out with a note that the earlier one got no
reply.

**New chat** at the top starts over. The conversation is not saved: a reload starts an empty chat too. The number next
to it, such as *8.5k context*, is how many tokens the model read in its last turn. Hover it for the output tokens of
the whole chat.

### When it stops

| Notice | What happened | What to do |
|---|---|---|
| *Paused after 25 steps (the limit for one message). Press Continue to let it keep going.* | The assistant used the step limit of one message (see [Max steps](#settings)) | Click **Continue**, or ask for something smaller |
| *Paused after 100 changes in one message, so all of them can still be undone. Press Continue to let it keep going.* | The undo history keeps 200 steps. More changes in one message would push its first ones, and your own steps before them, out of reach | Look at what it did, then click **Continue** |
| *Stopped.* | You pressed **Stop** | **Continue** goes on where it stopped |
| *The reply was cut off at the model's output limit. Ask it to continue, or to answer in shorter steps.* | One reply, often a long piece of code, was too long | Ask it to continue, or to split the change into steps |
| *The conversation no longer fits in the model's context window. Start a new chat.* | The conversation, with all its screenshots, became too long for the model | Click **New chat** |
| *The model declined: …* | The model refused the request | Rephrase it, or try another model |
| An error with **Retry** | The provider failed in a way that may pass, see [Troubleshooting](#troubleshooting) | Wait or fix the cause, then click **Retry** |
| An error without **Retry** | Sending the same request again would fail the same way: a wrong key, an unknown model, a request the provider refused | Fix it in the settings (then **Retry** appears), or click **New chat** |

## What it can do

The assistant has 24 tools. They are the [MCP server's tools](/guide/mcp#tools) without `help` (the code API is in
its instructions already) and `load_project` (you open files yourself, with **Open**).

| Group | Tools | What they do |
|---|---|---|
| Read | `status`, `get_scene`, `list_definitions`, `get_definition`, `get_errors` | The app's state, the scene tree with sizes, the Library, a definition's code and parameters, the errors |
| Change | `create_object`, `update_definition`, `add_instance`, `update_instance`, `move_instance`, `duplicate`, `make_unique`, `wrap`, `ungroup`, `delete` | Everything the toolbar, the tree and the inspector do: new objects and code, parameters, linked copies, transforms, groups and booleans |
| History | `undo`, `redo` | Undo and redo the assistant's own steps, in the same history you use |
| Your view | `select`, `set_view` | Select something for you, isolate it, ghost, frame, front/right/top/iso |
| Look | `screenshot` | Render the model, by default four views in one 768 × 576 image, without moving your camera |
| Files | `save_project`, `export_stl` | Download the project file or an STL, as **Save** and **STL** do |
| Start over | `new_project`, `load_sample` | Replace the project, after you approve it |

Every editing tool waits for the evaluation and reports sizes and errors, so the assistant knows whether its code
works. The loop it follows (change one thing, read the result, look, fix) is described in
[How the assistant works](/guide/mcp#how-the-assistant-works).

### Every change is one undo step

Each change the assistant makes is one ordinary step in the undo history, labelled `AI: …`, for example
*AI: Add Plate with hole*. Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo it, like your own edits. The toolbar's undo
tooltip shows the label. The assistant's `undo` and `redo` tools walk the same history, but only over its own
`AI: …` steps: they stop at your edits, which only you undo. So the assistant can never undo your work and then lose
it with its next change (any change clears the redo steps).

### Actions that can't be undone

Replacing the project with **New** or **Sample** clears the undo history. Before the assistant does either, the chat
asks you:

![The approval card: "New project — This can't be undone: the AI wants to replace the current project with an empty one (name: "Bracket v2"). Save first if you want to keep it." with Decline and Approve buttons; the Chat tab shows an amber dot](/shots/chat-confirm.png)

**Approve** runs it. **Decline** (or **Stop**) tells the assistant you said no, and nothing changes. While the card
waits, the line under the message box says *Waiting for your approval above.* After you answer, the cursor goes back
to the message box.

### Files

`save_project` and `export_stl` download a file, like the **Save** and **STL** buttons: the browser puts it in your
downloads folder, and a toast names it, such as *AI: saved Plate.3dica.json*. The assistant can't read or write
anything else on your computer, and it can't open files.

### What it can't do

- It can't see your screen or the rest of the app. It sees the project through its tools, and the 3D view only in
  the screenshots it takes.
- It doesn't remember anything between chats. **New chat**, a reload, or a change of provider, model, key or effort
  starts a fresh conversation. The chat says so: *This starts a fresh conversation: the model does not see the
  messages above.*
- It can't browse the web or install anything.
- It works on one project, the one open in this tab.

You can keep working while it runs, but you and the assistant may then change the same thing. It is easier to wait,
or to press **Stop** first.

## Tips and example prompts

- Give sizes in millimetres and say what the part is for. *A 3 mm thick wall-mount bracket for a 25 mm pipe* works
  better than *a bracket*.
- Select the object you mean, then say *this*.
- Ask it to check its work: *take a screenshot from the top and compare*.
- Ask for parameters when you will want to change the part later: *make the hole diameter a parameter*.
- Large changes go better in steps. Review each one, then ask for the next.

Some prompts to start from:

- *Make a 40 × 30 × 5 mm plate with a 6 mm hole in the middle.*
- *Describe the scene and take a multi-view screenshot.*
- *Make the second fixture unique and widen only its plate to 80 mm.*
- *Find any code errors in the project and fix them.*
- *Round the corners of the selected plate with a 3 mm radius.*
- *Add a parameter "count" to Bolt sizes, and show me 7 bolts.*
- *Export the Plate as an STL.*

## Settings

Open them with the provider name at the top of the chat.

![The chat settings: Provider Anthropic, the API key as dots with Get a key, Remember the key in this browser, Forget key, Model claude-opus-5-5 with Refresh, Effort Medium, Send screenshots as images, Max steps per message 25, and the line "Your key is sent only to api.anthropic.com. 3Dica has no server."](/shots/chat-settings.png)

| Field | Default | What it does |
|---|---|---|
| **Provider** | Anthropic | Where the requests go. Each provider keeps its own key, model and base URL, so you can switch back and forth. |
| **Base URL** | the provider's | Only for Ollama, LM Studio and Custom. A full address starting with `https://`, or `http://` for a server on your computer. It can't contain a user name or password: put a key in the key field. A key is never sent over plain `http://` to another machine, so for a server elsewhere on your network either use `https://` or leave the key empty. |
| **API key** | empty | Your key for this provider. The eye button shows it while you check it. **Get a key** opens the provider's key page. |
| **Remember the key in this browser** | not ticked | On: the key is kept in this browser's local storage, which every page of the site can read (the hint names the site). Off: it is kept only until you close the tab. See [Privacy](#privacy-and-your-key). |
| **Forget key** | | Deletes the stored key of this provider, at once. |
| **Model** | the provider's default, if it has one | A model id. Type it, or pick it from the list that **Refresh** loads. |
| **Effort** | Anthropic: Medium. Others: Default | How hard the model thinks before it answers. Anthropic: Low, Medium, High, Extra high, Max, for Claude 4.6 and later. Others: Default, Low, Medium, High, sent only to models that take it (OpenAI's reasoning models and OpenRouter). More effort is slower and uses more tokens. |
| **Send screenshots as images** | on | Off: the assistant gets only the text that comes with each screenshot (what is shown, sizes, errors), also for screenshots taken earlier in the chat. A model that reads only text needs nothing: when it refuses an image, the chat says *This model does not take images, so screenshots reach it as text only from now on.* and carries on. On OpenRouter, models listed as text-only get text from the start. |
| **Max steps per message** | 25 | How many model turns one message may take before the chat pauses and asks you to **Continue**. 1 to 200. |

The line at the bottom names the one host your key is sent to. **Save** applies the settings at once. A different
provider, model, key or effort starts a fresh conversation. **Cancel** (or <kbd>Esc</kbd>) throws your changes away.

## Privacy and your key

**Your key stays in this browser.** The chat sends it only to the provider you chose, in the request header, straight
from this tab. It is never part of the project file, the autosave, an STL, the address bar, a log or an error message.

| Remember the key | Where the key is kept | Gone when |
|---|---|---|
| on | the browser's `localStorage` for this site, under `3dica:v1:ai-keys` | you click **Forget key**, or clear the site's data |
| off | the browser's `sessionStorage`, only for this tab | you close the tab (a reload keeps it) |

The other settings (provider, model, base URL, effort and so on, never a key) are in `localStorage` under
`3dica:v1:ai`. See [Files, autosave and STL](/reference/files#where-it-is-stored).

::: warning One site, many pages
Browser storage belongs to a *site*, and every page of the site can read it. The hosted app lives on
`feiteira.github.io`, which also serves this manual and any other GitHub Pages site of the same account. A remembered
key is readable by those pages too, and by anyone who uses your browser profile. That is why **Remember** starts off.
Keep it off, or run [3Dica locally](/guide/getting-started#or-run-it-locally): `localhost` is a site of its own.
:::

**What the model receives.** Everything in the conversation goes to the provider, and their terms decide what they
keep:

- the assistant's instructions and the list of tools, the same for every message;
- your messages, each with a short summary of the app: the project name, what is selected, the group you are in,
  whether code is paused, and the names of objects with errors;
- what the tools read: the scene tree, definitions with their code and parameters, error messages;
- the screenshots it takes, as images (unless you turn that off).

It doesn't receive your files, your other projects, or anything outside this tab. Code that the assistant writes runs
in your browser at once, like code you type, with the same [lack of a sandbox](/help/faq#is-it-safe-to-open-a-project-someone-sent-me).

::: tip Projects from other people
Names, labels, comments and code in a project are data for the assistant, and its instructions say so. A project made
to trick an AI could still try to steer it. Before you let the assistant work on a project you don't trust, read its
code, and keep an eye on what it changes: every change is an `AI: …` step you can undo.
:::

## Costs

The provider bills you for the tokens the model reads and writes. 3Dica itself is free and adds no fee.

- **Every turn reads the whole conversation again.** One message usually takes several turns: change something, take
  a screenshot, perhaps fix it, then answer. Each turn sends the instructions and tool list (about 7,000 tokens), your
  messages, and every tool result and screenshot so far. The *context* number in the header shows how big that has
  become.
- **Screenshots cost input tokens.** An image is read like text, and it stays in the conversation. At the default
  768 × 576 pixels that is several hundred tokens with most providers, again on every later turn.
- **Prompt caching.** With Anthropic, 3Dica marks each request for caching, so the part that repeats from the last
  turn is billed at Anthropic's lower cache price. Other providers may cache repeated prompts on their own. See their
  pricing pages.
- **Thinking counts as output.** Higher effort makes the model think longer, and you pay for those tokens.

To spend less: start a **New chat** when you change topic, lower **Max steps per message**, use a smaller model for
simple edits, or run a local model.

## Troubleshooting

The chat shows a problem as a notice in the conversation. Where it mentions the chat settings, it has an
**Open settings** button. The last one has **Retry** when trying again can help: after a rate limit, an overload, a
lost connection or a server error, or once you changed the settings. In the messages below, *Anthropic* stands for the
provider you use.

| Message or symptom | Cause | Fix |
|---|---|---|
| *Anthropic did not accept the API key. Check the key in the chat settings.* | The key is wrong, was revoked, or belongs to another provider | Copy the key again from the provider's key page, paste it, Save, then **Retry** |
| *Anthropic refused the request (…). The key may not be allowed to use this model, or the account may need credit.* | No credit or billing on the account, or the key can't use that model | Add credit, or pick another model |
| *Anthropic does not know the model '…'* | A typo, or a model your key can't use | Open the settings, click **Refresh** and pick a model from the list |
| *Anthropic rate limit reached (…). Wait a moment, then try again.* | Too many requests or tokens per minute, common on new accounts and free tiers | Wait, then **Retry**. Lower **Max steps per message**, or start a **New chat** to send less. |
| *Anthropic is overloaded right now. Try again in a minute.* | The provider is busy | **Retry** later, or use another model |
| *Anthropic had a server error (500: …). Try again in a moment.* | A problem on the provider's side | **Retry** in a moment |
| *Could not reach Anthropic. Check your connection. A provider that does not allow requests from web pages (CORS) fails this way too.* | You are offline, or an extension or a firewall blocks the request | Check your connection and your browser extensions, then **Retry** |
| *Could not reach the local server at `http://localhost:11434/v1`. Make sure it is running and allows requests from this page (CORS).* (or *the server at …* for one on another machine) | Ollama, LM Studio or your Custom server isn't running, can't be reached at that address, or doesn't allow requests from the page | Start it and check the base URL. Then see [Local models](#local-models) (`OLLAMA_ORIGINS`, CORS in LM Studio, the browser's local network prompt) or [Custom servers](#custom-servers). |
| *The conversation is too long for this model. Start a new chat.* | The conversation no longer fits the model's context | Click **New chat** |
| *This model does not take images. Turn off 'Send screenshots as images' in the chat settings.* | The model can't read images, and the chat could not tell from the provider's answer | Turn off **Send screenshots as images**, or pick a model that reads images |
| *The model '…' does not work with this chat (it needs the Chat Completions API).* | Some OpenAI models (the *-pro*, *codex* and *deep-research* ones) answer only on another API, so the list leaves them out | Pick another model |
| *… refused the request (…)* naming tools or functions | The model doesn't support tool calling | Pick a model that does. In Ollama, look for the *tools* tag. |
| The assistant only talks, or writes tool calls as plain text, and nothing changes | The model is weak at tool calling, which is common with small local models | Use a larger model |
| *The provider listed no models that can use tools.* in the settings | The list is empty or filtered | Type the model id yourself |
| The message box is disabled: *Add your … API key to start.* | The provider isn't set up | Click **Set up** |
| A key you remembered is gone | The site's data was cleared, or **Remember** was off and the tab was closed | Paste it again |

For problems with the models you build (red dots, nothing renders), see [Troubleshooting](/help/troubleshooting).

## Chat or MCP?

Both let an AI work on your 3Dica project with the same tools, the same undo steps and the same screenshots. They
differ in where the AI runs.

| | AI chat | [MCP server](/guide/mcp) |
|---|---|---|
| Where you talk to the AI | the Chat tab, in 3Dica | your own assistant, such as Claude Code or Claude Desktop |
| Which model | any provider you set up, with your API key, or a local model | whatever your assistant uses |
| Works on the hosted app | yes | no: it needs a local copy of 3Dica and Node.js |
| Setup | paste a key | clone the repository and register the server |
| Files | downloads only | reads and writes files on your disk, and opens projects (`load_project`) |
| **New** and **Sample** | asks in the chat first | your MCP client asks before tool calls |
| Undo labels | `AI: …` | `MCP: …` |
| Screenshot default | 768 × 576 | 800 × 600 |

Use the chat for quick help while you model. Use MCP when your assistant should also work with files, or when it is
already your main tool, for example in a coding session.
