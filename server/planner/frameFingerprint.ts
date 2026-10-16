import { fingerprintImageInput } from './imageTasks'
import type { StoryboardInputs } from './storyboard'

/** Ignore batch-only title/context metadata so single and batch tasks share a stamp. */
export function frameImageFingerprint(input: StoryboardInputs): string {
  return fingerprintImageInput({ prompt: input.prompt, sourceUploadIds: input.sourceUploadIds,
    sourceRoles: input.sourceRoles, locationId: input.locationId, locationRevision: input.locationRevision,
    characterRevisions: input.characterRevisions })
}
