# Vercel Projects

This repository is connected to multiple Vercel projects. Keep their project
roots separate so unrelated commits do not trigger the marketing site build.

## `threadlines-app`

- Root Directory: repository root
- Config: `vercel.json`
- Purpose: hosted app shell for `app.threadlines.dev`
- Every address falls back to `index.html` except `/assets/`. A tab opened
  before a deploy asks for build files the deploy replaced; a 404 lets it see
  it is out of date and reload (`apps/web/src/staleBuild.ts`), where the app
  page in their place would fail as code with the wrong type.

## `threadlines`

- Root Directory: `apps/marketing`
- Config: `apps/marketing/vercel.json`
- Purpose: marketing site for `threadlines.dev` and `www.threadlines.dev`
- Build and Deployment setting: enable the Root Directory `Skip deployment`
  switch so Vercel skips this project when commits do not affect
  `apps/marketing` or its workspace dependencies.

The marketing project should not use the root `vercel.json`; that file is
intentionally configured for the hosted app shell.
