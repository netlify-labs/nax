const { z } = require('zod/v4')
const { redactSecretText } = require('./security')

const PLACEHOLDER_PATTERN = /^(?:\$|<)|(?:^|[_-])YOUR(?:[_-]|$)|^(?:all|any|broadcast|cancel-all|approve-all|\*)$/i
const promptId = z.string()
  .trim()
  .min(2)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,254}$/)
  .refine((value) => !PLACEHOLDER_PATTERN.test(value) && !value.includes('..'), 'Use one exact ID returned by NAX, not a placeholder or broadcast target.')

/** @param {string} text */
function userPrompt(text) {
  return { messages: [{ role: /** @type {const} */ ('user'), content: { type: /** @type {const} */ ('text'), text: redactSecretText(text) } }] }
}

/** @param {{ project_ref?: string, workflow_id?: string, objective?: string }} args */
function runRemoteWorkflowPrompt({ project_ref: projectRef, workflow_id: workflowId, objective } = {}) {
  return userPrompt([
    'Run a NAX workflow remotely through the scoped control plane.',
    objective ? `Objective: ${objective}` : '',
    projectRef ? `Requested project_ref: ${projectRef}` : '',
    workflowId ? `Requested workflow_id: ${workflowId}` : '',
    '',
    `1. Call context_get${projectRef ? ' with the exact requested project_ref' : ''} first and verify the authenticated project, Netlify site, branch, capabilities, and available agent/model/effort IDs. Preserve its returned scope_id in every later tool call.`,
    `2. ${workflowId ? 'Call workflow_get for the exact requested workflow_id.' : 'Call workflow_list, choose one exact workflow_id, then call workflow_get.'}`,
    '3. If the work has independent lanes, keep them explicitly bounded; do not create open-ended agent swarms.',
    '4. Call workflow_plan with structured instance objects. Planning must not start paid work.',
    '5. Present the immutable plan’s site, branch, steps, runner count, expiry, and warnings for approval.',
    '6. Only after approval, call run_start with the exact plan_id and stable request_id from next_actions. Never add start-time overrides.',
    '7. Use run_wait with its returned cursor until terminal, review, stalled, or timeout; do not busy-poll run_list.',
    '8. Call run_get with view details and inspect the actual result sections/artifacts. A summary or successful submission is not proof that the requested work succeeded.',
    '9. Report concrete results, failures, unresolved review gates, and artifact IDs. Never claim success from status text alone.',
  ].filter(Boolean).join('\n'))
}

/** @param {{ project_ref?: string, run_id: string, agent_run_id?: string, instructions?: string }} args */
function followUpOnRunPrompt({ project_ref: projectRef, run_id: runId, agent_run_id: agentRunId, instructions }) {
  return userPrompt([
    `Follow up on NAX run ${runId}.`,
    agentRunId ? `Requested agent_run_id: ${agentRunId}` : '',
    projectRef ? `Requested project_ref: ${projectRef}` : '',
    instructions ? `Follow-up objective: ${instructions}` : '',
    '',
    `1. Call context_get${projectRef ? ' with the exact requested project_ref' : ''}, verify the intended project, and preserve its returned scope_id in every later tool call.`,
    '2. Call run_get with view details for the exact run_id. Inspect actual sections and artifacts; a run summary is not evidence of result quality.',
    `3. ${agentRunId ? 'Verify that the requested agent_run_id is present and is the exact source result.' : 'Choose one exact agent_run_id returned by run_get; never target by provider name or broadcast.'}`,
    '4. Select only artifact_ids owned by this run. Read any needed nax:// artifact resources before composing the follow-up.',
    '5. Call agent_run_followup with the exact run_id, agent_run_id, a stable request_id, a bounded prompt, an explicit mode when needed, and structured instances for fresh runners.',
    '6. Keep independent follow-up lanes bounded and purposeful. Do not use implicit all-agent fan-out.',
    '7. Use run_wait and then run_get details on the resulting run. Inspect actual returned content before reporting completion.',
    '8. If the target is ambiguous or stale, follow next_actions to refresh the run; never guess an ID.',
  ].filter(Boolean).join('\n'))
}

/** @param {{ server: import('@modelcontextprotocol/server').McpServer }} input */
function registerNaxPrompts({ server }) {
  server.registerPrompt('run_remote_workflow', {
    title: 'Run a remote NAX workflow',
    description: 'Guide discovery, immutable planning, approval-aware start, bounded waiting, and result inspection.',
    argsSchema: z.object({ project_ref: z.string().trim().min(1).max(4096).optional(), workflow_id: promptId.optional(), objective: z.string().trim().min(1).max(4096).optional() }).strict(),
  }, runRemoteWorkflowPrompt)
  server.registerPrompt('follow_up_on_run', {
    title: 'Follow up on a NAX run',
    description: 'Guide exact result targeting, artifact selection, idempotent follow-up, and verification.',
    argsSchema: z.object({ project_ref: z.string().trim().min(1).max(4096).optional(), run_id: promptId, agent_run_id: promptId.optional(), instructions: z.string().trim().min(1).max(8192).optional() }).strict(),
  }, followUpOnRunPrompt)
}

module.exports = {
  followUpOnRunPrompt,
  registerNaxPrompts,
  runRemoteWorkflowPrompt,
  userPrompt,
}
