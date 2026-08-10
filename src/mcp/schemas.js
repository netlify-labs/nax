const { z } = require('zod/v4')

const MAX_CONTEXT_BYTES = 64 * 1024
const MAX_PROMPT_BYTES = 80 * 1024
const MAX_REASON_BYTES = 4 * 1024
const MAX_PAGE_LIMIT = 100
const MAX_EVENT_LIMIT = 200
const MAX_WAIT_MS = 30000
const MAX_INSTANCES = 32
const MAX_ARTIFACTS = 64

const PLACEHOLDER_PATTERN = /^(?:\$|<)|(?:^|[_-])YOUR(?:[_-]|$)|^(?:all|any|broadcast|cancel-all|approve-all|\*)$/i
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,254}$/
const INSTANCE_VALUE_PATTERN = /^[A-Za-z0-9~][A-Za-z0-9._~:/-]{0,254}$/

/** @param {string} value */
function isConcreteId(value) {
  return ID_PATTERN.test(value) && !PLACEHOLDER_PATTERN.test(value) && !URL_PATTERN.test(value) && !value.includes('..')
}

/** @param {string} name */
function entityId(name) {
  return z.string()
    .trim()
    .min(2, `${name} must be a concrete ID returned by a discovery tool.`)
    .max(255, `${name} must be at most 255 characters.`)
    .refine(isConcreteId, `${name} must be an exact ID returned by a discovery tool, not a placeholder, URL, path, or broadcast target.`)
}

/** @param {string} name */
function instanceValue(name) {
  return z.string()
    .trim()
    .min(1, `${name} is required.`)
    .max(255, `${name} must be at most 255 characters.`)
    .regex(INSTANCE_VALUE_PATTERN, `${name} must be a catalog identifier, not a credential, path, or URL.`)
    .refine((value) => !PLACEHOLDER_PATTERN.test(value) && !URL_PATTERN.test(value) && !value.includes('..'), `${name} must be a concrete catalog identifier.`)
}

/** @param {number} maximumBytes @param {string} message */
function boundedText(maximumBytes, message) {
  return z.string().trim().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes, message)
}

const branchSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'branch must be a Git branch name, not a path, URL, refspec, or shell expression.')
  .refine((value) => !URL_PATTERN.test(value) && !value.includes('..') && !value.includes('//') && !value.includes('@{') && !value.endsWith('/') && !value.endsWith('.'), 'branch must be a safe concrete Git branch name.')

const cursorSchema = z.union([
  z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/, 'cursor must be the opaque value returned by a previous MCP result.'),
  z.number().int().nonnegative(),
])

const agentInstanceSchema = z.object({
  agent: instanceValue('agent'),
  model: instanceValue('model').optional(),
  effort: instanceValue('effort').optional(),
  label: z.string().trim().min(1).max(100).optional(),
}).strict()

const instanceListSchema = z.array(agentInstanceSchema)
  .min(1, 'instances must contain at least one structured agent instance object.')
  .max(MAX_INSTANCES)

const stepInstancesSchema = z.record(entityId('step_id'), instanceListSchema)

const scopeSelectionShape = Object.freeze({
  scope_id: entityId('scope_id').optional(),
})

const projectRefSchema = z.string()
  .trim()
  .min(1, 'project_ref must name one project or contain one exact project directory.')
  .max(4096)
  .refine((value) => !URL_PATTERN.test(value) && !/[\0\r\n]/.test(value), 'project_ref must be a project alias or local directory, not a URL or control string.')

const contextGetInputSchema = z.object({
  ...scopeSelectionShape,
  project_ref: projectRefSchema.optional(),
}).strict().refine((value) => !(value.scope_id && value.project_ref), {
  message: 'scope_id and project_ref are mutually exclusive.',
  path: ['project_ref'],
})

const workflowListInputSchema = z.object({
  ...scopeSelectionShape,
  source: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  cursor: cursorSchema.optional(),
}).strict()

