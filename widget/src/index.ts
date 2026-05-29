/**
 * Public entry point — registering the ``<vocence-agent>`` custom
 * element happens as a side effect of importing ``./component``.
 *
 * Both the IIFE (``<script>``-tag) and the ESM bundle land here, so
 * a host page that does ``<script src="widget.iife.js" defer>`` ends
 * up with the element registered automatically — no JS to write.
 *
 * Programmatic consumers can also import the class directly:
 *
 *     import { VocenceAgentElement } from '@vocence/widget';
 *
 * The class is exported so React/Vue wrappers can construct it
 * imperatively if they need to.
 */

import { VocenceAgentElement } from './component';

export { VocenceAgentElement };

// The custom element registers itself via Lit's @customElement
// decorator inside component.ts. Importing the file is sufficient.
// We don't call ``customElements.define`` here a second time — that
// throws on duplicate registration.

/** Library version — useful for support / bug-report attribution.
 *  Bumped together with package.json's ``version`` field. */
export const VERSION = '0.1.0';
