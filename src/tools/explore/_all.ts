// Explore-authoring tool set — the perception + write-recon primitives that
// only work during an active explore session (they attach to the explore tab
// via session.newPage() or read the explore trace store). FULL shell only; the
// lite bridge omits them entirely. Registered by the full extension via
// `../generic/_all`. Importing each module triggers its cli({...}) registration.

// Develop + test the extraction live (attach to the explore tab):
//   eval_js — run a snippet via the same CDP path the adapter will use
//   (session-bound variant; re-registers over the shared-base tab-addressed one)
// find_structured_data + get_a11y_tree were promoted to the shared base
// (tools/generic/, tab-addressed with a session fallback) — no longer here.
import './eval-js';

// Network/trace perception — what XHR/Fetch the page made (list_network), one
// endpoint's full body (read_network), a trace overview (list_trace), and a
// page-value → source-endpoint reverse lookup (find_in_network):
import './list-network';
import './read-network';
import './list-trace';
import './find-in-network';

// Write-recon: perform a write for real but neutralize the request (it never
// hits the server) and hand back its structure to synthesize a write adapter —
// the constructive half of the F-29 write guard.
import './capture-submission';
