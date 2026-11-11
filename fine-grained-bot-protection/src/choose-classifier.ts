import { createArcjetClassifier } from '#src/arcjet-classifier';
import type { Classifier } from '#src/classifier';
import { userAgentClassifier } from '#src/user-agent-classifier';

/** Arcjet when there is a key for it, the User-Agent check otherwise. */
export function chooseClassifier(arcjetKey: string | undefined): Classifier {
  return arcjetKey === undefined ? userAgentClassifier : createArcjetClassifier(arcjetKey);
}
