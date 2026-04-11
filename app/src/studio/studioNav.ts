import type { LucideIcon } from 'lucide-react';
import { Mic, MessageSquare, Users, History, Sparkles, LayoutGrid, Music } from 'lucide-react';

export type StudioView =
  | 'home'
  | 'tts'
  | 'stt'
  | 'chat'
  | 'cloning'
  | 'voice-design'
  | 'my-voices'
  | 'music'
  | 'history';

export const studioSidebarItems: { id: StudioView; label: string; icon: LucideIcon }[] = [
  { id: 'voice-design', label: 'Voice Design', icon: Sparkles },
  { id: 'tts', label: 'Text-to-Speech', icon: Mic },
  { id: 'stt', label: 'Speech-to-Text', icon: MessageSquare },
  { id: 'cloning', label: 'Voice Cloning', icon: Users },
  { id: 'music', label: 'Text-to-Music', icon: Music },
  { id: 'my-voices', label: 'My Voices', icon: LayoutGrid },
  { id: 'history', label: 'History', icon: History },
  { id: 'chat', label: 'Voice Chat', icon: MessageSquare },
];

export const STUDIO_VIEWS: StudioView[] = ['home', ...studioSidebarItems.map((i) => i.id)];
