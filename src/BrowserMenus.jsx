// The browser's menus, as ContextMenu items: the three-dot menu, the
// site's menu under the lock, the downloads list, every tab, the
// bookmarks that don't fit the bar, Other bookmarks, and the right-click
// menus of a tab and of a bookmark.

import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsClockwise,
  BookmarkSimple,
  Camera,
  ClockCounterClockwise,
  Code,
  Copy,
  Crosshair,
  Detective,
  DeviceMobile,
  DownloadSimple,
  GearSix,
  Globe,
  Lock,
  MagnifyingGlass,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PencilSimple,
  Plus,
  Printer,
  Record,
  Robot,
  Selection,
  Star,
  StopCircle,
  Trash,
  Warning,
  X,
} from '@phosphor-icons/react'
import { bareAddress, security } from './browser-omnibox.js'
import { tabTitle } from './browser-tabs.js'
import { inFolder } from './browser-bookmarks.js'
import { fileName, hostOf, originOf, permissionName, permissionRows, zoomLabel } from './browser-chrome.js'
import { DeviceIcon } from './BrowserLiveView.jsx'

const canRecord = typeof MediaRecorder !== 'undefined'

function siteIcon(url, icons) {
  const icon = icons[originOf(url)]
  return icon ? <img className="bw-menu-icon" src={icon} alt="" /> : <Globe size={14} />
}

function markItems(marks, icons, act) {
  return marks.map((m) => ({
    label: m.title || bareAddress(m.url),
    icon: siteIcon(m.url, icons),
    onSelect: () => act.openUrl(m.url),
  }))
}

