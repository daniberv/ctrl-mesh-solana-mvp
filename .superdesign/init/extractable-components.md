# Layout components
## WorkspaceShell
- Source: web/index.html
- Category: layout
- Description: Internal application sidebar, navigation, header and footer.
- Extractable props: activeItem, accountHref
- Hardcoded: text wordmark ctrl-mesh, existing navigation labels and symbols.
- Not used on the public landing or account entry screens.
## LandingHeader / LandingFooter
- Source: web/landing.html
- Category: layout
- Description: New standalone public navigation, one page only.
- Extraction: unnecessary for this new single page target; no shared rendered landing components exist yet.
# Basic components
Button, Badge, RouteLink, native inputs and dialog from web/frontend.ts; use inline markup.
