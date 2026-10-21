// VS Code's own split-editor shape: one page divided down the middle -
// sharp corners, even 1px strokes, nothing else. Phosphor has no
// frame-yes divider-yes glyph, so it is drawn here, the way the
// titlebar's caption glyphs are. The titlebar toggle and the pane headers
// share this one, so "split" looks the same everywhere in the app.
export default function SplitGlyph({ size = 15, axis = 'v' }) {
  return (
    <svg
      className="split-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      {axis === 'v' ? (
        <path d="M8 2.75v10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      ) : (
        <path d="M1.75 8h12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      )}
    </svg>
  )
}
