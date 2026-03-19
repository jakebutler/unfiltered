interface ResolveEndTurnInput {
  currentTaskIndex: number;
  totalTasks: number;
}

interface GetEndTurnLabelInput {
  taskIndex: number;
  totalTasks: number;
}

export interface EndTurnResolution {
  shouldCompleteSession: boolean;
  nextTaskIndex: number;
  isFinalTask: boolean;
}

function isFinalTask(taskIndex: number, totalTasks: number): boolean {
  if (totalTasks <= 0) return true;
  return taskIndex >= totalTasks - 1;
}

export function resolveEndTurn(input: ResolveEndTurnInput): EndTurnResolution {
  const finalTask = isFinalTask(input.currentTaskIndex, input.totalTasks);
  if (finalTask) {
    return {
      shouldCompleteSession: true,
      nextTaskIndex: input.currentTaskIndex,
      isFinalTask: true,
    };
  }

  return {
    shouldCompleteSession: false,
    nextTaskIndex: input.currentTaskIndex + 1,
    isFinalTask: false,
  };
}

export function getEndTurnLabel(input: GetEndTurnLabelInput): "Next task" | "Finish" {
  return isFinalTask(input.taskIndex, input.totalTasks) ? "Finish" : "Next task";
}
