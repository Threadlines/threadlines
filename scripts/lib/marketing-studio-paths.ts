import * as NodePath from "node:path";

export function resolveDefaultMarketingStudioRoot(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly publicDirectory?: string | undefined;
}): string {
  if (input.platform === "darwin") {
    return NodePath.posix.join("/Users", "Shared", "Threadlines Marketing Studio");
  }
  if (input.platform === "win32") {
    return NodePath.win32.join(
      input.publicDirectory && input.publicDirectory.length > 0
        ? input.publicDirectory
        : NodePath.win32.join(NodePath.win32.dirname(input.homeDirectory), "Public"),
      "Documents",
      "Threadlines Marketing Studio",
    );
  }
  return NodePath.posix.join("/tmp", "Threadlines Marketing Studio");
}

export function resolveMarketingStudioRoot(input: {
  readonly configuredRoot?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly homeDirectory?: string | undefined;
  readonly publicDirectory?: string | undefined;
}): string {
  const configuredRoot = input.configuredRoot?.trim();
  return NodePath.resolve(
    configuredRoot && configuredRoot.length > 0
      ? configuredRoot
      : resolveDefaultMarketingStudioRoot({
          platform: input.platform ?? process.platform,
          homeDirectory: input.homeDirectory ?? process.cwd(),
          publicDirectory: input.publicDirectory,
        }),
  );
}
