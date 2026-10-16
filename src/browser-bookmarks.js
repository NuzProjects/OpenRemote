// Bookmarks' small rules: the two folders Chrome has (the bar and Other
// bookmarks), their order, and where a moved bookmark lands. A bookmark is
// { id, url, title, folder, position }; positions are numbers, so a move
// writes only the bookmark that moved. Pure: tested without a DOM.

export const FOLDERS = { bar: 'Bookmarks bar', other: 'Other bookmarks' }

function folderOf(mark) {
  return mark.folder === 'other' ? 'other' : 'bar'
}

export function sortBookmarks(marks) {
  return [...(marks ?? [])].sort(
    (a, b) =>
      (folderOf(a) === folderOf(b) ? 0 : folderOf(a) === 'bar' ? -1 : 1) ||
      (a.position ?? 0) - (b.position ?? 0) ||
      String(a.id).localeCompare(String(b.id)),
  )
}

// One folder's bookmarks, in order.
export function inFolder(marks, folder) {
  return sortBookmarks((marks ?? []).filter((m) => folderOf(m) === folder))
}

export function bookmarkFor(marks, url) {
  if (!url) return null
  return (marks ?? []).find((m) => m.url === url) ?? null
}

// The position that puts a bookmark at `index` in a folder's list (the
// list without the bookmark being moved): between its new neighbours.
export function positionAt(list, index) {
  const before = list[index - 1]?.position
  const after = list[index]?.position
  if (before == null && after == null) return 1
  if (before == null) return after - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

// A bookmark moved one step up or down its folder: its new position, or
// null when it is already at that end.
export function stepPosition(marks, mark, step) {
  const list = inFolder(marks, folderOf(mark))
  const at = list.findIndex((m) => m.id === mark.id)
  const to = at + step
  if (at === -1 || to < 0 || to >= list.length) return null
  const rest = list.filter((m) => m.id !== mark.id)
  return positionAt(rest, to)
}
