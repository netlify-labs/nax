/**
 * Schema version used by the first public serializable handle contract.
 *
 * The handle types and parser are introduced by the domain-contract bead; the
 * constant lives at the package boundary so pack consumers exercise a stable,
 * intentional export from the first build.
 */
export const AGENT_RUNNER_SDK_HANDLE_VERSION = 1 as const
