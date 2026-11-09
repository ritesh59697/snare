import { useCallback, useEffect, useRef, useState } from "react";
import type { Outcome } from "../lib/outcome";

const STEP_MS = 240;

/** Walks a raider along a route one tile at a time, stopping where the raid actually ended. */
export function usePlayback() {
  const [playing, setPlaying] = useState<Outcome | null>(null);
  const [step, setStep] = useState(0);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  }, []);

  const play = useCallback(
    (o: Outcome) => {
      stop();
      setPlaying(o);
      setStep(0);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced || o.steps === 0) {
        setStep(o.steps);
        return;
      }
      timer.current = window.setInterval(() => {
        setStep((s) => {
          if (s + 1 >= o.steps) stop();
          return Math.min(s + 1, o.steps);
        });
      }, STEP_MS);
    },
    [stop],
  );

  const clear = useCallback(() => {
    stop();
    setPlaying(null);
    setStep(0);
  }, [stop]);

  useEffect(() => stop, [stop]);

  const done = playing !== null && step >= playing.steps;
  return { playing, step, done, play, clear };
}
