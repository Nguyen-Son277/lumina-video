/** A decorative mark beside the wordmark, or a labelled mark in the collapsed rail. */
export function BrandMark({ standalone = false }: { standalone?: boolean }) {
  return (
    <img
      className="brand-mark"
      src={`${import.meta.env.BASE_URL}brand/lumina-mark.svg`}
      width={32}
      height={32}
      alt={standalone ? 'Lumina Studio' : ''}
      draggable={false}
    />
  )
}
