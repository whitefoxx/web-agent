/**
 * Error classes — mirrors @jackwener/opencli/errors surface used by adapters.
 */

export class CliError extends Error {
  constructor(code, message, help) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.help = help;
  }
}

export class AuthRequiredError extends CliError {
  constructor(domain, message = 'Authentication required') {
    super('AUTH_REQUIRED', message);
    this.name = 'AuthRequiredError';
    this.domain = domain;
  }
}

export class EmptyResultError extends CliError {
  constructor(source, message = 'No results') {
    super('EMPTY_RESULT', message);
    this.name = 'EmptyResultError';
    this.source = source;
  }
}

export class ArgumentError extends CliError {
  constructor(message) {
    super('ARGUMENT', message);
    this.name = 'ArgumentError';
  }
}

/**
 * Thrown when the site detected automation / rate-limited the request and
 * redirected to a captcha or verification flow. The agent loop treats this
 * specially: it stops execution immediately (rather than retrying or
 * pushing through with errors) and tells the user to wait. This protects
 * against escalation to a hard account ban — sustained hammering after a
 * captcha is the usual trigger.
 */
export class RateLimitedError extends CliError {
  constructor(domain, redirectedUrl, message = 'Site is rate-limiting / showing a captcha') {
    super('RATE_LIMITED', message);
    this.name = 'RateLimitedError';
    this.domain = domain;
    this.redirectedUrl = redirectedUrl;
  }
}

/**
 * Thrown when an adapter needs the user to attach files (images) via the
 * side-panel UI before it can proceed. The agent loop catches this like
 * RateLimitedError: it stops execution, surfaces an inline upload card in
 * the chat, and waits for the user to provide files + click Continue.
 * After Continue, a fresh agent run starts with `attachments` populated;
 * the LLM re-invokes the same tool (or a corrected version if the user
 * edited the draft) and the adapter sees the files this time.
 */
export class NeedsAttachmentsError extends CliError {
  constructor(opts = {}) {
    const min = opts.minImages ?? 1;
    const max = opts.maxImages ?? 9;
    super(
      'NEEDS_ATTACHMENTS',
      opts.message ?? `Adapter needs ${min}-${max} image attachments before it can proceed`,
    );
    this.name = 'NeedsAttachmentsError';
    this.minImages = min;
    this.maxImages = max;
  }
}
