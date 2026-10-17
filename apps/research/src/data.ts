import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { getFunctionName } from "convex/server";
import { errorText } from "./state";

export function useRead<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | null,
) {
  const client = useConvex();
  // Generated Convex API proxies are not referentially stable across reads.
  // A subscription is identified by function name and arguments, not proxy identity.
  const queryName = getFunctionName(query);
  const key = JSON.stringify([queryName, args]);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: FunctionReturnType<Q>;
    error?: string;
  }>({ key: "" });
  useEffect(() => {
    if (args === null) return;
    let active = true;
    const watch = client.watchQuery(query, args);
    const read = () => {
      if (!active) return;
      try {
        const data = watch.localQueryResult();
        if (data !== undefined) setResult({ key, data });
      } catch (error) {
        setResult({ key, error: errorText(error) });
      }
    };
    const unsubscribe = watch.onUpdate(read);
    read();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, queryName, key, version]);
  return {
    data: result.key === key ? result.data : undefined,
    error: result.key === key ? result.error : undefined,
    refresh: () => setVersion((v) => v + 1),
  };
}

export function usePages<Q extends FunctionReference<"query">>(
  query: Q,
  args: Omit<FunctionArgs<Q>, "paginationOpts"> | null,
) {
  const client = useConvex();
  const queryName = getFunctionName(query);
  const key = JSON.stringify([queryName, args]);
  const epoch = useRef(0);
  type Page =
    FunctionReturnType<Q> extends { page: infer R extends unknown[] }
      ? R
      : never;
  const [state, setState] = useState<{
    key: string;
    rows: Page;
    cursor: string | null;
    done: boolean;
    loading: boolean;
    error?: string;
  }>({
    key: "",
    rows: [] as unknown as Page,
    cursor: null,
    done: false,
    loading: false,
  });
  const load = useCallback(
    async (reset: boolean) => {
      if (args === null) return;
      const generation = ++epoch.current;
      const old = state.key === key ? state : null;
      const cursor = reset ? null : (old?.cursor ?? null);
      setState((s) => ({
        ...s,
        key,
        rows: reset ? ([] as unknown as Page) : s.rows,
        loading: true,
        error: undefined,
      }));
      try {
        const response = await client.query(query, {
          ...args,
          paginationOpts: { numItems: 25, cursor },
        } as FunctionArgs<Q>);
        if (generation !== epoch.current) return;
        setState({
          key,
          rows: (reset
            ? response.page
            : [...(old?.rows ?? []), ...response.page]) as Page,
          cursor: response.continueCursor,
          done: response.isDone,
          loading: false,
        });
      } catch (error) {
        if (generation === epoch.current)
          setState((s) => ({
            ...s,
            key,
            loading: false,
            error: errorText(error),
          }));
      }
    },
    [client, queryName, key, state],
  );
  useEffect(() => {
    void load(true);
    return () => {
      epoch.current++;
    };
  }, [key, queryName]);
  return {
    rows: state.key === key ? state.rows : ([] as unknown as Page),
    done: state.key === key && state.done,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : undefined,
    more: () => load(false),
    refresh: () => load(true),
  };
}
