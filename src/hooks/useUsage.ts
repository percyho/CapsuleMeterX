import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_USAGE, type UsageSnapshot } from "../types/usage";

export function useUsage(): UsageSnapshot {
  const [usage, setUsage] = useState<UsageSnapshot>(EMPTY_USAGE);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<UsageSnapshot>("usage-updated", (event) => {
      if (!disposed) setUsage(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    void invoke<UsageSnapshot>("get_usage_snapshot")
      .then((snapshot) => {
        if (!disposed) setUsage(snapshot);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return usage;
}
