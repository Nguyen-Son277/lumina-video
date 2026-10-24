# Lead review findings — implementation agent must address before handoff

## Final requested review 11:45 for agent74e65b86
Your core9+extra3E2E pass noted. uploadScope still deterministic string at Studio591; fix ABA by monotonic revision on scope change so away+back stale upload can't attach. Also unexpected concurrent shared/imageControls edits NOT lead/children authorized—inspect preserve external changes, avoid overwrites. Lead no source writes while you own. Please finish and hand back, remaining risks explicit.

## New 11:38 review for agent74e65b86 (prior listed gaps may now be fixed)
- Studio selectLibraryReference auto setAllowTemporaryMedia(true) when selecting Agnes is NOT explicit opt-in. Require confirm explaining temporary public URL or existing checkbox consent before enabling. Provider reference selection must not silently enable publicity.
- HF same-slot subsequent selection currently adds chip+mention but replaces slot upload; prevent duplicate slot or remove previous slot binding/chip to keep preview truthful.
- uploadScope string currentId:mode:modelId lacks monotonic revision, switching away+back before completion ABA can accept stale upload; use incrementing scope revision captured per upload. image/upload finally setUploading false guard scope to not affect newer upload.
- Verify exact picker binding deletion leaves manual mentions unchanged; selected angle pin is immutable after queue.



CONTINUE IMPLEMENTATION; do NOT hand back yet. Your latest message reports approved functional gaps. Complete generic video upload/reference routing, picker chips/removal/angle selection, imagePurpose only item/location/logo + description UI, sync only locations with valid image, source badges/open-source. No detach/copy needed (not in approved scope). Parent cannot send_message you: tool says not found. Please explicitly READ these docs now and acknowledge via your next message.

Read AGENT_HANDOFF.md and IMPLEMENTATION_SCOPE.md (approved plan stored there; parent UUID send_message fails). No other source writers except your publication child.

Observed 11:16:
- locationSync currently creates source cards without any reference image, contrary approved 'at least1 image'. Filter sources by owned valid ref/views.
- planner+project same source dedup via real mapping not implemented yet; report if no reliable mapping, no name dedup.
- QuickLibraryPicker only inserts mention, no selection chips/removal/angle selection; approved needs these and video upload path (OpenAI explicit1/HF slot/Agnes gated).
- imagePurpose currently includes character; approved only none/item/location/logo. remove character from purpose UI/schema unless intentionally requesting scope expansion (not authorized yet). optional description missing UI.
- library title labels need scenery added not just enum.
- scene source badge/open-source linked readonly explain UI, multi-view ref retention and snapshot choose angle must be verified.

More audit: generic video upload async lacks revision/abort guard across session/mode switch (Studio1019); description schema max8000 inconsistent library max5000; source hard-deleted cards retain all views indefinitely, must release when no live retained snapshots after lifecycle policy, not leak storage forever.

Additional read-only audit confirmed: publication naming lacks multioutput ·1 suffix; Common status/retry lacks link to target card. Source handle editing MUST remain allowed per approved plan (latest agent message says made readonly; undo that restriction only, keep metadata readonly). Generic video upload now exists but picker library refs must route actual selected image, not just description-only mention when input can be sent. Read source docs, your transcript inheritance is incomplete.

Do not stop at compiling partial implementation. Full approved scope is in docs above. Run robust backend+E2E tests. Explicitly state any gaps in result.