// `menu` is { kind, ... }; `ctx` is what the view knows right now.
export function menuItems(menu, ctx) {
  const { act, key, tab, tabs, active, closed, downloads, marks, icons, permissions, live, picking, rec, barSetting } = ctx
  const zoomed = (tab?.zoom ?? 1) !== 1

  if (menu.kind === 'main') {
    return [
      { label: 'New tab', icon: <Plus size={14} />, hint: key('browser-new-tab'), onSelect: () => act.openTab() },
      { label: 'New private tab', icon: <Detective size={14} />, hint: key('browser-private-tab'), onSelect: act.openPrivate },
      {
        label: 'Reopen closed tab',
        icon: <ArrowCounterClockwise size={14} />,
        hint: key('browser-reopen-tab'),
        disabled: !closed.length,
        onSelect: act.reopen,
      },
      { divider: true },
      { label: 'History', icon: <ClockCounterClockwise size={14} />, hint: key('browser-history'), onSelect: () => act.openPage('history') },
      { label: 'Downloads', icon: <DownloadSimple size={14} />, hint: key('browser-downloads'), onSelect: () => act.openPage('downloads') },
      { label: 'Bookmarks', icon: <Star size={14} />, onSelect: () => act.openPage('bookmarks') },
      {
        label: barSetting ? 'Hide bookmarks bar' : 'Show bookmarks bar',
        icon: <BookmarkSimple size={14} />,
        hint: key('browser-bookmarks-bar'),
        onSelect: act.toggleBar,
      },
      { divider: true },
      { label: 'Zoom in', icon: <MagnifyingGlassPlus size={14} />, hint: key('browser-zoom-in'), disabled: !live, onSelect: () => act.zoom(1) },
      { label: 'Zoom out', icon: <MagnifyingGlassMinus size={14} />, hint: key('browser-zoom-out'), disabled: !live, onSelect: () => act.zoom(-1) },
      {
        label: `Actual size (${zoomLabel(tab?.zoom ?? 1)})`,
        icon: <ArrowsClockwise size={14} />,
        hint: key('browser-zoom-reset'),
        disabled: !live || !zoomed,
        onSelect: () => act.zoom(0),
      },
      { divider: true },
      { label: 'Find in page', icon: <MagnifyingGlass size={14} />, hint: key('browser-find'), disabled: !live, onSelect: act.openFind },
      { label: tab?.device ? 'Leave device view' : 'Device view', icon: <DeviceMobile size={14} />, disabled: !live, onSelect: act.toggleDevice },
      { label: 'Print', icon: <Printer size={14} />, disabled: !live, onSelect: act.print },
      { divider: true },
      { label: picking ? 'Stop selecting' : 'Select an element', icon: <Crosshair size={14} />, disabled: !live, onSelect: act.pick },
      { label: 'Screenshot to chat', icon: <Camera size={14} />, disabled: !live, onSelect: act.shot },
      { label: 'Screenshot a region', icon: <Selection size={14} />, disabled: !live, onSelect: act.region },
      rec
        ? { label: 'Stop recording', icon: <StopCircle size={14} />, onSelect: act.stopRecord }
        : { label: 'Record this tab', icon: <Record size={14} />, disabled: !live || !canRecord, onSelect: act.record },
      { divider: true },
      {
        label: 'Open in your default browser',
        icon: <ArrowSquareOut size={14} />,
        disabled: !live || !/^https?:/.test(tab?.url ?? ''),
        onSelect: () => act.openExternal(tab.url),
      },
      ...(import.meta.env.DEV
        ? [{ label: 'Developer tools', icon: <Code size={14} />, hint: 'F12', disabled: !live, onSelect: act.devtools }]
        : []),
      { label: 'Settings', icon: <GearSix size={14} />, onSelect: act.openSettings },
    ]
  }

  if (menu.kind === 'site') {
    const lock = security(tab?.url)
    const said = {
      secure: 'Connection is secure',
      local: 'A page on this computer',
      insecure: 'Not secure: this site sends what you type unencrypted',
      none: 'A local page',
    }[lock]
    const origin = originOf(tab?.url)
    const remembered = tab?.private ? [] : permissionRows(permissions, origin)
    return [
      { header: hostOf(tab?.url) || tab?.url || 'This page' },
      { label: said, icon: lock === 'insecure' ? <Warning size={14} /> : <Lock size={14} />, disabled: true },
      ...(tab?.private
        ? [
            { divider: true },
            {
              label: tab.shared ? 'Stop letting agents use this tab' : 'Let agents use this tab',
              icon: <Robot size={14} />,
              onSelect: () => act.share(!tab.shared),
            },
          ]
        : []),
      ...(remembered.length
        ? [
            { divider: true },
            { header: 'Permissions' },
            ...remembered.map((p) => ({
              label: `${permissionName(p.kind)}: ${p.state === 'allow' ? 'allowed' : 'blocked'}`,
              hint: 'Reset',
              onSelect: () => act.resetPermission(p),
            })),
          ]
        : []),
      { divider: true },
      ...(zoomed ? [{ label: `Zoom ${zoomLabel(tab.zoom)}: reset`, icon: <ArrowsClockwise size={14} />, onSelect: () => act.zoom(0) }] : []),
      { label: 'Clear cookies and site data', icon: <Trash size={14} />, danger: true, onSelect: act.clearSite },
    ]
  }

  if (menu.kind === 'downloads') {
    const recent = downloads.slice(0, 8).map((d) => ({
      label: fileName(d.path ?? d.url),
      icon: d.state === 'failed' ? <Warning size={14} /> : <DownloadSimple size={14} />,
      hint: d.state === 'started' ? 'Downloading' : d.state === 'failed' ? 'Failed' : 'Show in folder',
      disabled: d.state !== 'done' || !d.path,
      onSelect: () => act.reveal(d.path),
    }))
    return [
      { header: 'Downloads' },
      ...(recent.length ? recent : [{ label: 'Nothing downloaded yet', disabled: true }]),
      { divider: true },
      { label: 'Show all downloads', icon: <DownloadSimple size={14} />, hint: key('browser-downloads'), onSelect: () => act.openPage('downloads') },
    ]
  }

  if (menu.kind === 'tabs') {
    return [
      { header: `${tabs.length} open ${tabs.length === 1 ? 'tab' : 'tabs'}` },
      ...tabs.map((t) => ({
        label: tabTitle(t),
        icon: t.remote ? (
          <DeviceIcon platform={t.remote.platform} size={14} />
        ) : t.private ? (
          <Detective size={14} />
        ) : t.favicon ? (
          <img className="bw-menu-icon" src={t.favicon} alt="" />
        ) : (
          <Globe size={14} />
        ),
        hint: t.key === active ? 'Showing' : '',
        onSelect: () => act.select(t.key),
      })),
      // The user's other devices with a browser open: their tabs, shown
      // live here with a pick.
      ...(ctx.remote ?? []).flatMap(({ device, tabs: there }) => [
        { divider: true },
        { header: `Tabs on ${device.name}` },
        ...(there.length
          ? there.map((t) => ({
              label: t.title || bareAddress(t.url) || 'New tab',
              icon: <DeviceIcon platform={device.platform} size={14} />,
              hint: 'Live',
              onSelect: () => act.openRemote(device, t),
            }))
          : [{ label: 'No tabs open', disabled: true }]),
      ]),
    ]
  }

  if (menu.kind === 'overflow') return markItems(menu.marks ?? [], icons, act)

  if (menu.kind === 'other') {
    return [
      ...markItems(inFolder(marks, 'other'), icons, act),
      { divider: true },
      { label: 'All bookmarks', icon: <Star size={14} />, onSelect: () => act.openPage('bookmarks') },
    ]
  }

  if (menu.kind === 'tab') {
    const t = menu.tab
    return [
      { label: 'New tab to the right', icon: <Plus size={14} />, onSelect: () => act.openTabAfter(t.key) },
      { label: 'Reload', icon: <ArrowsClockwise size={14} />, disabled: !t.native, onSelect: () => act.reloadTab(t) },
      { label: 'Duplicate', icon: <Copy size={14} />, disabled: !t.url, onSelect: () => act.duplicate(t) },
      { divider: true },
      { label: 'Close', icon: <X size={14} />, hint: key('browser-close-tab'), onSelect: () => act.close(t.key) },
      { label: 'Close other tabs', disabled: tabs.length < 2, onSelect: () => act.closeOthers(t.key) },
    ]
  }

  if (menu.kind === 'mark') {
    const m = menu.mark
    return [
      { header: m.title || bareAddress(m.url) },
      { label: 'Open in new tab', icon: <Plus size={14} />, onSelect: () => act.openUrl(m.url, { newTab: true }) },
      { label: 'Edit', icon: <PencilSimple size={14} />, onSelect: () => act.editMark(m, menu) },
      { label: 'Delete', icon: <Trash size={14} />, danger: true, onSelect: () => act.removeMark(m) },
    ]
  }

  return []
}
