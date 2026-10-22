# Plugin Catalog Grid Layout and Interaction Model

The Plugins Discover view previously used an 880px-constrained split pane with a 300px inspection rail that stayed empty until a plugin was clicked. We decided to replace this with a full-width responsive 2-column catalog grid grouped by category sections, with in-place action buttons, 36x36px icon tiles, and a dedicated detail inspection modal on card click.

## Context and Decision

The split pane caused excessive dead space on desktop canvases, felt cramped within an 880px cap, and left a prominent empty placeholder box on the screen. A 2-column grouped catalog matches the natural browsing patterns of modern plugin marketplaces, allows immediate visual scanning with brand/monogram tiles, and lets users install directly or click a card to review full manifests in a focused modal.

## Consequences

- The right-hand inspection rail is removed from `PluginDiscover.jsx`.
- Plugin manifests, power disclosures, and marketplace source links are surfaced via an inspector modal when a card body is clicked.
- Categories are rendered as visual sections in browsing mode and flatten automatically during active search queries.
