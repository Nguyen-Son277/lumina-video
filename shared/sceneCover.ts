export type SceneVideo = {
  id: string;
  kind: string;
  sceneId?: string | null;
  createdAt: number;
  status: string;
  assets?: Array<{ mimeType: string; url: string }>;
};

/** Select the newest video for a scene, breaking timestamp ties by id. */
export function latestSceneVideo<T extends SceneVideo>(
  gens: readonly T[],
  sceneId: string,
): T | null {
  let latest: T | null = null;
  for (const gen of gens) {
    if (gen.kind !== "video" || gen.sceneId !== sceneId) continue;
    if (
      latest === null ||
      gen.createdAt > latest.createdAt ||
      (gen.createdAt === latest.createdAt && gen.id > latest.id)
    ) {
      latest = gen;
    }
  }
  return latest;
}

/** Return a usable video asset URL only for a successfully generated video. */
export function sceneVideoCoverUrl(video: SceneVideo | null | undefined): string | null {
  if (!video || video.kind !== "video" || video.status !== "succeeded") return null;
  const asset = video.assets?.find(
    ({ mimeType, url }) => mimeType.toLowerCase().startsWith("video/") && url.trim().length > 0,
  );
  return asset?.url ?? null;
}
