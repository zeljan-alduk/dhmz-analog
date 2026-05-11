"use client";

import React, { useMemo } from "react";
import {
  compileJsxToComponent,
  CustomizationCompileError,
} from "./compiler";
import { useDhmzHost } from "./host-api";
import type { Customization, SlotId } from "./types";

/**
 * Renders a customization slot. Looks up the (optional) mount for `slotId`
 * on the supplied customization, compiles its JSX once, and renders the
 * component with the live `host` prop. If compile or render fails, shows a
 * compact red-bordered error chip with the message so the user understands
 * why their slot is empty.
 *
 * Rendering nothing when the slot is unmounted means slots are pay-as-you-go:
 * 0 cost when no customization is active.
 */
export function CustomizationSlot({
  slot,
  customization,
}: {
  slot: SlotId;
  customization: Customization | null | undefined;
}) {
  const host = useDhmzHost();
  const mount = customization?.slots?.[slot];

  const Compiled = useMemo<
    | { Component: React.ComponentType<{ host: ReturnType<typeof useDhmzHost> }> }
    | { error: Error }
    | null
  >(() => {
    if (!mount) return null;
    try {
      return { Component: compileJsxToComponent(mount.jsx) };
    } catch (e) {
      return { error: e as Error };
    }
  }, [mount]);

  if (!mount || !Compiled) return null;
  if ("error" in Compiled) {
    const err = Compiled.error;
    const detail =
      err instanceof CustomizationCompileError
        ? err.message
        : `${err.name}: ${err.message}`;
    return (
      <div
        role="alert"
        className="inline-block px-2 py-1 text-[11px] font-mono bg-red-50 border border-red-300 text-red-800 rounded"
        title={detail}
      >
        slot[{slot}] {mount.name}: compile error
      </div>
    );
  }

  return (
    <SlotErrorBoundary slot={slot} name={mount.name}>
      <Compiled.Component host={host} />
    </SlotErrorBoundary>
  );
}

class SlotErrorBoundary extends React.Component<
  { children: React.ReactNode; slot: string; name: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[customization slot error]", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="inline-block px-2 py-1 text-[11px] font-mono bg-red-50 border border-red-300 text-red-800 rounded"
          title={this.state.error.message}
        >
          slot[{this.props.slot}] {this.props.name}: render error
        </div>
      );
    }
    return this.props.children as React.ReactElement;
  }
}

/**
 * Apply the CSS portion of a customization to the document head. Returns a
 * cleanup function. Use inside an effect; one `<style>` tag per app.
 */
export function applyCustomizationCss(css: string | undefined | null): () => void {
  const id = "dhmz-cust-css";
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!css || !css.trim()) {
    if (style) style.remove();
    return () => {
      const el = document.getElementById(id);
      if (el) el.remove();
    };
  }
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = css;
  return () => {
    const el = document.getElementById(id);
    if (el) el.remove();
  };
}
