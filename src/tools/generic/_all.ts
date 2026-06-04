// Importing each generic adapter triggers its top-level cli({...})
// registration. Unlike the xiaohongshu adapters these are .ts files we
// own; no upstream sync to worry about.

import './open-url';
import './get-page-text';
import './screenshot';
// Primitives for compositional workflows: open_url → scroll_page →
// get_text_from_tab → close_tab. Lets the model scrape feed-style
// pages that need scrolling to load more content.
import './scroll-page';
import './get-text-from-tab';
import './close-tab';
// Generic interaction primitives — give the model a way to navigate
// arbitrary sites (click, type, fill forms) without a per-site adapter.
// get_interactives is the perception entry point; click / click_by_text /
// type_into are the action verbs. Compose like:
//   open_url → get_interactives → click (or type_into) → screenshot to verify
import './get-interactives';
import './click';
import './click-by-text';
import './type-into';
// Explore perception primitives: see captured XHR/Fetch endpoints (list_network)
// and raw DOM (get_html) so the LLM can decide a synthesis strategy. They
// self-guard when no explore session is active.
import './list-network';
import './get-html';
