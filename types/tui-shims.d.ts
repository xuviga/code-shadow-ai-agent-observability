// Minimal ambient declarations for the standalone TUI panel. The real TUI host
// provides @opentui/solid and solid-js at runtime; they are not build-time
// dependencies of the plugin package.

declare module "solid-js" {
  export function createSignal<T>(initial: T): [() => T, (value: T | ((prev: T) => T)) => T]
  export function createSignal<T = undefined>(): [() => T | undefined, (value: T) => T]
  export function onMount(...args: any[]): any
  export function onCleanup(...args: any[]): any
  export function createMemo(...args: any[]): any
  export function createEffect(...args: any[]): any
}

declare module "@opentui/solid" {
  export namespace JSX {
    interface Element {
      [key: string]: any
    }
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicAttributes {
      [key: string]: any
    }
    interface IntrinsicElements {
      [element: string]: any
    }
  }
}

declare module "@opentui/solid/jsx-runtime" {
  export const jsx: any
  export const jsxs: any
  export const Fragment: any
  export namespace JSX {
    interface Element {
      [key: string]: any
    }
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicAttributes {
      [key: string]: any
    }
    interface IntrinsicElements {
      [element: string]: any
    }
  }
}

declare namespace JSX {
  interface Element {
    [key: string]: any
  }
  interface ElementChildrenAttribute {
    children: unknown
  }
  interface IntrinsicAttributes {
    [key: string]: any
  }
  interface IntrinsicElements {
    [element: string]: any
  }
}
