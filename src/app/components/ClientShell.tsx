"use client";

import React from "react";
import { LoadingOverlay } from "./LoadingOverlay";
import { useLoadingStore } from "./loading-store";

export default function ClientShell({ children }: { children: React.ReactNode }) {
  const visible = useLoadingStore((s) => s.visible);
  return (
    <div className="relative z-10">
      {children}
      <LoadingOverlay visible={visible} />
    </div>
  );
}


