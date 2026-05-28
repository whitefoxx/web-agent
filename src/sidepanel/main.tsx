import { render } from 'preact';
import { App } from './App';

// Side-effect import: each adapter's top-level cli({...}) registers it with
// the runtime registry. SidePanel uses the registry to render tool lists in
// the help/settings panel; the actual tool execution still runs in the SW.
import '../tools/xiaohongshu/_all';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
render(<App />, root);
