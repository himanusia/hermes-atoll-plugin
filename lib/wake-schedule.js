'use strict';

/**
 * The host keeps one pending wake per plugin. A later request must never push the
 * wake past an earlier one: a finish confirmation (750 ms) and a deferred
 * dashboard rewrite (up to 5 s) can be scheduled in the same refresh, and only
 * the shorter wake keeps the notch looking live.
 */
function shouldReschedule(pendingDelayMs, requestedDelayMs) {
  if (pendingDelayMs == null) return true;
  return requestedDelayMs < pendingDelayMs;
}

module.exports = { shouldReschedule };
