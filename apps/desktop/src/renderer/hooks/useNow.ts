import { useEffect, useState } from "react";
import { now } from "../lib/clock.js";

/** The current time, refreshed every `ms`. */
export function useNow(ms: number): number {
  const [value, setValue] = useState(now);
  useEffect(() => {
    setValue(now());
    const timer = setInterval(() => setValue(now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return value;
}
