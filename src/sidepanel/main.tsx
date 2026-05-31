import { render } from 'preact';
import { App } from './App';

// Side-effect import: registers the generic web-operation adapters into the
// SidePanel-side registry mirror so the help/settings panel can render the
// tool list. Site-specific adapters are now market-installed.
import '../tools/generic/_all';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
render(<App />, root);
