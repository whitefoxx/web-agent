import { ArgumentError } from '../../runtime/errors.js';

/** Side-effect-free helpers shared by xiaohongshu note and comments commands. */
/** Extract a bare note ID from a full URL or raw ID string. */
export function parseNoteId(input) {
    const trimmed = input.trim();
    const match = trimmed.match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)|\/user\/profile\/[^/?#]+\/([a-f0-9]+)/i);
    return match ? (match[1] || match[2]) : trimmed;
}

export const XHS_SIGNED_URL_HINT = 'Pass a full Xiaohongshu note URL with xsec_token from search results or user/profile context.';

function isShortLink(input) {
    return /^https?:\/\/xhslink\.com\//i.test(input);
}

function isXiaohongshuHost(hostname) {
    const normalized = hostname.toLowerCase();
    return normalized === 'xiaohongshu.com' || normalized.endsWith('.xiaohongshu.com');
}

function isSupportedNotePath(pathname) {
    return /^\/(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname)
        || /^\/user\/profile\/[^/?#]+\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname);
}

/**
 * Build the best navigation URL for a note.
 *
 * XHS note detail pages now require a valid signed URL for reliable access.
 * Bare note IDs no longer resolve deterministically, so callers must provide
 * a full note URL with xsec_token or, for downloads only, an xhslink short link.
 */
export function buildNoteUrl(input, options = {}) {
    const { allowShortLink = false, commandName = 'xiaohongshu note' } = options;
    const trimmed = input.trim();
    const message = `${commandName} now requires a full signed URL`;
    const hint = allowShortLink
        ? `${XHS_SIGNED_URL_HINT} For downloads, xhslink short links are also supported.`
        : XHS_SIGNED_URL_HINT;

    if (/^https?:\/\//.test(trimmed)) {
        if (isShortLink(trimmed)) {
            if (allowShortLink)
                return trimmed;
            throw new ArgumentError(message, hint);
        }
        try {
            const url = new URL(trimmed);
            const xsecToken = url.searchParams.get('xsec_token')?.trim();
            if (isXiaohongshuHost(url.hostname) && isSupportedNotePath(url.pathname) && xsecToken) {
                return trimmed;
            }
        }
        catch { }
        throw new ArgumentError(message, hint);
    }
    // MODIFIED FROM OPENCLI UPSTREAM:
    // Auto-recover the "stripped" partial form that LLMs sometimes produce:
    //   "<24-hex-noteId>?xsec_token=...&xsec_source=..."
    // The LLM has the right id + auth query but dropped the scheme/host/path.
    // Prepend the canonical /explore/ prefix instead of failing the call.
    const partialMatch = trimmed.match(/^([a-f0-9]{24})(\?.*)$/i);
    if (partialMatch && /[?&]xsec_token=[^&#]+/i.test(partialMatch[2])) {
        return `https://www.xiaohongshu.com/explore/${partialMatch[1]}${partialMatch[2]}`;
    }
    throw new ArgumentError(message, hint);
}
