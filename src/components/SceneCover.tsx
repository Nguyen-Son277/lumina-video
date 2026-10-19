import { useState } from 'react'
import { Play } from 'lucide-react'

export { latestSceneVideo, sceneVideoCoverUrl } from '../../shared/sceneCover'

export type SceneCoverProps = {
  videoUrl: string | null
  illustrationUrl: string | null
  alt: string
  badge: string
}

/** Video cover, falling back to the scene illustration and then a play placeholder. */
export function SceneCover(props: SceneCoverProps) {
  const key = JSON.stringify([props.videoUrl, props.illustrationUrl])
  return <SceneCoverMedia key={key} {...props} />
}

function SceneCoverMedia({ videoUrl, illustrationUrl, alt, badge }: SceneCoverProps) {
  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null)
  const [failedIllustrationUrl, setFailedIllustrationUrl] = useState<string | null>(null)
  const showVideo = Boolean(videoUrl && failedVideoUrl !== videoUrl)
  const showIllustration = Boolean(illustrationUrl && failedIllustrationUrl !== illustrationUrl)

  if (showVideo) {
    return <video src={videoUrl!} muted preload="metadata" aria-label={alt} onError={() => setFailedVideoUrl(videoUrl)} />
  }
  if (showIllustration) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <img src={illustrationUrl!} alt={alt} loading="lazy" onError={() => setFailedIllustrationUrl(illustrationUrl)} />
        <span
          style={{
            position: 'absolute',
            left: 6,
            bottom: 6,
            padding: '2px 6px',
            borderRadius: 6,
            background: 'rgba(12, 13, 16, .82)',
            color: '#e4d9c6',
            fontSize: 9,
            lineHeight: 1.4,
          }}
        >
          {badge}
        </span>
      </div>
    )
  }
  return <Play className="project-scene-cover-placeholder" size={20} />
}

export default SceneCover
