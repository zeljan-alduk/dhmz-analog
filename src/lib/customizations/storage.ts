"use client";

import type { Customization, SavedVersion } from "./types";

/**
 * localStorage-backed version library for customizations. One array under a
 * single key — at the volumes we'd realistically see (tens to low hundreds of
 * versions per user), this is cheaper to read/write whole than to split into
 * per-version keys.
 */

const KEY = "dhmz/customizations/v1";

function readAll(): SavedVersion[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SavedVersion[];
  } catch {
    return [];
  }
}

function writeAll(versions: SavedVersion[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(versions));
  } catch (e) {
    console.warn("[customizations] localStorage write failed", e);
  }
}

function newId(): string {
  // Short URL-safe random — distinct enough for per-user version lists.
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined") crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function listVersions(): SavedVersion[] {
  // Newest first.
  return [...readAll()].sort((a, b) => b.ts - a.ts);
}

export function saveVersion(
  name: string,
  customization: Customization,
  opts?: { remoteId?: string }
): SavedVersion {
  const v: SavedVersion = {
    id: newId(),
    name: name.trim() || "untitled",
    ts: Math.floor(Date.now() / 1000),
    css: customization.css,
    slots: customization.slots,
    remoteId: opts?.remoteId,
  };
  const all = readAll();
  all.push(v);
  writeAll(all);
  return v;
}

export function deleteVersion(id: string): void {
  writeAll(readAll().filter((v) => v.id !== id));
}

export function deleteAllVersions(): void {
  writeAll([]);
}

export function updateVersion(
  id: string,
  patch: Partial<SavedVersion>
): SavedVersion | null {
  const all = readAll();
  const idx = all.findIndex((v) => v.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch, id: all[idx].id };
  writeAll(all);
  return all[idx];
}
