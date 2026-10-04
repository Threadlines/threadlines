# Antigravity

Antigravity is Google's coding agent. Threadlines downloads and checks Google's own Antigravity
server for you (`Install` on the Antigravity row in `Settings -> Providers`), so there is nothing to
install by hand.

## Sign-In Methods

Open `Settings -> Providers`, open the Antigravity row, and pick a method under `Sign-in method` on
the `Account` tab.

| Method            | Who pays                                         | What you need                                           |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Google account    | Your Google AI plan                              | A Google sign-in                                        |
| Gemini Enterprise | Your company's Gemini plan, through Google Cloud | A Google Cloud project and location, and a work sign-in |
| Gemini API key    | Per use, billed by Google                        | A key from Google AI Studio                             |
| Vertex AI         | Per use, billed to a Google Cloud project        | A project and location, or a Vertex AI express key      |

Google account is the default, and it's what `Sign in with Google` on the setup screen uses. The
setup screen's `Other ways` link opens the same choice in Settings.

Picking another method shows its fields and a `Switch` button. Switching saves the method, then
starts what the method needs: a Google sign-in for Gemini Enterprise, a key check for a Gemini API
key, a check of the project and Google Cloud sign-in for Vertex AI. Switching back to Google account
keeps its earlier sign-in, so it needs no new one.

Running chats stop when you switch, as with any change to a provider's settings.

### Per-Use Billing

With a Gemini API key or Vertex AI, Google bills every request to you. These requests don't show on
Threadlines' Usage page; check Google AI Studio or the Google Cloud console for spending.

### Where Keys Are Kept

Keys are saved like every other Threadlines secret: in a private file on the computer that runs
Threadlines (readable only by your user account), never in `settings.json`, and never sent back to
the app. Settings shows that a key is saved and, in the account line, its last four characters.
`Replace key` and `Remove key` are on the Account tab.

Each method keeps its own key (`GEMINI_API_KEY` for a Gemini API key, `GOOGLE_API_KEY` for a Vertex
AI express key), so switching never hands one method's key to the other. Keys set in your shell are
ignored: only the key saved on the provider is used.

### Checking a Key

`Check key` asks Google whether it accepts a Gemini API key, with a request that costs nothing. A
key Google rejects shows as an error until you replace it. A key that passed the check can still
lack access to a model or run out of quota; the first chat tells you if so.

Vertex AI keys and Google Cloud sign-ins are only proven by a real request, so the row says
`Credential configured` until then.

### Vertex AI Without a Key

Without a key, Vertex AI uses the Google Cloud sign-in on the computer that runs Threadlines
(Application Default Credentials). Sign in once there:

```bash
gcloud auth application-default login
```

Threadlines looks where Google's tools look: `GOOGLE_APPLICATION_CREDENTIALS` if it is set (and only
there), otherwise the gcloud config folder (`CLOUDSDK_CONFIG`, else `~/.config/gcloud`, or
`%APPDATA%\gcloud` on Windows). If you use Threadlines from a phone or another computer, this is
the computer running the Threadlines server, not the device in your hand.

## Extra Accounts

`Add another Antigravity account` (the Antigravity row, or the `+` at the top of the page) adds a
second Antigravity with its own sign-in. Each account picks its own method, so one can use your
Google account and another a Gemini API key.

## Signing Out

Google account and Gemini Enterprise have `Sign out` on the Account tab. Key methods have
`Remove key` instead.
