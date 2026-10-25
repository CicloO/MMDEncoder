import { useEffect, useState } from "react";
import { createAlignmentTasks, type AlignmentTargets } from "./alignmentTasks";
import { invoke } from "./ipc";

export function useAlignmentTasks(prefix: string, targets: AlignmentTargets) {
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());
  const [tasks] = useState(() =>
    createAlignmentTasks({ request: invoke, prefix, changed: setActive }),
  );
  useEffect(() => tasks.retain(targets), [tasks, targets]);
  useEffect(() => () => tasks.cancelAll(), [tasks]);
  return { ...tasks, active };
}