const workflowGetInputSchema = z.object({
  ...scopeSelectionShape,
  workflow_id: entityId('workflow_id'),
  include_graph: z.boolean().optional(),
}).strict()

const workflowPlanInputSchema = z.object({
  ...scopeSelectionShape,
  workflow_id: entityId('workflow_id'),
  branch: branchSchema.optional(),
  instances: instanceListSchema.optional(),
  step_instances: stepInstancesSchema.optional(),
  context: boundedText(MAX_CONTEXT_BYTES, `context must be at most ${MAX_CONTEXT_BYTES} UTF-8 bytes.`).optional(),
  only_step: entityId('only_step').optional(),
  from_step: entityId('from_step').optional(),
}).strict().refine((value) => !(value.only_step && value.from_step), {
  message: 'only_step and from_step are mutually exclusive; create separate plans when both views are needed.',
  path: ['only_step'],
})

const agentRunPlanInputSchema = z.object({
  ...scopeSelectionShape,
  prompt: boundedText(MAX_PROMPT_BYTES, `prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes.`),
  instance: agentInstanceSchema,
  branch: branchSchema.optional(),
}).strict()

const runStartInputSchema = z.object({
  ...scopeSelectionShape,
  plan_id: entityId('plan_id'),
  request_id: entityId('request_id'),
}).strict()

const RUN_STATUSES = Object.freeze([
  'unknown',
  'booting',
  'running',
  'awaiting_review',
  'interrupted',
  'completed',
  'completed_with_failures',
  'dry-run',
  'failed',
  'cancelled',
  'abandoned',
  'dismissed',
])

const runListInputSchema = z.object({
  ...scopeSelectionShape,
  status: z.enum(RUN_STATUSES).optional(),
  workflow_id: entityId('workflow_id').optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  cursor: cursorSchema.optional(),
}).strict()

const runGetInputSchema = z.object({
  ...scopeSelectionShape,
  run_id: entityId('run_id'),
  view: z.enum(['summary', 'details', 'graph', 'events']),
  section_id: entityId('section_id').optional(),
  since: cursorSchema.optional(),
  limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional(),
}).strict()
  .refine((value) => !value.section_id || value.view === 'details', { message: 'section_id is valid only when view is "details".', path: ['section_id'] })
  .refine((value) => !value.since || value.view === 'events', { message: 'since is valid only when view is "events".', path: ['since'] })
  .refine((value) => !value.limit || value.view === 'events', { message: 'limit is valid only when view is "events".', path: ['limit'] })

const runWaitInputSchema = z.object({
  ...scopeSelectionShape,
  run_id: entityId('run_id'),
  since: cursorSchema.optional(),
  timeout_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
}).strict()

const runCancelInputSchema = z.object({
  ...scopeSelectionShape,
  run_id: entityId('run_id'),
  agent_run_id: entityId('agent_run_id').optional(),
  reason: boundedText(MAX_REASON_BYTES, `reason must be at most ${MAX_REASON_BYTES} UTF-8 bytes.`).optional(),
}).strict()

const agentRunRetryInputSchema = z.object({
  ...scopeSelectionShape,
  run_id: entityId('run_id'),
  agent_run_id: entityId('agent_run_id'),
  request_id: entityId('request_id'),
}).strict()

const agentRunFollowupInputSchema = z.object({
  ...scopeSelectionShape,
  run_id: entityId('run_id'),
  agent_run_id: entityId('agent_run_id'),
  request_id: entityId('request_id'),
  prompt: boundedText(MAX_PROMPT_BYTES, `prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes.`),
  mode: z.enum(['follow-up-thread', 'fresh-runner']).optional(),
  artifact_ids: z.array(entityId('artifact_id')).max(MAX_ARTIFACTS).optional(),
  instances: instanceListSchema.optional(),
}).strict()

