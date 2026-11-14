# Worktree pickup

Status: built Nov 2026.

## Goal

A repository often has worktrees Threadlines did not make: `git worktree add` by hand, or another app that keeps one per task. Someone who adds that repository as a project should be able to carry on in those worktrees without typing paths, and without Threadlines treating the folders as its own. The UI never names another app.

## What the user sees

1. **Right after adding the repository.** The new-thread screen lays the worktrees out under the message box: a checkbox each, the branch, where it is, what is in it (changed files, commits ahead, age). Ones with nothing left to ship start unticked. "Add N threads" makes a thread per ticked worktree; "Not now" folds the list away. Either answer ends the offer.
2. **Added threads.** Each lands in the sidebar named from its branch ("fix/checkout-retry" reads "Checkout retry"). No turn starts. Opened before its first message, it says where it works and that deleting it leaves the folder.
3. **Every later visit.** Only a count, beside the recent threads' count ("4 worktrees"). Opening it lists the worktrees with "Work here" (points the draft on screen at it), "Add as threads…" (lays the list out again) and "Hide for this project".
4. **The Workspace picker** under the message box lists them under "Existing worktree", on desktop and phone, while the workspace can still be chosen: a draft, or a saved thread in the project folder that has not started.
5. **The command palette** has "Add existing worktrees as threads…" when the open project has any. It lays the list out and brings a hidden count back, which is the way out of "Hide for this project".

Which worktrees count: registered with git, present on disk, outside Threadlines' own worktrees folder, not the main checkout, not the one the project's folder sits in, and with no thread on this computer pointed at them.

## A guest in the worktree

A thread in one of these does not own it. That is `ThreadWorktreeOrigin` `{ kind: "existing" }` on the thread, the same marker a thread lent another thread's worktree carries (`kind: "thread"`, child-threads.md "Workspaces"). Everything that already asked "is this thread a guest?" covers it:

- the first turn never renames the branch;
- no setup script runs;
- deleting the thread never offers to remove the folder, and cleanup never pre-ticks it;
- undoing a turn only undoes the thread's own edits, never a whole-folder restore;
- a thread that continues in a guest's worktree ("New thread" from it, a plan implemented in a new thread) is a guest too.

The marker goes when the thread moves to another checkout.

How a thread gets it:

- `thread.create` with `worktreeOrigin: { kind: "existing" }` (the list's "Add N threads", and a draft's first send). The decider refuses it without a worktree path, and still refuses `kind: "thread"` from a client.
- `thread.checkout.select` with `existingWorktree: true` (a saved thread picking one in the Workspace picker).

A draft remembers it as `existingWorktree` beside its `worktreePath`; pointing the draft anywhere else drops it.

The branch picker under the message box and the Source panel reach these worktrees too (a branch checked out in one is listed with its worktree; the cleanup list can move a thread into one to look at it). Both ask for the same names list (`useWorktreesMadeElsewhere`) and send the marker when the worktree they point a thread at is one of them. A branch made or switched inside the worktree a guest is already in leaves the marker alone.

Not covered: a thread pointed at one of these worktrees before this shipped, or while the computer's server is older, has no marker and is treated as the worktree's owner, as it always was.

## Listing

`vcs.listWorktrees` gained two inputs, both ignored by an older server:

- `scope: "elsewhere"` leaves out the main checkout and everything under Threadlines' worktrees folder (compared by real path) before any per-worktree work.
- `statuses: false` names the worktrees without reading them. Reading one costs a `git status` there; on a repository with a few dozen worktrees that came to about seven seconds, every time. The count, the Workspace picker and the palette ask for names only (one `git worktree list`), kept five minutes. The laid-out list and the opened rows ask for statuses when they are shown; the names stand in until the answer comes, with "Checking" where the facts go and "Add" held back, since which rows start ticked is not known yet.

Each row also carries `managed`, `changedFileCount` and `lastCommitAt`, with decode defaults for an older server.

## Older servers and clients

The server says `worktreePickup` in its capabilities. Without it the client never asks for the list and never sends the marker, so nothing shows, and a list kept from before the server went back a version is dropped.

A client built between the shared-checkout work (#911, Nov 14 2026) and this one decodes `worktreeOrigin` as the one-member struct and rejects `kind: "existing"`, which breaks its thread list once any picked-up thread exists on a newer server it is connected to. No stable release has that schema (0.10.1 predates #911 and ignores the field), and a server serves its own client, so this needs a nightly from that window linked to a newer computer. Accepted; the alternative was a second field every "is it a guest?" check would have to read.

## What this device remembers

Per device, in local storage (`worktreePickup.ts`): which projects have the list laid out, and which have the count hidden. Adding a project sets the first; an offer that turns out empty is closed, so a repository added without worktrees does not lay a list out months later.

## Not built

- Continuing another tool's conversations from its own files. Separate question, waiting on demand.
- Removing or pruning these worktrees from Threadlines. They are the user's.
