# Vercel Projects

This repository is connected to multiple Vercel projects. Keep their project
roots separate so unrelated commits do not trigger the marketing site build.

## `threadlines-app`

- Root Directory: repository root
- Config: `vercel.json`
- Purpose: hosted app shell for `app.threadlines.dev`

## `threadlines`

- Root Directory: `apps/marketing`
- Config: `apps/marketing/vercel.json`
- Purpose: marketing site for `threadlines.dev` and `www.threadlines.dev`
- Build and Deployment setting: enable the Root Directory `Skip deployment`
  switch so Vercel skips this project when commits do not affect
  `apps/marketing` or its workspace dependencies.

The marketing project should not use the root `vercel.json`; that file is
intentionally configured for the hosted app shell.
