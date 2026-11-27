import { useEffect, useRef } from "react";

interface FetcherLike<T> {
  state: "idle" | "submitting" | "loading";
  data: T | undefined;
}

/**
 * Runs `onResult` exactly once for each submission a fetcher finishes.
 *
 * A fetcher keeps its last `data` forever, and passes through "submitting"
 * then "loading" before it is "idle" again. An effect that reads `data` while
 * idle therefore fires again on every later render (a dialog reopened for
 * another row closes itself), and one that waits for "submitting" directly
 * followed by "idle" never fires at all. This tracks the one thing that is
 * reliable: the fetcher was busy, and now it is not.
 */
export function useFetcherResult<T>(fetcher: FetcherLike<T>, onResult: (data: T) => void): void {
  const wasBusy = useRef(false);
  const callback = useRef(onResult);
  callback.current = onResult;

  useEffect(() => {
    if (fetcher.state !== "idle") {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (fetcher.data !== undefined) callback.current(fetcher.data);
  }, [fetcher.state, fetcher.data]);
}
