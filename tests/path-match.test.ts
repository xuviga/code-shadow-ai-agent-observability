import { describe, expect, test } from "bun:test"
import { normalizePathForMatch, pathMatches } from "../src/path-match"

describe("pathMatches", () => {
  test("matches everything for * and **", () => {
    expect(pathMatches("*", "src/a/b.ts")).toBe(true)
    expect(pathMatches("**", "C:/project/src/a.ts")).toBe(true)
  })

  test("supports ** across segments and * within one segment", () => {
    expect(pathMatches("src/**", "src/a/b.ts")).toBe(true)
    expect(pathMatches("src/**/*.ts", "src/a/b.ts")).toBe(true)
    expect(pathMatches("src/*.ts", "src/a.ts")).toBe(true)
    expect(pathMatches("src/*.ts", "src/a/b.ts")).toBe(false)
    expect(pathMatches("**/*.ts", "index.ts")).toBe(true)
    expect(pathMatches("**/*.ts", "src/deep/index.ts")).toBe(true)
  })

  test("treats a wildcard-free pattern as an exact path or directory prefix", () => {
    expect(pathMatches("src/auth.ts", "src/auth.ts")).toBe(true)
    expect(pathMatches("src/auth.ts", "src/auth.ts.bak")).toBe(false)
    expect(pathMatches("src/", "src/auth.ts")).toBe(true)
    expect(pathMatches("src", "src/auth.ts")).toBe(true)
  })

  test("normalizes Windows separators and strips the project root", () => {
    expect(normalizePathForMatch("src\\auth\\index.ts")).toBe("src/auth/index.ts")
    expect(pathMatches("src/**", "C:\\project\\src\\auth\\index.ts", "C:\\project")).toBe(true)
    expect(pathMatches("C:/project/src/**", "C:/project/src/auth/index.ts")).toBe(true)
  })

  test("normalizes casing on Windows", () => {
    const expected = process.platform === "win32"
    expect(pathMatches("SRC/Auth.ts", "src/auth.ts")).toBe(expected)
  })

  test("resolves ./ and .. so contract checks cannot be bypassed", () => {
    expect(normalizePathForMatch("./.env")).toBe(".env")
    expect(normalizePathForMatch("src/../.env")).toBe(".env")
    expect(normalizePathForMatch("./src/a.ts")).toBe("src/a.ts")
    expect(pathMatches(".env", "./.env")).toBe(true)
    expect(pathMatches(".env", "src/../.env")).toBe(true)
    expect(pathMatches("src/**", "./src/a.ts")).toBe(true)
    expect(pathMatches("src/**", "src/../src/a.ts")).toBe(true)
    expect(pathMatches("src/**", "../src/a.ts")).toBe(false)
    expect(pathMatches("C:/project/**", "C:/project/../other/file.ts")).toBe(false)
  })
})
