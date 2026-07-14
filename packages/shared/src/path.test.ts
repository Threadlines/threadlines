import { describe, expect, it } from "vite-plus/test";
import {
  areFilesystemPathsEqual,
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  normalizeFilesystemPathForComparison,
} from "./path.ts";

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });

  it("normalizes filesystem paths according to their path shape", () => {
    expect(normalizeFilesystemPathForComparison(" C:/Work/Repo/ ")).toBe("c:\\work\\repo");
    expect(normalizeFilesystemPathForComparison("/Work/Repo/")).toBe("/Work/Repo");
    expect(normalizeFilesystemPathForComparison("/")).toBe("/");
  });

  it("compares equivalent Windows path spellings", () => {
    expect(areFilesystemPathsEqual("C:\\Work\\Repo", "c:/work/repo/")).toBe(true);
    expect(areFilesystemPathsEqual("C:\\Work\\Repo", "C:\\Work\\Other")).toBe(false);
  });
});
