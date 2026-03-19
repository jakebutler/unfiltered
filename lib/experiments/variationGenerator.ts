import { getDecisionEngineOrThrow, type DecisionEngineId } from "./decisionEngineRegistry";

export interface VariationSeed<TStudyId extends string = string> {
  index: number;
  studyId: TStudyId;
  decisionEngineIdTarget: DecisionEngineId;
  decisionEngineIdAssigned: DecisionEngineId;
  repeatIndex: number;
}

export interface VariationGeneratorInput<TStudyId extends string = string> {
  studyIds: TStudyId[];
  decisionEngineIds: string[];
  repeatsPerCell: number;
}

export function generateVariationMatrix<TStudyId extends string>(
  input: VariationGeneratorInput<TStudyId>,
): VariationSeed<TStudyId>[] {
  const repeatsPerCell = Math.max(1, Math.floor(input.repeatsPerCell));
  const normalizedStudyIds = input.studyIds.filter(Boolean);
  const normalizedEngineIds = input.decisionEngineIds
    .map((engineId) => getDecisionEngineOrThrow(engineId).id)
    .filter(Boolean);

  const rows: VariationSeed<TStudyId>[] = [];
  let index = 1;

  for (const studyId of normalizedStudyIds) {
    for (const decisionEngineId of normalizedEngineIds) {
      for (let repeatIndex = 1; repeatIndex <= repeatsPerCell; repeatIndex += 1) {
        rows.push({
          index,
          studyId,
          decisionEngineIdTarget: decisionEngineId,
          decisionEngineIdAssigned: decisionEngineId,
          repeatIndex,
        });
        index += 1;
      }
    }
  }

  return rows;
}
