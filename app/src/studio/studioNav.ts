import type { LucideIcon } from 'lucide-react';
import { Mic, MessageSquare, Users, History, Sparkles, LayoutGrid, Music, ListMusic, Bot } from 'lucide-react';

// 'chat' is intentionally NOT in the sidebar — the assistant lives as a
// floating widget mounted at the Studio shell. It's kept in the union so
// the existing (dead) ComingSoon branch in Studio.tsx still compiles.
export type StudioView =
  | 'home'
  | 'tts'
  | 'stt'
  | 'chat'
  | 'cloning'
  | 'voice-design'
  | 'my-voices'
  | 'music'
  | 'playbooks'
  | 'history'
  | 'agents';

export const studioSidebarItems: { id: StudioView; label: string; icon: LucideIcon }[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'voice-design', label: 'Voice Design', icon: Sparkles },
  { id: 'tts', label: 'Text-to-Speech', icon: Mic },
  { id: 'stt', label: 'Speech-to-Text', icon: MessageSquare },
  { id: 'cloning', label: 'Voice Cloning', icon: Users },
  { id: 'music', label: 'Text-to-Music', icon: Music },
  { id: 'my-voices', label: 'My Voices', icon: LayoutGrid },
  { id: 'playbooks', label: 'Playbooks', icon: ListMusic },
  { id: 'history', label: 'History', icon: History },
];

export const STUDIO_VIEWS: StudioView[] = ['home', ...studioSidebarItems.map((i) => i.id)];
