/**
 * Tiny pub/sub for "is a fullscreen-ish overlay open right now?", used
 * by the floating Vocence Assistant launcher to step out of the way when
 * the Agent Architect drawer takes the right side of the screen.
 */

import { useEffect, useState } from 'react';

let _architectOpen = false;
const listeners = new Set<(v: boolean) => void>();

export function setArchitectOpen(v: boolean): void {
  if (v === _architectOpen) return;
  _architectOpen = v;
  listeners.forEach((l) => l(v));
}

export function useArchitectOpen(): boolean {
  const [v, setV] = useState(_architectOpen);
  useEffect(() => {
    listeners.add(setV);
    setV(_architectOpen);
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}
