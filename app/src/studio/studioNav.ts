import type { LucideIcon } from 'lucide-react';
import { Mic, MessageSquare, Users, History, Sparkles, LayoutGrid, Music, ListMusic, Bot, AudioLines, Film, Code2, Terminal, BookOpen, Library, LifeBuoy } from 'lucide-react';

export type StudioView =
  | 'home'
  | 'tts'
  | 'stt'
  | 'cloning'
  | 'voice-design'
  | 'my-voices'
  | 'community-voices'
  | 'music'
  | 'noise-remover'
  | 'dubbing'
  | 'playbooks'
  | 'history'
  | 'agents';

export interface StudioNavItem {
  /** Used as the active-tab match key and for the default ``/studio/{id}``
   *  route. Items targeting non-studio routes set ``to`` instead. */
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: { text: string; variant: 'new' | 'beta' | 'soon' };
  /** When true, the row is rendered but doesn't navigate (greyed-out
   *  placeholder for not-yet-shipped features). */
  disabled?: boolean;
  /** Explicit destination, overrides the default ``/studio/{id}``.
   *  Use for items that point outside the Studio (docs, etc.). */
  to?: string;
  /** When true, ``to`` is treated as an external URL: opens in a new
   *  tab via ``window.open(..., '_blank')`` instead of react-router. */
  external?: boolean;
}

export interface StudioNavSection {
  /** Uppercase eyebrow label shown above the group (CREATE / TRANSFORM / LIBRARY). */
  heading: string;
  items: StudioNavItem[];
}

/** Three-category sidebar matching the spec, items live in only one
 *  section. Order within a section is the order they render. Home sits
 *  at the very top of CREATE since it's the obvious starting point. */
export const studioNavSections: StudioNavSection[] = [
  {
    heading: 'Create',
    items: [
      { id: 'tts',          label: 'Text to Speech', icon: Mic },
      { id: 'voice-design', label: 'Voice Design',   icon: Sparkles, badge: { text: 'NEW',  variant: 'new'  } },
      { id: 'music',        label: 'Text to Music',  icon: Music },
      { id: 'agents',       label: 'Voice Agents',   icon: Bot,      badge: { text: 'BETA', variant: 'beta' } },
    ],
  },
  {
    heading: 'Transform',
    items: [
      { id: 'cloning',       label: 'Voice Cloning', icon: Users },
      { id: 'stt',           label: 'Speech to Text', icon: MessageSquare },
      { id: 'dubbing',       label: 'Dubbing',       icon: Film,       badge: { text: 'SOON', variant: 'soon' }, disabled: true },
      { id: 'noise-remover', label: 'Noise Remover', icon: AudioLines, badge: { text: 'NEW',  variant: 'new'  } },
    ],
  },
  {
    heading: 'Library',
    items: [
      { id: 'community-voices', label: 'Community Voices', icon: Library },
      { id: 'my-voices',        label: 'My Voices',        icon: LayoutGrid },
      { id: 'playbooks',        label: 'Playbooks',        icon: ListMusic },
      { id: 'history',          label: 'History',          icon: History },
    ],
  },
  {
    heading: 'Developer',
    items: [
      { id: 'docs-api',      label: 'API',       icon: Code2,    to: '/docs/api' },
      { id: 'docs-sdk',      label: 'SDK',       icon: Terminal, to: '/docs/sdk-python' },
      { id: 'docs-cookbook', label: 'Codebooks', icon: BookOpen, to: '/docs/cookbook' },
    ],
  },
];

/** Standalone "Help" entry, community Discord. Rendered at the
 *  bottom of the sidebar, outside the category system. Matches the
 *  pattern Vercel / Linear / Figma use: Help sits separately from
 *  product navigation so it's findable when something breaks. */
export const STUDIO_HELP_ITEM: StudioNavItem = {
  id: 'help',
  label: 'Help',
  icon: LifeBuoy,
  to: 'https://discord.gg/b2DTT73Usq',
  external: true,
};

/** Flat list of all sidebar items, kept for the legacy mobile bottom
 *  bar and the route-views audit. */
export const studioSidebarItems: StudioNavItem[] = studioNavSections.flatMap((s) => s.items);

export const STUDIO_VIEWS: StudioView[] = ['home', ...studioSidebarItems.filter((i) => i.id !== 'home').map((i) => i.id as StudioView)];
