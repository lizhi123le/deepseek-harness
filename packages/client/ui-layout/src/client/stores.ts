/**
 * Root-owned frame measurement, panel preferences, and presentation reports.
 * Both panel widths are drag preferences that outlive the load; the rest of the
 * layout is per-load state. The registration supplies a fresh store and binds
 * its actions to ctx.layout.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from './service.ts'
import {
  clampWidth, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/** Browser-storage keys holding the panel drag widths in px. */
const SIDEBAR_WIDTH_KEY = 'dsh.layout.sidebarWidth'
const RIGHTBAR_WIDTH_KEY = 'dsh.layout.rightbarWidth'

/**
 * Read one remembered panel width.
 * @param key - browser-storage key holding the width in px.
 * @param min - range lower bound applied to the stored value.
 * @param max - range upper bound applied to the stored value.
 * @returns the clamped width, or null when the key is absent, its value is not
 *   a positive number, or storage is unavailable.
 */
function readPanelWidth(key: string, min: number, max: number): number | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? clampWidth(value, min, max) : null
  } catch {
    // A private or locked-down browser store leaves the width at its default.
    return null
  }
}

/**
 * Remember one dragged panel width. Both callers pass a clamped, positive
 * width: collapsing the sidebar is a visibility change that leaves the stored
 * preference intact, so the next reopen restores the last real width.
 * @param key - browser-storage key holding the width in px.
 * @param px - the width to remember.
 */
function rememberPanelWidth(key: string, px: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, `${px}`)
  } catch {
    // A private or full browser store must not break the drag.
  }
}

/**
 * Layout preferences shared by the frame. Responsive concessions never rewrite
 * widths; the right panel's expanded state belongs to its occupant.
 */
type LayoutState = {
  panelInfo: {
    /** Null selects the Conversation; global panels keep the current Session intact. */
    activePanelId: MainPanelId | null
  }
  layoutInfo: LayoutInfo
}

type LayoutInfo = {
  /** Visible sidebar width in px; 0 collapses the column to its rail. */
  sidebar: number
  /**
   * Last positive sidebar width in px: the drag preference that collapsing the
   * column leaves intact, and the width a reopen restores.
   */
  sidebarWidth: number
  /** Last positive frame measurement; window width bootstraps the first render. */
  viewportWidth: number
  narrowExpanded: boolean
  /**
   * Right panel width in px, or null before its first opening. Resizing the
   * frame and closing the panel preserve this preference, and a drag outlives
   * the load so the next opening restores it.
   */
  rightbar: number | null
  /**
   * Whether the right panel is drawn at all, in either presentation.
   *
   * Derived chrome, not a source of truth: whether the right surface is
   * expanded is a recorded fact owned by that surface, reported here so the
   * frame can place the panel's resize handle. The occupant reports it; nothing
   * else writes it.
   */
  rightbarShown: boolean
  /**
   * Whether the normal panel width reserves a grid track, including beneath
   * fullscreen. Reported by the occupant; always false while hidden.
   */
  rightbarTrack: boolean
  /** Reported fullscreen presentation; hides the outer resize handle. */
  rightbarFullscreen: boolean
  /** Suppress transitions for a fullscreen exit until another geometry action. */
  rightbarInstant: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  selectPanel: (draft: LayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: LayoutState, panelIds: readonly string[]) => void
  setSidebar: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setViewportWidth: (draft: LayoutState, width: number) => void
  setRightbar: (draft: LayoutState, px: number) => void
  openRightbar: (draft: LayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle. Both panel widths are drag preferences
 * remembered in browser storage, so closing the sidebar hides the column
 * without forgetting its width and reopening restores it; the right panel
 * initializes at 45% of the frame only while no width was ever dragged, and a
 * later opening restores the remembered one. Drag writes clamp to the current
 * frame's range, and a remembered width is clamped again at load. Open and
 * closed state is never restored. Narrow sidebar toggles change only the
 * expansion override; opening the right panel clears that override.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => {
      const viewportWidth = window.innerWidth
      const sidebarWidth = readPanelWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN, SIDEBAR_MAX) ?? SIDEBAR_DEFAULT
      return {
        panelInfo: { activePanelId: null },
        layoutInfo: {
          sidebar: sidebarWidth,
          sidebarWidth,
          viewportWidth,
          narrowExpanded: false,
          rightbar: readPanelWidth(RIGHTBAR_WIDTH_KEY, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, viewportWidth * RIGHTBAR_MAX_RATIO)),
          rightbarShown: false,
          rightbarTrack: false,
          rightbarFullscreen: false,
          rightbarInstant: false,
        },
      }
    },
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      setSidebar: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        const width = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
        d.layoutInfo.sidebar = width
        d.layoutInfo.sidebarWidth = width
        rememberPanelWidth(SIDEBAR_WIDTH_KEY, width)
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout. A wide
      // reopen restores the last dragged width rather than the default.
      toggleSidebar: (d) => {
        d.layoutInfo.rightbarInstant = false
        if (d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded
        else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? d.layoutInfo.sidebarWidth : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setViewportWidth: (d, width: number) => {
        if (d.layoutInfo.viewportWidth === width) return
        d.layoutInfo.rightbarInstant = false
        if ((d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) !== (width < SIDEBAR_AUTO_COLLAPSE)) {
          d.layoutInfo.narrowExpanded = false
        }
        d.layoutInfo.viewportWidth = width
      },
      setRightbar: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        const width = clampWidth(px, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, d.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO))
        d.layoutInfo.rightbar = width
        rememberPanelWidth(RIGHTBAR_WIDTH_KEY, width)
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        if (!d.layoutInfo.rightbarShown || d.layoutInfo.rightbarTrack !== track || d.layoutInfo.rightbarFullscreen !== fullscreen) {
          d.layoutInfo.rightbarInstant = d.layoutInfo.rightbarFullscreen && !fullscreen
        }
        if (!d.layoutInfo.rightbarShown && d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = false
        d.layoutInfo.rightbar ??= Math.max(RIGHTBAR_MIN, Math.round(d.layoutInfo.viewportWidth * RIGHTBAR_DEFAULT_RATIO))
        d.layoutInfo.rightbarShown = true
        d.layoutInfo.rightbarTrack = track
        d.layoutInfo.rightbarFullscreen = fullscreen
      },
      closeRightbar: (d) => {
        if (d.layoutInfo.rightbarShown) d.layoutInfo.rightbarInstant = d.layoutInfo.rightbarFullscreen
        d.layoutInfo.rightbarShown = false
        d.layoutInfo.rightbarTrack = false
        d.layoutInfo.rightbarFullscreen = false
      },
    },
  })
  return handle
}
