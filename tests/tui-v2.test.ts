import { describe, expect, mock, test } from "bun:test"
import type { V2EventName } from "../src/tui-v2"

// `solid-js` is provided by the TUI host at runtime, not installed in this
// repository (types/tui-shims.d.ts only declares its types). The adapter's
// runtime import of @opencode/plugin/tui pulls it in, so stub it here.
mock.module("solid-js", () => ({
  createSignal: <T,>(initial: T) => [() => initial, (_next: T) => {}],
  onMount: (_fn: () => void) => {},
  onCleanup: (_fn: () => void) => {},
  createContext: (_initial?: unknown) => ({ Provider: {} }),
  useContext: (_context: unknown) => ({}),
  createComponent: (_component: unknown, _props: unknown) => ({}),
}))

const adapter = await import("../src/tui-v2")

type SlotClaimStub = {
  readonly append: "sidebar.content"
  readonly render: (input: unknown) => unknown
}

function createHarness() {
  const claims: SlotClaimStub[] = []
  const subscriptions: string[] = []
  let disposed = 0
  const context = {
    theme: {
      primary: { r: 124, g: 58, b: 237 },
      text: { r: 230, g: 237, b: 243 },
      textMuted: { r: 139, g: 148, b: 158 },
      success: { r: 63, g: 185, b: 80 },
      warning: { r: 210, g: 153, b: 34 },
      error: { r: 248, g: 81, b: 73 },
      border: { r: 48, g: 54, b: 61 },
    },
    location: { directory: "C:/code-shadow" },
    data: {
      on(type: string, _handler: () => void) {
        subscriptions.push(type)
        return () => {}
      },
    },
    ui: {
      slot(claim: SlotClaimStub) {
        claims.push(claim)
        return () => {
          disposed += 1
        }
      },
    },
  }
  return { context, claims, subscriptions, disposed: () => disposed }
}

describe("tui-v2 adapter", () => {
  test("register claims sidebar.content and dispose releases the host cleanup", () => {
    const harness = createHarness()
    const { api, dispose } = adapter.createPanelShim(harness.context)

    api.slots.register({ order: 700, slots: { sidebar_content: () => ({}) } })

    expect(harness.claims).toHaveLength(1)
    expect(harness.claims[0]?.append).toBe("sidebar.content")
    expect(harness.claims[0]?.render({ sessionID: "session-1" })).toEqual({})
    expect(harness.disposed()).toBe(0)

    dispose()
    expect(harness.disposed()).toBe(1)

    // The cleanup is drained, so a second dispose is a no-op.
    dispose()
    expect(harness.disposed()).toBe(1)
  })

  test("register ignores a slot plugin without sidebar_content", () => {
    const harness = createHarness()
    const { api } = adapter.createPanelShim(harness.context)

    api.slots.register({})

    expect(harness.claims).toHaveLength(0)
  })

  test("event.on subscribes only to the mapped V2 event names", () => {
    const harness = createHarness()
    const { api } = adapter.createPanelShim(harness.context)

    api.event.on("message.part.updated", () => {})

    expect(harness.subscriptions).toEqual(["session.text.delta", "session.reasoning.delta"])
  })

  test("command.executed maps to the V2 TUI command event", () => {
    const harness = createHarness()
    const { api } = adapter.createPanelShim(harness.context)

    const unsubscribe = api.event.on("command.executed", () => {})

    expect(harness.subscriptions).toEqual(["tui.command.execute"])
    expect(typeof unsubscribe).toBe("function")
  })

  test("mapTheme converts V2 RGBA tokens into the keys the panel reads", () => {
    expect(
      adapter.mapTheme({
        primary: { r: 124, g: 58, b: 237 },
        text: { r: 230, g: 237, b: 243 },
        textMuted: { r: 139, g: 148, b: 158 },
        success: { r: 63, g: 185, b: 80 },
        warning: { r: 210, g: 153, b: 34 },
        error: { r: 248, g: 81, b: 73 },
        border: { r: 48, g: 54, b: 61 },
      }),
    ).toEqual({
      primary: "#7c3aed",
      text: "#e6edf3",
      textMuted: "#8b949e",
      success: "#3fb950",
      warning: "#d29922",
      error: "#f85149",
      borderSubtle: "#30363d",
    })
  })

  test("mapTheme accepts normalized 0-1 channels and legacy nested strings", () => {
    expect(adapter.mapTheme({ text: { r: 1, g: 1, b: 1 } }).text).toBe("#ffffff")
    expect(adapter.mapTheme({ text: { base: "#010203" } }).text).toBe("#010203")
  })

  test("all eventMap targets belong to the public V2 event union", () => {
    const targets: ReadonlyArray<V2EventName> = Object.values(adapter.eventMap).flat()
    expect(targets.length).toBeGreaterThan(0)
    expect(targets).not.toContain("session.message.content.updated")
  })
})

// Compile-time negative probe: this line must keep failing `tsc`. If the SDK
// ever adds the name to OpenCodeEvent["type"], the directive below becomes
// unused and the probe fails — which is exactly when it should be revisited.
// @ts-expect-error — `session.message.content.updated` is not in OpenCodeEvent["type"].
const invalidTarget: V2EventName = "session.message.content.updated"
void invalidTarget
