#!/usr/bin/env node

import { main } from "./build-desktop-artifact.mjs";

main(["--platform", "mac", "--target", "dmg", ...process.argv.slice(2)]).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[desktop-dmg] ${message}`);
  process.exit(1);
});
