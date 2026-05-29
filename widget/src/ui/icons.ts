/**
 * Inline SVG icons.
 *
 * We don't pull in lucide or heroicons — they'd add ~40 KB for the
 * five icons we actually use. These are hand-traced minimal versions
 * of the same shapes.
 *
 * Each icon is a Lit ``html`` template so the size + colour follow
 * the parent's ``font-size`` / ``currentColor`` automatically.
 */

import { html, svg } from 'lit';


const iconBase = (children: ReturnType<typeof svg>) => html`
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em"
       viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true">
    ${children}
  </svg>
`;


export const iconMic = iconBase(svg`
  <rect x="9" y="2" width="6" height="12" rx="3" ry="3" fill="currentColor" stroke="none" />
  <path d="M5 11a7 7 0 0 0 14 0" />
  <line x1="12" y1="18" x2="12" y2="22" />
`);

export const iconMicOff = iconBase(svg`
  <line x1="3" y1="3" x2="21" y2="21" />
  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
  <path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
  <path d="M19 11a7 7 0 0 1-3.43 6" />
  <path d="M5 11a7 7 0 0 0 .73 3.13" />
`);

export const iconSend = iconBase(svg`
  <path d="M22 2 11 13" />
  <path d="M22 2 15 22l-4-9-9-4 20-7z" fill="currentColor" stroke="none" />
`);

export const iconClose = iconBase(svg`
  <line x1="18" y1="6" x2="6" y2="18" />
  <line x1="6" y1="6" x2="18" y2="18" />
`);

export const iconKeyboard = iconBase(svg`
  <rect x="2" y="6" width="20" height="12" rx="2" />
  <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01" />
  <path d="M6 14h12" />
`);
