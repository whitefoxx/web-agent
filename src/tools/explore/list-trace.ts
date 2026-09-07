import { cli } from '@base/runtime/registry.js';
import { getActiveExploreSession } from '../../explore/session';

/**
 * Explore-time perception primitive: a quick overview of what the current trace
 * has captured (action / network / state counts + endpoint count + resolved
 * site). Lets the agent review what it has already done and confirm whether the
 * data has actually shown up before it calls synthesize_adapter. Explore only.
 */
cli({
  site: 'generic',
  name: 'list_trace',
  access: 'read',
  description:
    'View an overview of the current explore recording: how many actions/network calls/snapshots captured, the identified site, how many endpoints seen. Use it to review what you have done, confirm whether the data has appeared, then decide the next step or synthesize. Only available while an explore recording is in progress.',
  args: [],
  func: async () => {
    const session = getActiveExploreSession();
    if (!session) {
      return { error: 'no active explore session — list_trace is only available while an explore recording is in progress' };
    }
    const counts = session.recorder.meta.counts;
    return {
      traceId: session.traceId,
      site: session.site,
      counts: { action: counts.action, network: counts.network, state: counts.state },
      endpoints: session.networkSummary().length,
      hint: 'Use list_network for the endpoint list, read_network for an endpoint\'s full response body, get_html for the DOM structure.',
    };
  },
});
