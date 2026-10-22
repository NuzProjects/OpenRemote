# Plugins View Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Plugins view from an 880px-constrained split layout into a full-width responsive 2-column categorized catalog with visual icon tiles, in-place actions, a dedicated detail modal, and contained error alerts.

**Architecture:** Refactor `PluginDiscover.jsx` into a 2-column grid grouped by category sections during browse mode and relevance-sorted during search mode. Extract visual identity into `PluginIcon.jsx` and `PluginCard.jsx`, provide comprehensive manifest inspection via `PluginDetailModal.jsx`, and widen `PluginsView.jsx` and `PluginMarketplaces.jsx` to full width.

**Tech Stack:** React 19, Vite, @phosphor-icons/react, CSS (OpenRemote design contract), Node.js test runner (`node:test`).

**Spec:** [docs/superpowers/specs/2026-10-22-plugins-redesign-design.md](file:///c:/Users/moreweb/Documents/Workspaces/moreweb/Projects/OpenRemote/docs/superpowers/specs/2026-10-22-plugins-redesign-design.md)

## Global Constraints

- Design Contract: `#0A0C0F` app canvas, 1px `var(--line)` separators, Inter for UI, Geist Mono for code/ids, amber `#DCA24B` accent, green `#4CB487` status.
- No em dashes anywhere; write around them or use a spaced hyphen.
- Reduced motion: Support both `@media (prefers-reduced-motion: reduce)` and `html[data-reduce-motion]`.
- Staging safety: Clicking `Install` or `Update` must route through `InstallPluginModal` so daemon security checks and command review are never bypassed.
- No dead UI: Controls that do nothing are not rendered.

## Review Focus

1. Plugin with empty, non-alphanumeric, or single-character name in `pluginInitials`: must return a fallback string or 1-2 upper-case characters without throwing.
2. Search query containing regex special characters or multiple whitespace runs: must tokenize into words safely without syntax errors.
3. Category with exactly 6 plugins: must show all 6 without rendering an unnecessary "Show 0 more" button.
4. Plugin missing description, author, or powers in `PluginCard` and `PluginDetailModal`: must render cleanly with placeholders and no layout distortion.
5. Marketplace catalog fetch failure: must be dismissible and retryable without displacing other marketplace entries or throwing unhandled errors.

---

### Task 1: Catalog Categorization, Scoring, and Monogram Utilities

**Files:**
- Modify: `src/plugins.js`
- Test: `src/plugins.test.js`

**Interfaces:**
- Consumes: Catalog entry objects `{ id, name, display_name, description, category, author, marketplace, tags }`.
- Produces:
  - `pluginInitials(name: string) -> string`: 1-2 uppercase characters derived from the plugin name.
  - `searchEntries(entries: Array, filters: { query: string, category: string, marketplace: string }) -> Array`: Filters and scores entries by relevance.
  - `groupEntriesByCategory(entries: Array) -> Array<{ category: string, label: string, entries: Array }>`: Groups catalog into sorted category clusters.

- [ ] **Step 1: Write failing tests in `src/plugins.test.js`**

Add unit tests covering:
- `pluginInitials('42crunch-api')` -> `'42'`
- `pluginInitials('agent-sdk')` -> `'AS'`
- `pluginInitials('docker')` -> `'DO'`
- `pluginInitials('')` -> `'PL'`
- `pluginInitials('!!!')` -> `'PL'`
- `groupEntriesByCategory(entries)`: groups entries into title-cased categories (`Development`, `Security`, etc.) and groups missing categories into `General`, omitting empty categories.
- `searchEntries(entries, { query: 'lint' })`: ranks exact/prefix name matches ahead of description-only matches.
- `searchEntries(entries, { query: 'special.*[regex]' })`: handles regex characters without throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/plugins.test.js`
Expected: FAIL with missing functions `pluginInitials`, `groupEntriesByCategory`, `searchEntries`.

- [ ] **Step 3: Implement functions in `src/plugins.js`**

Implement `pluginInitials`, `groupEntriesByCategory`, and `searchEntries` adhering to the spec.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/plugins.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins.js src/plugins.test.js
git commit -m "feat(plugins): add catalog grouping, relevance search, and monogram helpers"
```

---

### Task 2: Plugin Icon Tile Component

**Files:**
- Create: `src/PluginIcon.jsx`
- Modify: `src/plugins.css`
- Test: `src/plugins.test.js`

**Interfaces:**
- Consumes: `pluginInitials(name)` from `src/plugins.js`, Phosphor icons from `@phosphor-icons/react`.
- Produces: `PluginIcon({ name: string, id: string, category: string, size?: number }) -> JSX.Element`

- [ ] **Step 1: Write test for icon identifier matching in `src/plugins.test.js`**

Add a pure helper `resolvePluginBrand(id, name)` or test that maps recognizable names (`github`, `gitlab`, `docker`, `android`, `aws`, `slack`, `pdf`, `jupyter`, `python`, `figma`) to brand keys.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/plugins.test.js`
Expected: FAIL

- [ ] **Step 3: Implement `src/PluginIcon.jsx` and styling in `src/plugins.css`**

Create `PluginIcon.jsx`:
- 36×36px container (`.pg-icon-tile`), `border-radius: 8px`, `1px solid rgba(255, 255, 255, 0.08)`, cool-grey background (`rgba(255, 255, 255, 0.05)`).
- Brand icons for recognized tools (e.g. `GithubLogo`, `GitlabLogo`, `AndroidLogo`, `FilePdf`, `Code`, `ShieldCheck`).
- Clean 2-letter monogram fallback using `pluginInitials(name)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/plugins.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/PluginIcon.jsx src/plugins.css src/plugins.test.js
git commit -m "feat(plugins): add PluginIcon tile component with brand and monogram support"
```

---

### Task 3: Dedicated Plugin Detail Modal Component

**Files:**
- Create: `src/PluginDetailModal.jsx`
- Modify: `src/plugins.css`

**Interfaces:**
- Consumes:
  - `PluginIcon` from `src/PluginIcon.jsx`
  - `RUNTIME_LABEL`, `POWER_LABEL`, `CLAUDE_PART_LABEL`, `entryState` from `src/plugins.js`
  - `openExternal` from `src/platform.js`
- Produces: `PluginDetailModal({ entry: Object, onClose: Function, onInstall: Function }) -> JSX.Element`

- [ ] **Step 1: Create `src/PluginDetailModal.jsx`**

Implement modal following the `dv-modal` family:
- Backdrop with click-to-close, Esc key listener, close `X` button.
- Header: 40×40px `PluginIcon`, display name, technical `id` in Geist Mono (`.pv`), author, version badge.
- Body:
  - Full description text (`.pg-details-desc`).
  - Metadata facts grid: Runtime label, marketplace source / from URL, Claude parts carried.
  - Powers list: formatted list of requested powers (`POWER_LABEL`), non-sandboxed warning badge if applicable.
  - External homepage button if `entry.homepage` exists.
- Footer:
  - Secondary `Close` button.
  - Primary action: `Install` / `Update` button calling `onInstall(entry)` and `onClose()`, or disabled `Installed` button.

- [ ] **Step 2: Add modal styles in `src/plugins.css`**

Style `.pg-detail-modal`, header, facts list, and powers section adhering to 1px lines, `--radius` 7px, and cool greys.

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm.cmd test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/PluginDetailModal.jsx src/plugins.css
git commit -m "feat(plugins): add PluginDetailModal component for manifest and power inspection"
```

---

### Task 4: Responsive 2-Column Catalog Card and Sectioned Discover View

**Files:**
- Create: `src/PluginCard.jsx`
- Modify: `src/PluginDiscover.jsx`
- Modify: `src/plugins.css`

**Interfaces:**
- Consumes:
  - `PluginIcon` from `src/PluginIcon.jsx`
  - `PluginDetailModal` from `src/PluginDetailModal.jsx`
  - `groupEntriesByCategory`, `searchEntries`, `entryState` from `src/plugins.js`
  - `useConsole` from `src/state/console.jsx`
- Produces:
  - `PluginCard({ entry: Object, onInstall: Function, onInspect: Function }) -> JSX.Element`
  - Refactored `PluginDiscover({ onInstall: Function }) -> JSX.Element`

- [ ] **Step 1: Create `src/PluginCard.jsx`**

Create `PluginCard`:
- Layout: flex row with 36×36px `PluginIcon` left, info middle (name, 2-line clamped description, author / marketplace), right action button (`Install` / `Update` / `Installed`).
- Clicking card body calls `onInspect(entry)`.
- Clicking `Install` or `Update` button calls `e.stopPropagation()` and `onInstall(entry)`.

- [ ] **Step 2: Refactor `src/PluginDiscover.jsx`**

Refactor `PluginDiscover`:
- Remove 880px width cap and 300px inspection rail.
- State: `query`, `category`, `market`, `inspectedEntry`, `expandedCategories` (Set of expanded category keys), `dismissedErrors` (Set of dismissed marketplace error names).
- Top toolbar: Search input with clear button, styled category select/pills, marketplace filter, refresh button with spinning state during active fetches.
- Contained error alert card: for any enabled marketplace with an error that isn't dismissed, render an alert card with warning icon, message, `Retry` button, and `Dismiss` button.
- Browse Mode (no query & no category filter):
  - Render grouped sections using `groupEntriesByCategory(all)`.
  - Section header: Category label + count chip.
  - 2-column grid (`.pg-grid-2col`).
  - If section entries > 6: show first 6 with a "Show {count - 6} more" toggle button; when expanded, show "Show less".
- Search/Filter Mode (when query or category filter is active):
  - Render flat 2-column grid of `searchEntries(...)`.
  - Display search count indicator: `Showing {shown.length} of {all.length} plugins`.
- Render `PluginDetailModal` when `inspectedEntry` is non-null.

- [ ] **Step 3: Update `src/plugins.css` for 2-column grid, toolbar, and error cards**

Implement:
- `.pg-grid-2col`: `display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; width: 100%;`.
- Mobile breakpoint (`@media (max-width: 800px)`): collapses to single column `1fr`.
- `.pg-toolbar`: clean flex row with search and filters spanning full width.
- `.pg-error-card`: contained alert card with amber hairline border and quiet dark background.

- [ ] **Step 4: Run test suite**

Run: `npm.cmd test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/PluginCard.jsx src/PluginDiscover.jsx src/plugins.css
git commit -m "feat(plugins): implement 2-column catalog grid with category sections and error alert"
```

---

### Task 5: Widen Installed and Marketplaces Views & Layout Integration

**Files:**
- Modify: `src/PluginsView.jsx`
- Modify: `src/PluginMarketplaces.jsx`
- Modify: `src/plugins.css`

**Interfaces:**
- Consumes: `InstalledPlugins` in `PluginsView.jsx`, `PluginMarketplaces.jsx`.
- Produces: Consistent full-width panel presentation across all 3 tabs (`Discover`, `Installed`, `Marketplaces`).

- [ ] **Step 1: Update `src/PluginsView.jsx`**

- Remove `width: min(880px, 100%)` constraint on tabs and lists.
- Refactor tab strip (`.pg-tabs`) to span the full header width with quiet, refined pill/tab styling.
- Ensure `InstalledPlugins` rows (`.pn-list`, `.pn-row`) scale gracefully to full width.

- [ ] **Step 2: Update `src/PluginMarketplaces.jsx`**

- Remove width constraints on `.pg-add-row` and added marketplace list.
- Clean up add input and action button styling.

- [ ] **Step 3: Update `src/plugins.css`**

- Clean up dead CSS classes from the removed 300px inspection rail.
- Ensure reduced-motion rules cover all new card transitions (`.pg-card`, `.pg-tab`, `.pg-icon-tile`).

- [ ] **Step 4: Run full test suite**

Run: `npm.cmd test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/PluginsView.jsx src/PluginMarketplaces.jsx src/plugins.css
git commit -m "refactor(plugins): widen Installed and Marketplaces views for full canvas consistency"
```

---

### Task 6: Review Focus Testing & Visual Contract Verification

**Files:**
- Modify: `src/plugins.test.js`

- [ ] **Step 1: Add edge-case tests in `src/plugins.test.js`**

Add tests covering all Review Focus conditions:
- Empty/symbol-only plugin names in `pluginInitials`.
- Malformed/regex characters in search queries.
- Boundary condition: category with exactly 6 plugins (no extra expander needed).
- Entries with missing fields (null description, undefined powers, missing author).

- [ ] **Step 2: Run test suite**

Run: `npm.cmd test`
Expected: PASS (all 200+ tests passing).

- [ ] **Step 3: Commit**

```bash
git add src/plugins.test.js
git commit -m "test(plugins): add test coverage for search tokenization and initials edge cases"
```
