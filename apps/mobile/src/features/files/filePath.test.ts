import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkspaceFileRoot,
  fileRoutePathSegments,
  isSvgImagePreviewFile,
  resolveWorkspaceRelativeFilePath,
  fileHeaderSubtitle,
} from "./filePath";

describe("fileRoutePathSegments", () => {
  it("round-trips workspace-relative and host paths through the route", () => {
    expect(fileRoutePathSegments("src/main.ts")).toEqual(["src", "main.ts"]);
    expect(fileRoutePathSegments("/tmp/t3-cleanup/report.md").join("/")).toBe(
      "/tmp/t3-cleanup/report.md",
    );
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("keeps normalized workspace-relative paths", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "./src/../src/main.ts")).toBe("src/main.ts");
  });

  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "/repo/../outside.txt")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("file preview types", () => {
  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
  });
});

describe("fileHeaderSubtitle", () => {
  it("places a workspace file under its project", () => {
    expect(
      fileHeaderSubtitle("t3code", "apps/mobile/src/features/threads/fileChipMenu.test.ts"),
    ).toBe("t3code · apps/mobile/src/features/threads");
  });

  it("shows only the directory for a host file outside the workspace", () => {
    // It is not under the project, so naming the project there would be a lie.
    expect(fileHeaderSubtitle("t3code", "/tmp/report.md")).toBe("/tmp");
  });

  it("shows only the project for a file at the workspace root", () => {
    expect(fileHeaderSubtitle("t3code", "README.md")).toBe("t3code");
  });
});

it("selects frozen named roots for external and nested mentions while preserving explicit aliases", () => {
  const roots = [
    { id: "meta", name: "Meta", path: "/repo" },
    { id: "child", name: "Child", path: "/repo/child" },
    { id: "external", name: "External", path: "/external" },
    { id: "alias", name: "Alias", path: "/external" },
  ];
  expect(resolveWorkspaceFileRoot(roots, "/repo/child/same.ts", null)?.id).toBe("child");
  expect(resolveWorkspaceFileRoot(roots, "/external/same.ts", null)?.id).toBe("external");
  expect(resolveWorkspaceFileRoot(roots, "same.ts", "alias")?.id).toBe("alias");
  expect(resolveWorkspaceFileRoot(roots, "/external-other/same.ts", null)).toBeNull();
  expect(resolveWorkspaceFileRoot(roots, "/external/../outside.ts", null)).toBeNull();
  expect(resolveWorkspaceFileRoot(roots, "/external/same.ts", "removed")).toBeNull();
});
