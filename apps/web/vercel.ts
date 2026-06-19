import { existsSync } from "node:fs";
import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

const ROUTER_HOST = "app.threadlines.dev";
const HOSTED_WEB_CHANNEL_COOKIE = "threadlines_web_channel";
const LATEST_ORIGIN = "https://latest.app.threadlines.dev";
const NIGHTLY_ORIGIN = "https://nightly.app.threadlines.dev";
const RUNNING_FROM_REPO_ROOT = existsSync("apps/web/package.json");
const WEB_OUTPUT_DIRECTORY = RUNNING_FROM_REPO_ROOT ? "apps/web/dist" : "dist";
const BRAND_ASSETS_SCRIPT = RUNNING_FROM_REPO_ROOT
  ? "scripts/apply-web-brand-assets.ts"
  : "../../scripts/apply-web-brand-assets.ts";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand: `turbo build --filter @t3tools/web && bun ${BRAND_ASSETS_SCRIPT} --channel "\${VITE_HOSTED_APP_CHANNEL:-latest}"`,
  git: {
    deploymentEnabled: false,
  },
  outputDirectory: WEB_OUTPUT_DIRECTORY,
  installCommand:
    "bun add -g turbo && bun install --filter '@t3tools/contracts' --filter '@t3tools/client-runtime' --filter '@t3tools/scripts' --filter '@t3tools/web'",
  routes: [
    {
      src: "/__threadlines/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__threadlines/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${NIGHTLY_ORIGIN}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST)],
      dest: `${LATEST_ORIGIN}/$1`,
    },
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
