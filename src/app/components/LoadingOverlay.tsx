"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const MESSAGES = [
  "安岡が頑張っています",
  "ゴミ屋が頑張っています",
  "小玉が頑張っています",
  "東郷が頑張っています",
];

export function LoadingOverlay({ visible }: { visible: boolean }) {
  const [message, setMessage] = useState<string>("");
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const timerRef = useRef<number | null>(null);

  const stylePos = useMemo(() => ({ left: `${pos.x}%`, top: `${pos.y}%` }), [pos]);

  useEffect(() => {
    if (!visible) {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    // 初期表示
    setMessage(MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);
    setPos({ x: 10 + Math.random() * 80, y: 10 + Math.random() * 80 });
    // 周期的に差し替え
    timerRef.current = window.setInterval(() => {
      setMessage((prev) => {
        let next = prev;
        while (next === prev) next = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
        return next;
      });
      setPos({ x: 10 + Math.random() * 80, y: 10 + Math.random() * 80 });
    }, 1200);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-[1000] backdrop-blur-sm bg-gradient-to-br from-slate-50/80 to-sky-50/80 flex items-center justify-center"
    >
      {/* 粒子（控えめ） */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <span
            key={i}
            className="absolute w-1 h-1 bg-white/70 rounded-full animate-float"
            style={{
              left: `${(i * 13) % 100}%`,
              top: `${(i * 29) % 100}%`,
              animationDelay: `${i * 0.4}s`,
            }}
          />
        ))}
      </div>

      {/* 中央の星インジケータ */}
      <div className="relative flex flex-col items-center gap-4">
        <svg className="w-10 h-10 text-yellow-500 animate-spin-slow animate-pulse-soft" viewBox="0 0 24 24" fill="currentColor">
          <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
      </div>

      {/* ランダムテキスト */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 text-sm md:text-base text-slate-700/90 transition-opacity duration-300 animate-fade"
        style={stylePos}
      >
        {message}
      </div>
    </div>
  );
}


