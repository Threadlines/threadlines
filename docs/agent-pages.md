# Agent pages

An agent can answer with a page as well as text: a chart, a table, a diagram,
a collage of screenshots, a UI mockup, or a written document. The page shows in
the chat above the agent's reply, on the chat's own background, and follows
your light or dark theme as you switch.

Ask for one ("show this as a chart", "mock up the settings screen") or let the
agent decide a picture says it better. Pages work with Codex, Claude and
OpenCode, and with community agents that can reach Threadlines' tools (the same
ones that get the browser panel). Turn them off in Settings, Threads, Agent
pages. Turning them off applies to new agent sessions at once and makes running
ones answer in text; pages already in a thread stay.

## What you can do with a page

- Click its title to fold it to one line, and again to open it.
- Open it full size, view its source, or save it as a file.
- Links you click in a page open in your browser.

A page an agent updates in the same turn changes where it stands, like a live
status board. When a later turn updates it, the new version shows in that turn
and the earlier turn keeps the version it showed. Rewinding a thread removes
the pages of the turns it takes back. Deleting a thread deletes its pages. A
fork starts without the original thread's pages; its agent is told they
existed.

## How agents build them

Agents get two tools:

- `preview_page` renders a page exactly as the chat will and returns a
  screenshot, the height the page needs, and its console output. The first
  preview on a computer downloads a small private browser (about 100 MB) into
  the Threadlines caches folder; publishing works without it.
- `show_page` publishes the page, or a new version of one, in the thread.

Each thread has a page assets folder in the system temp folder. An agent saves
a page's images there with its own tools, so its usual file permissions apply,
and Threadlines copies them into the page when it is published. Threadlines
reads no other file for a page.

## Claude artifacts

Claude Code has a publishing tool of its own, Artifact, which uploads a page
to claude.ai and gives it a link. It is off unless you turn on Settings,
Threads, Claude artifacts, because it sends the page to Anthropic.

With it on, ask Claude for an artifact, or for a page you can share on
claude.ai. Claude publishes it, and Threadlines shows the same file in the
chat as a page marked "On claude.ai". Open it there from the page's title line
or its full-size view. The link is private to you until you share it from the
page's Share menu on claude.ai. Publishing the file again updates the page
already in the chat.

- It needs Claude signed in with a claude.ai account (Pro, Max, Team or
  Enterprise). An API key cannot publish. A saved long-lived token is untested
  and, by Anthropic's notes on those tokens, not expected to.
- Turning the setting on applies to Claude sessions that start afterwards.
  Turning it off also refuses the next publish of a session already running.
- The copy in the chat is the file as Threadlines read it a moment after
  Claude published it, drawn under the same rules as any page. Parts that only
  work on claude.ai (files uploaded beside the artifact, comments, live data)
  do not show in it. A file that is a link to another file is not shown.
- A page Claude published still shows if you stop the turn right after: it is
  already on claude.ai, and the chat should say so.
- Threadlines turns the tool on through `CLAUDE_CODE_ARTIFACT`, a Claude Code
  setting Anthropic has not documented for SDK sessions yet, so a Claude Code
  update could switch this off until we follow.

## What a page can do

A page runs in a sealed frame, apart from Threadlines and your session:

- Scripts, styles and fonts load only from a few public code sites (cdnjs,
  jsDelivr's npm files, unpkg, esm.sh, the Tailwind and jQuery CDNs, Google
  Fonts and Bunny Fonts). Nothing else loads: no other requests, no remote
  images, no frames, no forms.
- A page cannot open tabs or windows by itself. In the desktop app it cannot
  navigate away. In a web browser, a page that navigates away is stopped at
  once, though that first request still goes out.
- A page cannot keep keyboard focus it takes by script while you are typing
  elsewhere. Clicking into a page, or tabbing into it, gives it focus.

Known gaps: in a web browser the first request of a page that navigates away
cannot be refused, and a determined page can still make a request through
browser features no content policy covers, such as a DNS prefetch.

## Where pages live

Under the Threadlines data folder (`~/.threadlines/userdata` by default):

- `pages/<thread>/<page>/<version>.html` or `.md`: each version as the agent
  wrote it, images inlined. Versions nothing shows any more are removed after
  an hour.

The preview browser lives in `~/.threadlines/caches/preview-browser`.
