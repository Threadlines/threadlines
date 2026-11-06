# Composer footer and shared AI settings

`ComposerFooter.tsx` composes the existing attachment, model, voice, usage and send
slots around the AI settings toolbar. `AiProviderSettings.tsx` is the thin React
adapter for the framework-neutral `createAiSettings` control. Its native model
picker remains a React slot; Threadlines still owns descriptor discovery, account
routing, permissions and persistence through `traitControls.ts`.

The same adapter renders `ModelPickerSettings` and `TraitsPicker` for model
panels, settings and review dialogs. Effort choices, speed and all other options
come from the current model's reported descriptors. On narrow panes the toolbar
wraps, so each setting stays reachable. `composer-footer.css` owns only the outer
footer layout; `ai-provider-settings.css` maps Threadlines theme tokens.

The shared owner is `F:/www/shared/app-core/packages/ui/src/ai-settings`.
The pinned source distribution lives in `apps/web/src/lib/vendor/ai-settings`.
Follow its `source.json` receipt and the [owner's maintenance guide](F:/www/shared/app-core/docs/ai-settings.md) to update it.
Never edit the consumer copy: regenerate it from a verified owner revision, then
run the update verification and Threadlines checks. CTM consumes the same files
through its own vanilla adapter.

Run from the repository root with `node_modules/.bin` on PATH:

```powershell
vp fmt
vp lint
vp run typecheck
vp run --cache '@threadlines/web#test' composerProviderState
vp run --cache '@threadlines/web#test:browser'
```

`ChatView.turns.browser.tsx` verifies narrow layouts, shared model-panel controls,
keyboard focus, settings persistence and reversible effort/speed changes. Room
and sending coverage stays in the existing agents and composer browser suites.
