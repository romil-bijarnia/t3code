import { describe, expect, it } from "vite-plus/test";

import {
  isSpaceWorkspaceRoot,
  pageRelativePath,
  pageTitle,
  safeFileName,
  trashRelativePath,
  uniqueName,
} from "./spaces";

describe("isSpaceWorkspaceRoot", () => {
  it("matches folders directly inside ~/Spaces", () => {
    expect(isSpaceWorkspaceRoot("/Users/romil/Spaces/Uni")).toBe(true);
    expect(isSpaceWorkspaceRoot("/home/romil/Spaces/Job hunt/")).toBe(true);
    expect(isSpaceWorkspaceRoot("C:\\Users\\romil\\Spaces\\Uni")).toBe(true);
  });

  it("leaves ordinary projects alone", () => {
    expect(isSpaceWorkspaceRoot("/Users/romil/Spaces")).toBe(false);
    expect(isSpaceWorkspaceRoot("/Users/romil/Spaces/Uni/pages")).toBe(false);
    expect(isSpaceWorkspaceRoot("/Users/romil/code/Spaces/Uni")).toBe(false);
  });
});

describe("safeFileName", () => {
  it("drops characters a file system would reject and leading dots", () => {
    expect(safeFileName('  ..SIT313: "Web"/Dev?  ')).toBe("SIT313 Web Dev");
  });
});

describe("pages", () => {
  it("round-trips a title through its file path", () => {
    const path = pageRelativePath("Reading list");
    expect(path).toBe("pages/Reading list.md");
    expect(pageTitle(path)).toBe("Reading list");
  });

  it("falls back to Untitled for an empty title", () => {
    expect(pageRelativePath("///")).toBe("pages/Untitled.md");
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
