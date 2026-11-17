import { useCallback, useEffect } from "react";
import type { HydrantPreferences } from "@types";
import { setHydrantPreferences } from "@renderer/features";

import { useAppDispatch, useAppSelector } from "./redux";

export function useHydrantPreferences() {
  const dispatch = useAppDispatch();
  const preferences = useAppSelector((state) => state.hydrantPreferences.value);

  useEffect(() => {
    let cancelled = false;

    window.electron
      .getHydrantPreferences()
      .then((value) => {
        if (!cancelled) dispatch(setHydrantPreferences(value));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const updatePreferences = useCallback(
    async (values: Partial<HydrantPreferences>) => {
      const updated = await window.electron.updateHydrantPreferences(values);
      dispatch(setHydrantPreferences(updated));
    },
    [dispatch]
  );

  return { preferences, updatePreferences };
}
