# Shared location references

Each video region or stage can have **one reusable location reference**: an empty background image plus continuity notes. Frames assigned to that location send the same reference image together with the character portraits, so generated storyboards keep the same architecture, fixed objects, materials and lighting while the camera angle and acting still change.

## Workflow

1. **Draft script** — write the scenes.
2. **Characters** — prepare cast portraits.
3. **Locations** — add or let AI propose regions/stages, then generate, upload or attach one empty-background reference per location.
4. **Timeline** — assign each frame to a location, then generate a single frame or the whole batch.
5. **Lock to Studio** — session locations are copied into the project (`project_locations`), scenes keep `locationId`, and the per-scene storyboard image stays separate from the shared background reference.

## Ordering and limits

- Input images are sent as: **location reference first**, then character portraits in blocking order. The prompt states each image's role so the model does not copy people from the background.
- Reference count is never truncated silently. If the references exceed the configured input-image limit, generation is blocked before any provider call with the required number.
- A frame assigned to a location without a reference image is blocked with a clear message. Unassigned frames keep the previous behaviour but are flagged as possibly inconsistent.
- Batch snapshots freeze the location id, revision and input images at creation time; editing a location mid-batch does not change queued items.

## Continuity and staleness

- Editing a location (or replacing its reference) raises its `revision`. Frames that had a background generated from an older revision are marked **stale** so the user can regenerate them; the old image is never deleted automatically.
- Attaching a reference passes the expected revision, so a tab that started generating against an older revision cannot silently overwrite a newer reference.
- Deleting a location unassigns the frames/scenes that used it and keeps existing images.
- AI proposals are additive suggestions only; they never enqueue paid image generation.

## Scope

This step guarantees that the same reference image and continuity instructions are **sent** for every frame in a location. It does not guarantee an identical result; visual fidelity depends on the selected image model and provider. Video generation currently keeps its single character `input_reference`; the location is added as written continuity text there and the UI does not claim a background image was sent.
