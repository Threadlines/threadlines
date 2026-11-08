# Composer footer and shared AI settings

`ComposerFooter.tsx` composes the existing attachment, model, voice, usage and send
slots around the AI settings toolbar. `AiProviderSettings.tsx` is the thin React
adapter for the framework-neutral `createAiSettings` control. Its native model
picker remains a React slot; Threadlines still owns descriptor discovery, account
routing, permissions and persistence through `traitControls.ts`.

The app bar uses the adapter's compact mode: effort shows its label only when
the measured toolbar content fits; Build/Plan shows only an icon.
Access keeps its icon and current label, and Fast shows a lightning icon
only while enabled. Other model options stay in the full editor.
Shortcut order is effort, access, Fast (when enabled), then Build/Plan last.
Menu choices carry their associated icons; the Build/Plan choice uses the same
glyph as its selected toolbar shortcut.
Effort colors are Low light blue, Medium blue,
High dark blue, Extra High orange, Max red and Ultra purple. Accessible names
retain the selected values and the menus retain their labels.

`ModelPickerSettings` keeps the original settings rows and effort meter rather
than duplicating the toolbar inside the model popup. `TraitsPicker` still uses
the shared full editor in settings and review dialogs. Options come from reported
capabilities and every change uses the existing persistence path.
`composer-footer.css` owns the footer layout; `ai-provider-settings.css` maps tokens.

Reuse decision: searched `AI settings` in the shared catalog. Extended the
portable `@app-core/ui/ai-settings` source with icon-only controls,
mode glyphs and effort tones. The model panel retains its original row/meter
interaction because a second toolbar changed that layout; descriptor and save
logic still come from `traitControls.ts`.
Effort's `iconOnly: 'auto'` uses the owner's content measurements and resize/font
notifications; there is no fixed window-width cutoff or measurement polling loop.

The complete pinned source lives in `apps/web/src/lib/vendor/ai-settings`.
Its `source.json` receipt records the shared owner, source path and SHA-256 hashes.
Building and running Threadlines needs no sibling checkout, external UI package,
or private service. Review the included JavaScript, declarations and CSS directly.
For shared-source updates, regenerate the snapshot from a reviewed owner revision,
update the receipt, and run the Threadlines checks. Keep the adapter and product
policy here; keep portable rendering and interaction in the shared source.

Run from the repository root with `node_modules/.bin` on PATH:

```powershell
vp fmt
vp lint
vp run typecheck
vp run --cache '@threadlines/web#test' composerProviderState
vp run --cache '@threadlines/web#test:browser'
```

`ChatView.turns.browser.tsx` verifies narrow layouts, original model-panel controls,
keyboard focus, settings persistence and reversible effort/speed changes. Room
and sending coverage stays in the existing agents and composer browser suites.
