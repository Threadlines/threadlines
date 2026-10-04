# Codex

This guide is for people who want to use more than one Codex account in Threadlines.

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## I Only Use One Codex Account

Use the default provider and log in with Codex normally:

```bash
codex login
```

Or use `Sign in` on the Codex row in `Settings -> Providers`. Threadlines runs the same sign-in for
you and opens the sign-in page.

## Add Another Codex Account

Open `Settings -> Providers`, open the Codex row, and choose `Add another Codex account`. The `+`
at the top of the page has the same option.

1. Give the account a name (for example `Work`) and pick a color.
2. Choose `Sign in to Codex` and finish signing in on the page that opens.

That's it. The account shows up as `Codex · Work` with a colored letter on its logo in Settings, the
model picker, and the chat. Its row shows its own email and usage.

What Threadlines does for you:

- creates a private folder for the account's login, under
  `~/.threadlines/userdata/accounts/`
- shares everything else (chats, `config.toml`, skills, plugins) with your main `~/.codex`, so the
  new account behaves like the one you already use
- leaves your terminal's own Codex login alone

To remove an account, open its row and choose `Remove account`. Threadlines signs it out and deletes
its folder. Chats that used it stay, and can continue on another account.

## Which Account Am I Using?

Open Settings and look at the provider row. Threadlines shows the signed-in email for each account.
Emails are blurred by default; click the blurred email to reveal it.

In the model picker, each Codex account has its own tab, with how much of its usage limit is used
next to its name.

## Can I Switch Accounts In An Existing Thread?

Yes. Accounts added with `Add another Codex account` share your main Codex history, so a thread
moves between them and keeps its full conversation, for example when one account hits its limit.

A Codex setup with a completely different `CODEX_HOME path` keeps its own history. Switching a
thread to it still works, but Threadlines asks first: the new setup picks up from a recap of the
conversation.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Advanced: Set Up An Account By Hand

`Add another Codex account` is a shortcut for this setup, which you can still build yourself. It
uses one real Codex home and one "shadow home" for the second account's login:

```text
~/.codex      shared Codex home
~/.codex_p    second account's login
```

Log in to the second account with its own home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

Then add a Codex provider instance (`+` -> `Custom instance…`) with:

```text
Display name: Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

Both providers must use the same `CODEX_HOME path`; only the second one has a `Shadow home path`.
Threadlines links the shadow home's shared entries back to `~/.codex` and keeps `auth.json`,
`models_cache.json` and `secrets` (Codex's encrypted login store) private to the account. When you
choose your own shadow home folder, removing the account leaves that folder and its login alone.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json` (or its own `secrets` folder).
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json` and
   `secrets`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 -maxdepth 1 ! -name auth.json ! -name secrets -exec rm -rf {} +
```
