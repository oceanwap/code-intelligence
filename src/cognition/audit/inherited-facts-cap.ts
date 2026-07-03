/**
 * audit/inherited-facts-cap — single source of truth for the inherited
 * scratchpad-fact cap, shared by every meta-tool that reads prior
 * reasoning facts from the blackboard append-log.
 *
 * Sprint 8 US-002 / B1 closes the F5 cap drift across the meta-tool
 * family: previously only `trace_workflow` enforced the cap, so the
 * 4 sibling meta-tools (`audit_symbol`, `plan_refactor`, `collaborate`,
 * `intents/runner`) each walked the full scratchpad and pulled an
 * unbounded number of prior facts on every call. A long-running
 * session could blow up `reasoning_chain` to thousands of entries.
 *
 * The cap is the maximum number of recent append-log entries that the
 * meta-tool pulls into its reasoning chain — defined here as a named
 * constant so every caller enforces the SAME number, and so QA can
 * assert the constant via `inheritedFactsCap` on the meta-tool payload.
 *
 * Backward compatibility (PRD FR-11):
 *   - The cap value mirrors the pre-Sprint-8 constant in
 *     `trace-workflow.ts:127` (20). Existing payloads that already
 *     exposed `inheritedFactsCap: 20` are unchanged.
 *   - Sibling meta-tools gain a `inheritedFactsCap` field that is also
 *     set to this constant. Callers that assert presence of the field
 *     but not its value will see `inheritedFactsCap: 20` either way.
 *
 * `INHERITED_FACTS_CAP = 20` rationale (recorded for posterity):
 *   - 20 is small enough to keep the reasoning chain short under
 *     adversarial append-log growth.
 *   - 20 is large enough that a typical LLM-tool session (5-10 calls)
 *     inherits the whole conversation plus several prior round-trips.
 *   - The cap was already validated for `trace_workflow` and there is
 *     no signal callers need more.
 */

/**
 * Maximum number of recent append-log entries the meta-tool pulls into
 * its reasoning chain (one constant, four meta-tools, one truth).
 */
export const INHERITED_FACTS_CAP = 20;
