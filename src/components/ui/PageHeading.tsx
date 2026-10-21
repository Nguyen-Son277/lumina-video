import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

export interface PageHeadingProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'section' | 'div' | 'header'
  title?: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  eyebrowDot?: boolean
  headingLevel?: 1 | 2
  /** Supply the exact legacy introduction node instead of generated markup. */
  intro?: ReactNode
  /** A direct sibling; callers retain their existing action wrapper. */
  actions?: ReactNode
}

export const PageHeading = forwardRef<HTMLElement, PageHeadingProps>(function PageHeading(
  { as: Root = 'section', className = 'page-heading', title, description, eyebrow, eyebrowDot = true, headingLevel = 1, intro, actions, children, ...props }, ref,
) {
  const Heading = headingLevel === 2 ? 'h2' : 'h1'
  return <Root {...props} ref={ref as never} className={className}>
    {intro ?? <div>
      {eyebrow != null && <div className="eyebrow">{eyebrowDot && <span className="eyebrow-dot" />} {eyebrow}</div>}
      {title != null && <Heading>{title}</Heading>}
      {description != null && <p>{description}</p>}
    </div>}
    {actions}
    {children}
  </Root>
})
