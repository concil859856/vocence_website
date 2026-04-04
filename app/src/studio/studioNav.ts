import type { LucideIcon } from 'lucide-react';
import { Mic, MessageSquare, Users, History, Sparkles, LayoutGrid } from 'lucide-react';

export type StudioView =
  | 'tts'
  | 'stt'
  | 'chat'
  | 'cloning'
  | 'voice-design'
  | 'my-voices'
  | 'history';

export const studioSidebarItems: { id: StudioView; label: string; icon: LucideIcon }[] = [
  { id: 'tts', label: 'Text-to-Speech', icon: Mic },
  { id: 'stt', label: 'Speech-to-Text', icon: MessageSquare },
  { id: 'chat', label: 'Voice Chat', icon: MessageSquare },
  { id: 'cloning', label: 'Voice Cloning', icon: Users },
  { id: 'voice-design', label: 'Voice Design', icon: Sparkles },
  { id: 'my-voices', label: 'My voices', icon: LayoutGrid },
  { id: 'history', label: 'History', icon: History },
];

export const STUDIO_VIEWS: StudioView[] = studioSidebarItems.map((i) => i.id);
