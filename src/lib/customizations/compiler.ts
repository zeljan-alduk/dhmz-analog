"use client";

import * as React from "react";
import { transform } from "sucrase";
import type { DhmzHost } from "./host-api";

/**
 * Compile a JSX/TSX source string into a React component.
 *
 * Convention: the source must define a top-level function (or const) named
 * `Component` that accepts `{ host: DhmzHost }` and returns JSX.
 *
 *   function Component({ host }) {
 *     const [n, setN] = host.React.useState(0);
 *     return <button onClick={() => setN(n + 1)}>{n}</button>;
 *   }
 *
 * The compiled snippet is wrapped in a `new Function('React', ...)` so it
 * can use JSX (which Sucrase has lowered to `React.createElement`) without
 * an explicit `import React from 'react'`. The result is cached by source
 * string — repeated mounts of the same JSX are zero-cost.
 *
 * Errors (syntax or runtime) propagate to the caller, who should render an
 * error fallback in the slot rather than crashing the host.
 */

const CACHE = new Map<string, React.ComponentType<{ host: DhmzHost }>>();

export class CustomizationCompileError extends Error {
  constructor(message: string, public readonly source: string) {
    super(message);
    this.name = "CustomizationCompileError";
  }
}

export function compileJsxToComponent(
  source: string
): React.ComponentType<{ host: DhmzHost }> {
  const cached = CACHE.get(source);
  if (cached) return cached;

  let transformed: string;
  try {
    transformed = transform(source, {
      transforms: ["jsx", "typescript"],
      production: true,
      jsxRuntime: "classic",
      jsxPragma: "React.createElement",
      jsxFragmentPragma: "React.Fragment",
    }).code;
  } catch (e) {
    throw new CustomizationCompileError(
      `JSX transform failed: ${(e as Error).message}`,
      source
    );
  }

  // The compiled snippet should end up defining `Component` in its scope.
  // The wrapper returns it. If the source happens to NOT define `Component`,
  // we throw with a clear message rather than silently mounting nothing.
  const wrapper = `${transformed}
;return (typeof Component !== "undefined") ? Component : null;`;

  let factory: (R: typeof React) => React.ComponentType<{ host: DhmzHost }> | null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    factory = new Function("React", wrapper) as typeof factory;
  } catch (e) {
    throw new CustomizationCompileError(
      `compile failed: ${(e as Error).message}`,
      source
    );
  }

  let component: React.ComponentType<{ host: DhmzHost }> | null;
  try {
    component = factory(React);
  } catch (e) {
    throw new CustomizationCompileError(
      `module-init failed: ${(e as Error).message}`,
      source
    );
  }
  if (!component) {
    throw new CustomizationCompileError(
      "customization must define a top-level `Component` (function or const)",
      source
    );
  }
  CACHE.set(source, component);
  return component;
}

export function clearCompileCache(): void {
  CACHE.clear();
}
