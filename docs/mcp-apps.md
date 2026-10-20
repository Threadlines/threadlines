# MCP apps

Some MCP tools come with a small screen of their own: a chart you can change,
a list you can pick from, a form. These are MCP Apps
([the spec](https://github.com/modelcontextprotocol/ext-apps)). When an agent
calls such a tool, the chat shows its screen as a card right under the step
that ran it, in the same kind of panel as an agent page.

Cards work with Claude and Codex. Other agents show the tool call as a plain
step.

## What you can do with a card

- Use the app where it is: change a range, pick an item, press its buttons.
- Open it beside the chat with the button on the card's title line. The same
  app moves over, so what you did in it stays (in the desktop app and in
  Chromium-based browsers; elsewhere it starts again from the tool's answer).
  It keeps running there while you scroll the chat, and closes when you leave
  the chat.
- A card you scroll far away from starts again from the tool's answer when
  you come back to it.
- A message the app wants to send goes into the message box, for you to send
  or not. Links you click in an app open in your browser.

## What an app can do

An app runs sealed off from Threadlines, in a frame with no access to your
session, other pages or the app's storage:

- It can only reach the hosts its tool server says it needs. Nothing else
  loads or connects, and forms post nowhere.
- It can ask its own tool server to run a tool, through the agent that ran
  it. Only tools the server lets apps call. Unless the agent works with full
  access (and not in plan mode), the card asks first: Allow once, Allow every
  call (until you reload Threadlines), or Don't allow. It also asks when the
  server doesn't say whether apps may call a tool, when the agent has started
  a new session since, and for an app a side answer showed.
- It cannot open tabs, navigate away (an app that tries is stopped), use your
  camera, microphone or location, or start an agent. Copying to the clipboard
  works when the app asks for it.

Known gaps: the MCP Apps spec asks hosts to run apps on a separate web origin
through a small proxy page. Threadlines runs them in a frame with no origin of
its own instead, which isolates them at least as well from Threadlines but
means an app can't keep anything in browser storage. An app that navigates
away is stopped, but in a web browser (not the desktop app) the first request
of that navigation still goes out.

## When the agent has stopped

The card keeps the app's screen once it has loaded, so an old card still
shows. Using a tool from it needs the agent that ran it. A card that never got
to load says the agent has stopped, with a button that starts it again and
loads the app.

## Where cards live

In the Threadlines data folder's database: each call the card shows (the
tool's input and answer, cut down when over 512 KB) and the app's screen as
its server sent it (up to 2 MB). Deleting a thread deletes them.
