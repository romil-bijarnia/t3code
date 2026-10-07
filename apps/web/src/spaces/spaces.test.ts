import { describe, expect, it } from "vite-plus/test";

import {
  childPagePath,
  isInsideSpacesFolder,
  isSpaceWorkspaceRoot,
  isTrashedSpaceWorkspaceRoot,
  pageChildrenDir,
  pageParentPath,
  pagesFromEntries,
  pageTitle,
  safeFileName,
  trashRelativePath,
  uniqueName,
} from "./spaces";

describe("space roots", () => {
  it("matches folders directly inside ~/Spaces", () => {
    expect(isSpaceWorkspaceRoot("/Users/romil/Spaces/Uni")).toBe(true);
    expect(isSpaceWorkspaceRoot("/home/romil/Spaces/Job hunt/")).toBe(true);
    expect(isSpaceWorkspaceRoot("C:\\Users\\romil\\Spaces\\Uni")).toBe(true);
  });

  it("tells trashed spaces apart and keeps both out of the project tree", () => {
    const trashed = "/Users/romil/Spaces/.trash/2026-10-08T01-02-03-004Z/Uni";
    expect(isSpaceWorkspaceRoot(trashed)).toBe(false);
    expect(isTrashedSpaceWorkspaceRoot(trashed)).toBe(true);
    expect(isInsideSpacesFolder(trashed)).toBe(true);
    expect(isInsideSpacesFolder("/Users/romil/Spaces/Uni")).toBe(true);
    expect(isInsideSpacesFolder("/Users/romil/code/Spaces/Uni")).toBe(false);
  });

  it("leaves ordinary projects alone", () => {
    expect(isSpaceWorkspaceRoot("/Users/romil/Spaces")).toBe(false);
    expect(isSpaceWorkspaceRoot("/Users/romil/Spaces/Uni/pages")).toBe(false);
  });
});

describe("safeFileName", () => {
  it("drops characters a file system would reject and leading dots", () => {
    expect(safeFileName('  ..SIT313: "Web"/Dev?  ')).toBe("SIT313 Web Dev");
  });
});

describe("page paths", () => {
  it("nests subpages in a folder named after the parent", () => {
    expect(childPagePath("README.md", "Reading list")).toBe("pages/Reading list.md");
    expect(childPagePath("pages/Reading list.md", "Fiction")).toBe("pages/Reading list/Fiction.md");
    expect(pageChildrenDir("pages/Reading list/Fiction.md")).toBe("pages/Reading list/Fiction");
    expect(pageParentPath("pages/Reading list/Fiction.md")).toBe("pages/Reading list.md");
    expect(pageParentPath("pages/Reading list.md")).toBe("README.md");
    expect(pageTitle("pages/Reading list/Fiction.md")).toBe("Fiction");
  });

  it("falls back to Untitled for an empty title", () => {
    expect(childPagePath("README.md", "///")).toBe("pages/Untitled.md");
  });
});

describe("pagesFromEntries", () => {
  it("pairs files with their subpage folders and keeps folders without a file", () => {
    const pages = pagesFromEntries([
      { path: "pages/B.md", kind: "file" },
      { path: "pages/A.md", kind: "file" },
      { path: "pages/A", kind: "directory" },
      { path: "pages/Loose", kind: "directory" },
      { path: "pages/.keep", kind: "file" },
      { path: "pages/notes.txt", kind: "file" },
    ]);
    expect(pages).toEqual([
      { relativePath: "pages/A.md", title: "A", hasChildren: true },
      { relativePath: "pages/B.md", title: "B", hasChildren: false },
      { relativePath: "pages/Loose.md", title: "Loose", hasChildren: true },
    ]);
  });
});

describe("uniqueName", () => {
  it("numbers a taken name", () => {
    expect(uniqueName("Untitled", new Set(["Untitled", "Untitled 2"]))).toBe("Untitled 3");
    expect(uniqueName("Notes", new Set(["Untitled"]))).toBe("Notes");
  });
});

describe("trashRelativePath", () => {
  it("keeps the file name under a timestamped trash folder", () => {
    expect(trashRelativePath("files/scan.pdf", new Date("2026-10-08T01:02:03.004Z"))).toBe(
      ".trash/2026-10-08T01-02-03-004Z/scan.pdf",
    );
  });
});
