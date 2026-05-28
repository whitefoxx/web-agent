// Importing each generic adapter triggers its top-level cli({...})
// registration. Unlike the xiaohongshu adapters these are .ts files we
// own; no upstream sync to worry about.

import './open-url';
import './get-page-text';
import './screenshot';
