import { useCallback, useEffect, useRef, useState } from "react";
import type { AnimationSummary, StudioStatus } from "../../shared/api.js";

export interface StudioData {
  status: StudioStatus | undefined;
  /** Undefined until the first answer. */
  animations: AnimationSummary[] | undefined;
  refresh: () => void;
}

/** The server's status and the animations, refetched whenever the studio says something changed. */
export function useStudio(): StudioData {
  const [status, setStatus] = useState<StudioStatus>();
  const [animations, setAnimations] = useState<AnimationSummary[]>();
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    const { studio } = window.kynimo;
    void studio.status().then(
      (s) => {
        if (mine === generation.current) setStatus(s);
      },
      () => undefined,
    );
    void studio.listAnimations().then(
      (list) => {
        if (mine === generation.current) setAnimations(list);
      },
      () => {
        if (mine === generation.current) setAnimations((old) => old ?? []);
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    return window.kynimo.studio.onChanged(refresh);
  }, [refresh]);

  return { status, animations, refresh };
}