const reviewGateResolveInputSchema = z.object({
  ...scopeSelectionShape,
  run_id: entityId('run_id'),
  review_gate_id: entityId('review_gate_id'),
  decision: z.enum(['approve', 'cancel']),
  reason: boundedText(MAX_REASON_BYTES, `reason must be at most ${MAX_REASON_BYTES} UTF-8 bytes.`).optional(),
}).strict()

const nextActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal('resource'), uri: z.string() }).strict(),
  z.object({ kind: z.literal('command'), command: z.string() }).strict(),
])

const resultContextSchema = z.object({
  runtime: z.enum(['local-dashboard', 'desktop', 'hosted']),
  scope: z.object({
    scopeId: z.string(),
    projectId: z.string(),
    accountId: z.string().optional(),
    siteId: z.string().optional(),
    repositoryId: z.string().optional(),
  }).strict(),
  local: z.object({
    projectRoot: z.string().optional(),
    dashboardInstanceId: z.string().optional(),
  }).strict().optional(),
}).strict()

const errorShapeSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict()

const toolResultOutputSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: errorShapeSchema.optional(),
  context: resultContextSchema.optional(),
  next_actions: z.array(nextActionSchema).max(8),
}).strict().refine((value) => value.ok ? value.data !== undefined && value.error === undefined : value.error !== undefined && value.data === undefined, {
  message: 'Success results require data; error results require error.',
})

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})
const PLAN_ANNOTATIONS = Object.freeze({ ...READ_ONLY_ANNOTATIONS, openWorldHint: true })
const IDEMPOTENT_MUTATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
})
const DESTRUCTIVE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
})

/**
 * @param {{ discovery: string, use: string, avoid: string, parameters: string, returns: string, example: string, idempotency: string, edgeCases: string, mistakes: string }} sections
 */
function toolDescription(sections) {
  return [
    'Project selection: Pass scope_id from context_get to pin this call to one project. Omit it only for the current Claude project.',
    `Discovery: ${sections.discovery}`,
    `When to use: ${sections.use}`,
    `Do / do not: ${sections.avoid}`,
    `Parameters: ${sections.parameters}`,
    `Returns: ${sections.returns}`,
    `Example: ${sections.example}`,
    `Idempotency: ${sections.idempotency}`,
    `Edge cases: ${sections.edgeCases}`,
    `Common mistakes: ${sections.mistakes}`,
  ].join('\n')
}

