import { describe, expect, test } from "bun:test"
import * as path from "node:path"
import { normalizeProjectPath } from "../src/project-path"

function posix(value: string): string {
  return value.replace(/\\/g, "/")
}

describe("normalizeProjectPath", () => {
  test("resolves a relative path against the project root", () => {
    const projectRoot = path.resolve("fixture-project")
    expect(normalizeProjectPath(projectRoot, "src/a.ts")).toBe(
      `${posix(projectRoot)}/src/a.ts`,
    )
  })

  test("keeps an absolute path and only normalizes separators", () => {
    expect(normalizeProjectPath("D:/project", "/work/shared/a.ts")).toBe("/work/shared/a.ts")
    expect(normalizeProjectPath("D:/project", "D:\\other\\a.ts")).toBe("D:/other/a.ts")
    expect(normalizeProjectPath("", "C:\\other\\nested\\a.ts")).toBe("C:/other/nested/a.ts")
  })

  test("resolves .. lexically", () => {
    const projectRoot = path.resolve("fixture-project", "nested")
    expect(normalizeProjectPath(projectRoot, "../src/a.ts")).toBe(
      `${posix(path.dirname(projectRoot))}/src/a.ts`,
    )
    expect(normalizeProjectPath(projectRoot, "..")).toBe(posix(path.dirname(projectRoot)))
  })

  test("handles an empty project root", () => {
    expect(normalizeProjectPath("", "")).toBe("")
    expect(normalizeProjectPath("/project", "")).toBe("")
    expect(normalizeProjectPath("", "/absolute/file.ts")).toBe("/absolute/file.ts")
    expect(normalizeProjectPath("", "D:\\absolute\\file.ts")).toBe("D:/absolute/file.ts")
    // Without a root, a relative path must not be resolved against process.cwd().
    expect(normalizeProjectPath("", "src/a.ts")).toBe("src/a.ts")
  })

  test("converts backslashes and collapses duplicate slashes", () => {
    const projectRoot = path.resolve("fixture-project")
    expect(normalizeProjectPath(projectRoot, "src\\nested\\a.ts")).toBe(
      `${posix(projectRoot)}/src/nested/a.ts`,
    )
    expect(normalizeProjectPath(projectRoot, "src//nested///a.ts")).toBe(
      `${posix(projectRoot)}/src/nested/a.ts`,
    )
  })

  test("preserves a UNC prefix", () => {
    expect(normalizeProjectPath("", "\\\\server\\share\\dir\\a.ts")).toBe(
      "//server/share/dir/a.ts",
    )
    expect(normalizeProjectPath("", "//server//share///a.ts")).toBe("//server/share/a.ts")
  })

  test("already-normalized paths pass through unchanged", () => {
    expect(normalizeProjectPath("/project", "/project/src/a.ts")).toBe("/project/src/a.ts")
    expect(normalizeProjectPath("D:/project", "D:/project/src/a.ts")).toBe(
      "D:/project/src/a.ts",
    )
  })
})
