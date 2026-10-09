# Community agents

Community agents are coding agents made by other teams and listed in the open
[ACP registry](https://github.com/agentclientprotocol/registry). Threadlines
can install and run them, but it has not tested them. Some features may not
work with a given agent.

The agents Threadlines supports itself (Claude, Codex, Cursor, OpenCode,
Antigravity, fx) are not in this list. Use the built-in one.

## What you are trusting

There is no sandbox, for these agents or for the built-in ones. An agent runs
on the computer Threadlines runs on and can read and change files in your
projects. What Threadlines does promise:

- Nothing is installed until you confirm it, once per agent.
- Threadlines never updates an agent by itself. An update is a click, and it
  installs exactly the version you were shown.
- What was installed can be installed again identically. A download is
  checked against the publisher's checksum when there is one, and otherwise
  against the hash recorded the first time. An npm package is installed from
  a saved lockfile.
- Agents the registry has set aside as broken are not offered.

An agent that updates itself is outside those promises. Threadlines tells you
when an agent reports a different version than the one it had when you
installed it.

## Install, update, remove

Open Settings › Providers and scroll to **Community agents**. Each row shows
who made the agent and where its files come from. **Install** asks you to
confirm once, then the agent moves up to "In use" with a **Community** tag.

- npm agents are installed with a copy of Node.js that Threadlines downloads
  and keeps for itself, so they don't depend on the Node on your computer.
- Other agents are a download from the publisher, unpacked by Threadlines.
- When the registry lists a newer version, the agent's row offers **Update**.
  Threadlines hasn't reviewed the new version either.
- **Remove**, at the bottom of the agent's row, deletes its files and its
  row. Threads that used it keep their history.

## Signing in

Threadlines runs whatever sign-in the agent offers. There are three kinds:

- The agent signs in by itself, usually by opening your browser.
- The agent has a login command. It runs in the sign-in panel's terminal, and
  you type into it.
- The agent reads a key from an environment variable. The Account tab names
  the variable; set it under Configuration, where it is stored as a secret.

A few agents sign in some other way. Their row says so and links to their
website.

Only programs you installed are ever run for a sign-in. If an agent asks for
a web page to be opened, Threadlines shows you the address and opens it only
when you click.

From a phone or another computer, a sign-in that gives you a code works
anywhere. One whose browser page has to answer to the agent's own computer
can only be finished on that computer.

## Modes and approvals

Threadlines doesn't know what an untested agent's modes mean, so it never
picks one for you. If the agent has modes, they show as a **Mode** option in
the composer, next to the model.

"Approval required" and "Full access" still decide how Threadlines answers
when the agent asks for permission to do something.

## What works

- With every agent: chats, tool calls shown as they happen, stopping a turn,
  permission requests, the model and mode the agent offers.
- Depends on the agent: resuming a thread after a restart, images and file
  attachments, plans, the browser panel, room tools and agent pages
  (docs/agent-pages.md). Pages need an agent that can reach Threadlines'
  tools; it learns the folder for a page's images from the error when it uses
  one elsewhere, since Threadlines cannot give it instructions.
- Not available: usage meters, importing the agent's own past sessions,
  extra accounts, and writing thread titles or commit messages (a tested
  agent does those).

## Where files live

Under the Threadlines data folder (`~/.threadlines/userdata` by default):

- `tools/acp/<id>/`: one folder per agent, with its installed versions and
  the record of what you confirmed.
- `tools/node/`: the Node.js used for npm agents.
- `caches/acp-registry/`: the last copy of the registry's list.

An agent's own settings and sign-in live wherever the agent keeps them,
usually in your home folder. Removing an agent from Threadlines does not
touch those.
