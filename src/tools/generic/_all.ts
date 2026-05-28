// Importing each generic adapter triggers its top-level cli({...})
// registration. Unlike the xiaohongshu adapters these are .ts files we
// own; no upstream sync to worry about.

import './open-url';
import './get-page-text';
import './screenshot';
// Primitives for compositional workflows: open_url → scroll_page →
// get_text_from_tab → close_tab. Lets the chatbot scrape feed-style
// pages that need scrolling to load more content.
import './scroll-page';
import './get-text-from-tab';
import './close-tab';