const TOOL_SPECS = Object.freeze({
  context_get: Object.freeze({
    title: 'Get NAX context',
    inputSchema: contextGetInputSchema,
    outputSchema: toolResultOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Call this first; it resolves a project and reports its immutable scope, runtime, selected Netlify target, capabilities, branches, and agent catalog.',
      use: 'Confirm where later workflow and run operations will execute.',
      avoid: 'Do call before planning. Do not assume a site, branch, model, or capability from chat context.',
      parameters: 'Optional project_ref (exact local directory or known project alias) or an exact previously returned scope_id. Omit both for the current Claude project.',
      returns: 'Authenticated scope and capability metadata with exact catalog identifiers.',
      example: '{"project_ref":"/workspace/gtm-services"}',
      idempotency: 'Read-only and safe to repeat.',
      edgeCases: 'A missing local dashboard returns a command to start the scoped control plane.',
      mistakes: 'Never pass tokens, actor IDs, or site overrides. Do not guess a short project alias when exact candidates are returned.',
    }),
  }),
  workflow_list: Object.freeze({
    title: 'List NAX workflows', inputSchema: workflowListInputSchema, outputSchema: toolResultOutputSchema, annotations: READ_ONLY_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Call context_get first, then use returned capabilities to confirm workflow discovery is available.', use: 'Find exact workflow_id values and concise workflow summaries.', avoid: 'Do paginate with cursor. Do not invent workflow IDs or request full run output here.', parameters: 'Optional source, cursor, and limit from 1 to 100.', returns: 'Workflow summaries and an optional next cursor.', example: '{"source":"project","limit":20}', idempotency: 'Read-only and safe to repeat.', edgeCases: 'An empty page is valid; continue only when next_cursor is present.', mistakes: 'Do not use YOUR_WORKFLOW_ID, $WORKFLOW_ID, paths, URLs, or broadcast values.',
    }),
  }),
  workflow_get: Object.freeze({
    title: 'Get a NAX workflow', inputSchema: workflowGetInputSchema, outputSchema: toolResultOutputSchema, annotations: READ_ONLY_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Obtain workflow_id from workflow_list.', use: 'Inspect one workflow, its steps, defaults, instances, and optional graph before planning.', avoid: 'Do request the graph only when dependency structure matters. Do not treat this as execution.', parameters: 'Exact workflow_id and optional include_graph.', returns: 'One workflow definition and optionally its bounded graph.', example: '{"workflow_id":"security-review","include_graph":true}', idempotency: 'Read-only and safe to repeat.', edgeCases: 'Unknown IDs return discovery guidance and close suggestions when available.', mistakes: 'Do not pass a file path or placeholder as workflow_id.',
    }),
  }),
  workflow_plan: Object.freeze({
    title: 'Plan a remote NAX workflow', inputSchema: workflowPlanInputSchema, outputSchema: toolResultOutputSchema, annotations: PLAN_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Use context_get, workflow_list, and workflow_get before planning.', use: 'Validate and normalize one immutable remote workflow execution without starting paid Agent Runners.', avoid: 'Do inspect the plan before run_start. Do not pass transport, credentials, models maps, efforts maps, or provider-only arrays.', parameters: 'workflow_id plus optional branch, structured instances, per-step step_instances, context, only_step, or from_step.', returns: 'An expiring plan_id, resolved target, steps, instances, warnings, and expected runner count.', example: '{"workflow_id":"security-review","instances":[{"agent":"claude","model":"claude-opus-5","effort":"high"}]}', idempotency: 'Read-only planning is deterministic for equivalent normalized inputs.', edgeCases: 'only_step and from_step are mutually exclusive; MCP v1 plans Netlify API remote execution only.', mistakes: 'Every instance must be an object containing agent; never pass separate models/efforts maps.',
    }),
  }),
  agent_run_plan: Object.freeze({
    title: 'Plan one remote Agent Runner', inputSchema: agentRunPlanInputSchema, outputSchema: toolResultOutputSchema, annotations: PLAN_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Use context_get to select catalog agent/model/effort IDs.', use: 'Validate one standalone remote Agent Runner request before spending credits.', avoid: 'Do review the returned target and summary. Do not start work or accept credentials.', parameters: 'Bounded prompt, one structured instance, and optional branch.', returns: 'An expiring immutable plan_id with target, warnings, and expected runner count.', example: '{"prompt":"Audit the auth boundary","instance":{"agent":"codex","model":"gpt-5.6-sol","effort":"high"}}', idempotency: 'Read-only planning is safe to repeat.', edgeCases: 'The prompt is limited to 80 KiB and the branch must already be a concrete safe name.', mistakes: 'Do not pass agent as a bare string or add transport/token/site fields.',
    }),
  }),
  run_start: Object.freeze({
    title: 'Start a planned NAX run', inputSchema: runStartInputSchema, outputSchema: toolResultOutputSchema, annotations: IDEMPOTENT_MUTATION_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Obtain plan_id from workflow_plan or agent_run_plan.', use: 'Start exactly one reviewed immutable plan.', avoid: 'Do reuse the same request_id when retrying an ambiguous transport call. Do not add overrides.', parameters: 'Exact plan_id and caller-generated stable request_id.', returns: 'The durable run and whether the request was accepted or replayed.', example: '{"plan_id":"plan_01J...","request_id":"request_01J..."}', idempotency: 'Durably idempotent by plan_id and request_id; identical retries return the original run.', edgeCases: 'Expired plans must be replanned; a conflicting request payload requires a new request_id.', mistakes: 'Never omit request_id, invent plan_id, or retry with changed inputs.',
    }),
  }),
  run_list: Object.freeze({
    title: 'List NAX runs', inputSchema: runListInputSchema, outputSchema: toolResultOutputSchema, annotations: READ_ONLY_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Call context_get first and use workflow_list for workflow filters.', use: 'Find recent or active run_id values without loading large results.', avoid: 'Do paginate. Do not poll this tool for live events.', parameters: 'Optional exact status, workflow_id, cursor, and limit from 1 to 100.', returns: 'Compact run summaries with exact agent_run_id and review_gate_id targets.', example: '{"status":"running","limit":20}', idempotency: 'Read-only and safe to repeat.', edgeCases: 'Pages can contain fewer matches when runtime-side filtering crosses durable pagination.', mistakes: 'Use run_wait for progress and run_get for details.',
    }),
  }),
  run_get: Object.freeze({
    title: 'Get a NAX run', inputSchema: runGetInputSchema, outputSchema: toolResultOutputSchema, annotations: READ_ONLY_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Obtain run_id from run_list, run_start, or another run result.', use: 'Read one run as summary, details, graph, or a bounded event page.', avoid: 'Do request one details section when full markdown is needed. Do not request unbounded artifacts.', parameters: 'Exact run_id, required view, optional section_id for details, or since/limit for events.', returns: 'One bounded run view plus resource URIs for larger content.', example: '{"run_id":"run_01J...","view":"events","since":"12","limit":100}', idempotency: 'Read-only and safe to repeat.', edgeCases: 'section_id is details-only; since and limit are events-only.', mistakes: 'Do not use filesystem paths as section IDs or poll summary view blindly.',
    }),
  }),
  run_wait: Object.freeze({
    title: 'Wait for a NAX run', inputSchema: runWaitInputSchema, outputSchema: toolResultOutputSchema, annotations: READ_ONLY_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Obtain run_id and event cursor from run_start, run_get, or a previous run_wait.', use: 'Wait efficiently for new events, terminal state, review input, stall detection, or timeout.', avoid: 'Do pass the returned cursor into the next call. Do not busy-poll run_list.', parameters: 'Exact run_id, optional since cursor, and timeout_ms from 0 to 30000.', returns: 'Run summary, wait reason, bounded events, and next cursor.', example: '{"run_id":"run_01J...","since":"12","timeout_ms":30000}', idempotency: 'Read-only; repeating with the same cursor can replay the same observation.', edgeCases: 'Hosted runtimes may return an immediate timeout with retry guidance.', mistakes: 'Never exceed 30 seconds or fabricate cursors.',
    }),
  }),
  run_cancel: Object.freeze({
    title: 'Cancel a NAX run target', inputSchema: runCancelInputSchema, outputSchema: toolResultOutputSchema, annotations: DESTRUCTIVE_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Obtain run_id and optional exact agent_run_id from run_get or run_list.', use: 'Cancel one whole workflow run or one specifically identified active agent run.', avoid: 'Do confirm target scope and state first. Do not broadcast, cancel all, or omit agent_run_id when only one runner should stop.', parameters: 'Exact run_id, optional exact agent_run_id, and optional bounded reason.', returns: 'Resulting run state, exact cancelled target, and warnings.', example: '{"run_id":"run_01J...","agent_run_id":"agent_run_01J...","reason":"Superseded"}', idempotency: 'State-idempotent; an already terminal target returns its current state or a recoverable conflict.', edgeCases: 'Remote stop confirmation can produce warnings even when durable state changes.', mistakes: 'Never pass all, *, a provider name, or a runner URL as the target.',
    }),
  }),
  agent_run_retry: Object.freeze({
    title: 'Retry one NAX agent run', inputSchema: agentRunRetryInputSchema, outputSchema: toolResultOutputSchema, annotations: IDEMPOTENT_MUTATION_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Read the parent run and copy one exact terminal agent_run_id.', use: 'Create one replacement runner for a retryable failed agent result.', avoid: 'Do inspect state first. Do not retry active work or target by provider name.', parameters: 'Exact run_id, exact agent_run_id, and caller-generated request_id.', returns: 'Parent run, previous target ID, replacement agent run, and replay status.', example: '{"run_id":"run_01J...","agent_run_id":"agent_run_01J...","request_id":"request_01J..."}', idempotency: 'Durably idempotent by request_id; transport retries cannot create another replacement.', edgeCases: 'Legacy ambiguous targets return exact candidates and a suggested run_get.', mistakes: 'Reuse request_id only for the identical retry intent.',
    }),
  }),
  agent_run_followup: Object.freeze({
    title: 'Follow up on one NAX agent run', inputSchema: agentRunFollowupInputSchema, outputSchema: toolResultOutputSchema, annotations: IDEMPOTENT_MUTATION_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Use run_get details to obtain exact agent_run_id and artifact_id values.', use: 'Continue one exact result thread or launch explicitly configured fresh remote runners.', avoid: 'Do select only owned artifacts. Do not broadcast, pass paths, use provider-only arrays, or send separate model maps.', parameters: 'run_id, agent_run_id, request_id, bounded prompt, optional mode, artifact_ids, and structured instances.', returns: 'Source run, resulting run, created agent runs, replay status, and warnings.', example: '{"run_id":"run_01J...","agent_run_id":"agent_run_01J...","request_id":"request_01J...","prompt":"Verify the fix","artifact_ids":["artifact_summary"]}', idempotency: 'Durably idempotent by request_id for identical follow-up intent.', edgeCases: 'Repeated providers require a runtime route that preserves structured instances.', mistakes: 'Artifact IDs must come from the same run; never pass absolute paths or URLs.',
    }),
  }),
  review_gate_resolve: Object.freeze({
    title: 'Resolve one NAX review gate', inputSchema: reviewGateResolveInputSchema, outputSchema: toolResultOutputSchema, annotations: DESTRUCTIVE_ANNOTATIONS,
    description: toolDescription({
      discovery: 'Read the run and copy its exact awaiting review_gate_id.', use: 'Approve or cancel one human-review step after inspecting the run output.', avoid: 'Do make one explicit decision. Do not approve all, infer a gate, or reuse stale IDs.', parameters: 'Exact run_id, exact review_gate_id, approve/cancel decision, and optional reason.', returns: 'Resulting run and resolved gate state.', example: '{"run_id":"run_01J...","review_gate_id":"review_gate_01J...","decision":"approve"}', idempotency: 'State-idempotent for an identical decision; conflicting stale decisions return current state.', edgeCases: 'A gate that is no longer awaiting input requires a fresh run_get.', mistakes: 'Never use step title, all, *, or a placeholder instead of review_gate_id.',
    }),
  }),
})

const TOOL_INPUT_SCHEMAS = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_SPECS).map(([name, spec]) => [name, spec.inputSchema]),
))

module.exports = {
  DESTRUCTIVE_ANNOTATIONS,
  IDEMPOTENT_MUTATION_ANNOTATIONS,
  MAX_ARTIFACTS,
  MAX_CONTEXT_BYTES,
  MAX_EVENT_LIMIT,
  MAX_INSTANCES,
  MAX_PAGE_LIMIT,
  MAX_PROMPT_BYTES,
  MAX_REASON_BYTES,
  MAX_WAIT_MS,
  PLAN_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  RUN_STATUSES,
  TOOL_INPUT_SCHEMAS,
  TOOL_SPECS,
  agentInstanceSchema,
  entityId,
  toolDescription,
  toolResultOutputSchema,
}
