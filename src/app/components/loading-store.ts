"use client";

import { create } from "zustand";

type LoadingState = {
  visible: boolean;
  startedAt: number | null;
  minDurationMs: number;
  show: (opts?: { minDurationMs?: number }) => void;
  hide: () => void;
};

export const useLoadingStore = create<LoadingState>((set, get) => ({
  visible: false,
  startedAt: null,
  minDurationMs: 600,
  show: (opts) => set({ visible: true, startedAt: Date.now(), minDurationMs: opts?.minDurationMs ?? 600 }),
  hide: () => {
    const { startedAt, minDurationMs } = get();
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const wait = Math.max(0, minDurationMs - elapsed);
    window.setTimeout(() => set({ visible: false, startedAt: null }), wait);
  },
}));


