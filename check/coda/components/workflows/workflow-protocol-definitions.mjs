// Coda's own protocols of its workflows, as data: `coda/workflow@1`, `coda/workflow-run@1` and the query of `coda/thread@1` they
// answer (`withWorkflows`), each a definition and the schemas it is made of (./workflow-protocols.mjs says what they are and
// gives their records). Nothing here runs: application/host-protocols.mjs lists them for the backend and the plugin host for
// a plugin's tests (adapters/plugin-test-host.mjs) alike.
import { INPUT_SOURCES, INPUT_TYPES } from '@coda-console/protocol/workflow';
import { derivedUUID } from '../../domain/values.mjs';

// A text input's length: room for what one workflow hands another, such as release notes (`run-workflows`), for a
// command the user is asked to approve, as long as its card takes (`approve-command`, components/workflows/task-fields.mjs),
// and for a task's note (workflow-tasks.mjs), which a process may take as such a text: release notes, an executor's next task.
export const INPUT_LIMIT = 16 * 1024;
// The most a run's requirement says (`run.message`): what a message takes (store acceptMessage).
export const MESSAGE_LIMIT = 100_000;

export const WORKFLOW = 'coda/workflow@1';
// Coda's sessions, whose directory's workflows are a query of theirs these answer (`withWorkflows`).
export const THREAD = 'coda/thread@1';
export const WORKFLOW_RUN = 'coda/workflow-run@1';
// A workflow's record is named by its directory and its name: the same workflow of the same directory is the same record
// on every reading. A run's record is named by the run's ID.
export const workflowRecordId = (project, workflow) => derivedUUID(WORKFLOW, project, workflow);

export const object = (properties, required = [], rest = {}) =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false, ...rest });
export const list = items => ({ type: 'array', items });
const text = { type: 'string', minLength: 1 };
const flag = { type: 'boolean' };
const count = { type: 'integer', minimum: 0 };
export const time = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' };
const timeOrNull = { ...time, type: ['string', 'null'] };
const textOrNull = { ...text, type: ['string', 'null'] };
// A workflow's file name, without `.bpmn` (components/workflows/workflow.mjs workflowName).
const workflowName = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' };
const SOURCES = Object.keys(INPUT_SOURCES);

// An Agent combination, the value of an `agent` input (session-config/contributions.mjs `coda-agent`).
const AGENT = object({
  agent: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
  model: text, effort: text, mode: text,
  options: { type: 'object', additionalProperties: { anyOf: [flag, { type: 'string', minLength: 1, maxLength: 200 }] } },
}, ['agent']);
// A value given for an input, of its declared type; a run's own inputs, as resolved, leave an `agent` one with none null.
const VALUE = { anyOf: [{ type: 'string', maxLength: INPUT_LIMIT }, { type: 'number' }, flag, AGENT] };
const RESOLVED = { anyOf: [...VALUE.anyOf, { type: 'null' }] };
// An input as the workflow declares it (`coda:input`, components/workflows/bpmn.mjs).
const INPUT = {
  type: { enum: INPUT_TYPES }, label: text, description: text, required: flag,
  defaultFrom: { enum: SOURCES }, default: { type: ['string', 'number', 'boolean'] },
};
// Where an input takes its value from when a run is given none: a value, or a source of the session it starts from.
const RULE = { oneOf: [object({ value: VALUE }, ['value']), object({ from: { enum: SOURCES } }, ['from'])] };
// What the sources give in a session now (INPUT_SOURCES): its branch, its Agent combination.
const SOURCE_VALUES = object(Object.fromEntries(Object.entries(INPUT_SOURCES)
  .map(([name, { types }]) => [name, types.includes('agent') ? AGENT : text])));

// The outputs a step or a run gives (a step's `$GITHUB_OUTPUT`, the end event's `coda:output`).
const OUTPUTS = { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } };
const RUN_STATE = { enum: ['waiting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'] };
// A step's attempt, or `pending` / `skipped` for one this round has not reached.
const JOB_STATE = { enum: ['pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'] };

// What the user, a session or its project set for a workflow (components/workflows/workflow-settings.mjs), as a session
// sees it: whether the events that start it by themselves do (only for one they start, `startedBy`), each input's rule
// and the value it would take now, and where each comes from (`SEEN`); and what the session's sources give now.
export const SEEN = {
  enabled: object({ value: flag, source: { enum: ['session', 'project', 'plugin', 'template'] } }, ['value', 'source']),
  inputs: list(object({ name: text, ...INPUT, rule: RULE, source: { enum: ['session', 'project', 'template'] }, value: RESOLVED },
    ['name', 'type', 'source', 'value'])),
};
export const SETTINGS = object({ ...SEEN, sources: SOURCE_VALUES }, ['inputs', 'sources']);

// A run as it stands (workflow_status of one run, components/workflows/workflow-run-records.mjs `describe`): its state and
// round (`attempt`), what its card says (title, line, stages, the messages from the user it waits on), whether a resume
// goes on where it failed (`rerun`), its place in the queue, its workspace's retention, its times, how it ended, each step
// with its attempt and that attempt's steps and sessions, each user task of the round, and the runs it called. What a task
// asks (its choices, fields) is on its card; a step's log is read as the stream `log`, not by a path on the machine that ran it.
export const STEP = object({
  index: count, name: text,
  state: { enum: ['pending', 'running', 'success', 'failure', 'cancelled', 'skipped'] },
  conclusion: { enum: [null, 'success', 'failure', 'cancelled', 'skipped'] },
  // How it went before `continue-on-error` made a failure its conclusion's success.
  outcome: { enum: [null, 'success', 'failure', 'cancelled', 'skipped'] },
  exitCode: { type: ['integer', 'null'] }, startedAt: timeOrNull, finishedAt: timeOrNull,
}, ['index', 'name', 'state', 'conclusion', 'exitCode', 'startedAt', 'finishedAt']);
export const JOB = object({
  job: text, name: text, needs: list(text), group: text, state: JOB_STATE,
  // Its current attempt, 0 before the first; the commit, error and outputs of that attempt.
  attempt: count, commit: textOrNull, error: { type: ['string', 'null'] }, outputs: OUTPUTS,
  queuedAt: timeOrNull, startedAt: timeOrNull, finishedAt: timeOrNull,
  // The line it is at while it runs, and why and until when its agent is held up, the how-manieth time.
  step: text, blocked: object({ reason: text, until: time, attempt: { type: 'integer', minimum: 1 } }, ['reason', 'until', 'attempt']),
  steps: list(STEP),
  // The sessions its `coda-agent` steps started, every attempt's.
  agents: list(object({ session: text, title: { type: 'string' }, agent: text, model: text, effort: text,
    step: { type: ['integer', 'null'], minimum: 0 }, attempt: { type: 'integer', minimum: 1 } }, ['session', 'title', 'agent', 'attempt'])),
  // Every attempt of it whose history is kept, oldest first: how each went and ended.
  attempts: list(object({ attempt: { type: 'integer', minimum: 1 }, state: JOB_STATE, startedAt: timeOrNull, finishedAt: timeOrNull,
    error: { type: ['string', 'null'] } }, ['attempt', 'state', 'startedAt', 'finishedAt', 'error'])),
  // Its attempts' logs reclaimed past their retention.
  logsPruned: flag,
  // Its current attempt's sessions wait on a card of theirs, the run then held up by the user, not by its work.
  agentNeedsInput: { const: true },
}, ['job', 'name', 'needs', 'state', 'attempt', 'steps', 'agents']);
// An answer a user task offers (components/workflows/bpmn.mjs parseChoices).
const CHOICE_FACTS = { id: text, name: text, detail: { type: 'string' }, primary: { const: true }, note: { const: 'required' }, fields: list(text),
  options: list({ type: 'object' }) };
const CHOICE = object({ ...CHOICE_FACTS, more: list(object(CHOICE_FACTS, ['id', 'name'])) }, ['id', 'name']);
// A user task of this round: whom an open one waits on (`agent`, `input` the user) since when, its ID (what `task` answers),
// its card while open and the answers it offers (`choices`, as the process declares them: `more` held one level down), whether
// its card has fields to fill (`form`, answered there), whether its holding session is told of it only with its next input
// (`toldAlong`); what it asks the agent (`instructions`, not said of one for the user); how a decided one was.
export const TASK = object({
  step: text, name: text, state: { enum: ['pending', 'skipped', 'agent', 'input', 'succeeded', 'failed', 'cancelled'] },
  task: text, assignee: { enum: ['agent', 'user'] }, holder: text, card: text, since: time, choices: list(CHOICE), form: { const: true },
  toldAlong: { const: true }, instructions: text,
  startedAt: time, finishedAt: timeOrNull, decidedBy: text, note: text,
}, ['step', 'name', 'state']);
// Where a node, or an instance of it, stands this round, as its kind, its step or its task says (workflow-graph.mjs `shown`).
const NODE_STATE = { enum: ['pending', 'queued', 'running', 'waiting', 'agent', 'input', 'finishing', 'succeeded', 'failed', 'cancelled', 'skipped'] };
// What a node of the process is (workflow-graph.mjs `bpmnGraph`): an event node by its event (a caught error is `boundary`).
const NODE_KIND = { enum: ['start', 'end', 'event', 'job', 'action', 'task', 'call', 'manual', 'step', 'subprocess', 'gateway', 'boundary',
  'timer', 'message', 'signal', 'conditional', 'escalation', 'link', 'compensation', 'cancel'] };
// Where the run is while it goes (workflowGraph `current`): each instance going that nothing else goes inside, since when,
// and when one waiting on a timer is due.
export const PLACE = object({ node: text, executionId: text, name: text, kind: NODE_KIND, parent: text, state: NODE_STATE, since: time, dueAt: time },
  ['node', 'name', 'kind', 'state', 'since']);
// An event it listens for meanwhile, no instance of its node until it happens (workflowGraph `listening`): a boundary
// event beside an activity (`attachedTo`), one an event-based gateway races, a start event of an event subprocess; by
// its kind, the message it waits for or the timer it is set to and when that is due, since when it listens.
export const LISTENING = object({ node: text, executionId: text, name: text, kind: NODE_KIND, parent: text, attachedTo: text,
  message: text, timer: text, since: time, dueAt: time }, ['node', 'name', 'kind']);
// The runs a node called (`run-workflows`, a call activity).
export const CALLED = list(object({ run: text, workflow: workflowName, name: text, state: RUN_STATE }, ['run', 'workflow', 'name', 'state']));
// The whole drawing of the run (`graph`): each node as the process declares it (`bpmnGraph`) with where it stands this
// round (its latest instance, how many and how they ended, whether it is only listened for, the line it shows), each flow
// with how often it was taken, and where the run is. A node's step or task is the status's job of the same id.
export const GRAPH = object({
  nodes: list(object({
    id: text, name: text, kind: NODE_KIND, type: text,
    triggeredByEvent: { const: true }, throw: { const: true }, eventGateway: text, interrupting: { const: false },
    loop: { enum: ['sequential', 'parallel'] }, forCompensation: { const: true }, lane: text,
    inspect: list(object({ label: text, type: { enum: ['string', 'number', 'boolean', 'timestamp'] }, value: text, phase: { enum: ['input', 'output'] } },
      ['label', 'type', 'value', 'phase'])),
    parent: text, attachedTo: text, group: text, action: text, message: text, timer: text,
    state: NODE_STATE, visits: count, counts: object({ active: count, succeeded: count, failed: count, cancelled: count }, ['active', 'succeeded', 'failed', 'cancelled']),
    executionId: text, startedAt: time, finishedAt: time, dueAt: time, listener: { const: true }, detail: text, since: time, called: CALLED,
  }, ['id', 'name', 'kind', 'type', 'state'])),
  edges: list(object({ id: text, from: text, to: text, name: text, default: { const: true }, boundary: { const: true }, link: { const: true },
    compensation: { const: true }, taken: count }, ['id', 'from', 'to'])),
  current: list(PLACE), listening: list(LISTENING),
}, ['nodes', 'edges', 'current', 'listening']);
// A round the run went (its first, then each resume or re-run): for which session it was, if any, by the user or not, and
// where in that session's history it started and ended (`startedAfterSeq`, `afterSeq`); whether its end is told (`reportResult`),
// whether it went on where the last failed (`resumed`), and how it ended.
export const ROUND = object({ session: text, startedAt: time, startedAfterSeq: { type: ['integer', 'null'] }, byUser: { const: true }, reportResult: flag,
  resumed: { const: true }, state: RUN_STATE, endedAt: time, afterSeq: { type: ['integer', 'null'] } }, ['startedAt']);
export const RUN_STATUS = object({
  state: RUN_STATE, attempt: { type: 'integer', minimum: 1 }, rounds: list(ROUND),
  // Where it is and what it listens for, while it goes (empty once it ended); the whole drawing is `graph`'s.
  current: list(PLACE), listening: list(LISTENING),
  // `lineLive`: whether the step that wrote the line still runs; once it ended, the line stays and says so.
  title: text, line: text, lineLive: flag,
  stages: list(object({ id: text, name: text, state: { enum: ['pending', 'running', 'agent', 'input', 'succeeded', 'failed', 'cancelled', 'skipped'] } },
    ['id', 'name', 'state'])),
  messages: list(object({ name: { type: 'string', pattern: '^user\\.' }, label: text }, ['name', 'label'])),
  // The steps for the user's eyes only (`coda:audience="user"`), not among `jobs`: the user's page reads them with `private`.
  userOnly: list(text),
  cancelRequested: { const: true }, rerun: { enum: ['resume', 'start', 'caller'] }, ahead: count,
  workspace: object({ state: { enum: ['active', 'retained', 'reclaimed'] }, cleanupAfter: timeOrNull, reclaimedAt: timeOrNull },
    ['state', 'cleanupAfter', 'reclaimedAt']),
  createdAt: time, startedAt: timeOrNull, finishedAt: timeOrNull,
  // How it ended: what went wrong, what it gives, and the outcome told to whoever started it.
  error: text, outputs: OUTPUTS, result: text,
  jobs: list(JOB), tasks: list(TASK),
  called: CALLED,
  // A text that changes as what `requirement` gives does (the runs under it moving among it), for a page to ask it again by.
  requirementRevision: text,
}, ['state', 'attempt', 'current', 'listening', 'createdAt', 'startedAt', 'finishedAt', 'jobs', 'tasks', 'called'],
  { dependentRequired: { line: ['lineLive'] } });

// A node's instances in this round, newest last, a page at a time (components/workflows/workflow-run-records.mjs
// `nodeHistory`): each with what it was given and gave, the conditions it took its way by, the attempt or task it was and
// the runs it called. `next` is the `before` of the page before it, null at the first.
const FIELD = object({ label: text, type: text, source: text, value: { type: ['string', 'number', 'boolean'] },
  missing: { const: true }, truncated: { const: true }, sourceLabel: text }, ['source']);
const INSTANCE = object({
  executionId: text, ordinal: count, parent: text, iteration: { type: ['integer', 'null'] },
  state: NODE_STATE,
  startedAt: time, endedAt: timeOrNull, dueAt: timeOrNull,
  inputs: list(FIELD), outputs: list(FIELD),
  conditions: list(object({ id: text, name: text, expression: text, inputs: list(FIELD), label: text, default: flag, error: text, result: flag }, ['id'])),
  taken: list(text), error: text,
  attempt: object({ attempt: { type: 'integer', minimum: 1 }, state: JOB_STATE, queuedAt: timeOrNull, startedAt: timeOrNull,
    finishedAt: timeOrNull, error: text }, ['attempt', 'state']),
  task: object({ state: { enum: ['open', 'completed', 'rejected', 'withdrawn'] }, assignee: { enum: ['agent', 'user'] }, decidedBy: text, note: text },
    ['state', 'assignee']),
  called: list(object({ run: text, workflow: workflowName, state: RUN_STATE }, ['run', 'workflow', 'state'])),
}, ['executionId', 'state', 'startedAt']);
const HISTORY = object({ instances: list(INSTANCE), retainedInstances: count, historyPruned: flag,
  next: { type: ['integer', 'null'], minimum: 1 } }, ['instances', 'retainedInstances', 'historyPruned', 'next']);
// The requirement the run was started for (components/workflows/workflow-run-records.mjs `requirement`): its words, every run
// under it (each by the node of its caller that called it and that caller's round), the sessions its steps and its own agent
// are, and the user tasks of those runs — each kept to its share of the bytes, `truncated` saying which was cut.
const REQUIREMENT = object({
  message: { type: 'string' },
  truncated: object({ message: flag, runs: flag, sessions: flag, tasks: flag }, ['message', 'runs', 'sessions', 'tasks']),
  runs: list(object({ run: text, workflow: workflowName, name: text, state: RUN_STATE, error: text, createdAt: time, startedAt: timeOrNull, finishedAt: timeOrNull,
    parent: text, node: object({ id: text, name: text }, ['id', 'name']), round: { type: 'integer', minimum: 1 }, callerRound: { type: 'integer', minimum: 1 },
    outputs: OUTPUTS }, ['run', 'workflow', 'name', 'state', 'createdAt', 'startedAt', 'finishedAt', 'outputs'])),
  sessions: list(object({ session: text, title: { type: 'string' }, agent: text, archived: flag,
    role: object({ main: { const: true }, run: text, node: text, name: text, attempt: { type: 'integer', minimum: 1 }, step: { type: ['integer', 'null'], minimum: 0 } }, ['run']) },
  ['session', 'title', 'agent', 'archived', 'role'])),
  tasks: list(object({ task: text, run: text, round: { type: 'integer', minimum: 1 }, node: text, name: text, state: { enum: ['open', 'completed', 'rejected', 'withdrawn'] },
    assignee: { enum: ['agent', 'user'] }, turn: { enum: ['agent', 'user'] }, holder: text, decidedBy: text, choice: object({ id: text, name: text }, ['id', 'name']),
    note: text, createdAt: time, decidedAt: timeOrNull }, ['task', 'run', 'round', 'node', 'name', 'state', 'assignee', 'createdAt', 'decidedAt'])),
}, ['message', 'truncated', 'runs', 'sessions', 'tasks']);
// How each of its jobs ended in the latest runs of its workflow in its directory that ended, up to it, oldest first; null in
// one a job did not run in.
const RECENT = object({ jobs: list(object({ job: text, history: list({ enum: [...JOB_STATE.enum, null] }) }, ['job', 'history'])) }, ['jobs']);

export const WORKFLOW_PROTOCOL = {
  kind: WORKFLOW,
  title: '流程',
  // What the workflow is, as `workflow_list` gives each (components/workflows/workflow-definitions.mjs `list`): of which
  // directory and by which name, a plugin's when a plugin brings it (and the directory has no file of that name), a
  // capability when it is only called; read from the directory's default branch as last fetched, or the plugin. Its
  // inputs, whether it runs only merged commits, whether it can be started by hand, the hooks it joins, the events that
  // start it by themselves, its schedule, its key, its `coda:autoRun`, whether it follows sessions from their opening;
  // or, for one that cannot be read, why (`error`) instead.
  // No `runsOn`: the executors are gone (结构减负), and `listed()` no longer gives the labels a workflow's steps need.
  spec: object({
    project: text, workflow: workflowName, plugin: text, capability: { const: true },
    name: text, inputs: { type: 'object', additionalProperties: object(INPUT, ['type']) },
    mergedOnly: flag, manual: flag,
    joins: list(object({ hook: text, name: text, detail: text, default: flag, order: { type: 'number' },
      inputs: list(object({ id: text, label: text }, ['id', 'label'])) }, ['hook', 'default'])),
    startedBy: list(text), schedule: object({ cycle: text, once: flag }, ['cycle', 'once']),
    key: text, autoRun: text, lifecycle: { const: true },
    error: text,
  }, ['project', 'workflow'], { oneOf: [{ required: ['error'] }, { required: ['name', 'inputs', 'mergedOnly', 'manual'] }] }),
  // What changes of it in its directory: the branch and commit it was read from (none for a plugin's), what was set for
  // it in the directory, its schedule there (when it next starts, or why it does not), the events it starts on that
  // nothing here publishes, and the plugins that bring the same name when two do (it is refused until one is disabled).
  status: object({
    ref: text, commit: text,
    settings: object({ enabled: flag, inputs: { type: 'object', additionalProperties: RULE } }, ['inputs']),
    schedule: object({ cycle: text, next: timeOrNull, off: { const: true }, error: text, project: text }, ['cycle']),
    unheard: list(text), conflicts: list(text),
  }, ['settings']),
  operations: {
    // Starts it from `session`, as the session's "+" does (`workflow_run`, as the user's): on the newest commit of the
    // session's branch, with `inputs` (the rest as the session sets them, else as declared) and `message`, the requirement
    // it goes with, sent into the session as the user's message. A call here has no session of its own: no `commit`, and
    // no `confirm`: the card only a session's agent can propose (its workflow tool's own arguments), and this way does not take it.
    run: { input: object({
      session: text, inputs: { type: 'object', additionalProperties: VALUE }, message: { type: 'string', maxLength: MESSAGE_LIMIT },
    }, ['session']),
    result: object({ run: text, status: RUN_STATUS, reused: { const: true } }, ['run', 'status']) },
    // What is set for it as `session` sees it, or as set for its directory without one.
    settings: { safe: true, input: object({ session: text }), result: SETTINGS },
    // Sets it, from `session`, for the session alone or for its directory (`project`): whether the events that start it do
    // (`enabled`, null goes back to what comes after) and its inputs' rules (null clears one). Set for the directory, the
    // session drops its own of what was set, following its directory. Gives what `settings` gives after, for the session.
    'save-settings': { idempotent: true, input: object({
      scope: { enum: ['session', 'project'] }, session: text, enabled: { type: ['boolean', 'null'] },
      inputs: { type: 'object', additionalProperties: { anyOf: [RULE, { type: 'null' }] } },
    }, ['scope', 'session']), result: SETTINGS },
  },
  // What a plugin may ask for in its `uses` (docs/plugins.md「用到的权限」), on trial while the protocol is not stable.
  permissions: {
    read: { title: '查看各目录里可用的流程与它们的设置', trial: true, read: true, operations: ['settings'] },
    run: { title: '发起流程', trial: true, operations: ['run'] },
    configure: { title: '修改流程在会话或目录里的设置', trial: true, operations: ['save-settings'] },
  },
  // Its doing operations are the workflows', on the backend that holds the record (`workflowOperations`).
  side: 'workflows',
};

// The workflows of a session's directory, as its workflows panel reads them as it opens (#2749 3.5: what a panel takes at
// once is one query of the record it is of): a query of `coda/thread@1` the workflows answer, added to it as it is
// registered (`withWorkflows`). Each workflow the user may start there, or an event may (not a capability, which is called,
// nor a lifecycle, which follows sessions, nor one only a schedule starts): its record's ID and what it is, and what is set
// for it as the session sees it (not for one that cannot be read); what the session's sources give now; and why the
// directory's own could not be read, when they could not (no `origin/main`, no repository: `error`), so that none read is
// not none there; a plugin's, which plugin by its name. A group of its own, not `read`'s: it says what is set.
export const THREAD_WORKFLOWS = {
  safe: true, input: object({}),
  result: object({
    project: text,
    workflows: list(object({ id: text, spec: WORKFLOW_PROTOCOL.spec, plugin: object({ id: text, name: text }, ['id', 'name']), settings: object(SEEN, ['inputs']) }, ['id', 'spec'])),
    sources: SOURCE_VALUES, error: text,
  }, ['project', 'workflows', 'sources']),
};
export const withWorkflows = protocol => ({ ...protocol, operations: { ...protocol.operations, workflows: THREAD_WORKFLOWS },
  permissions: { ...protocol.permissions, workflows: { title: '查看会话的目录里能发起的流程，以及它们在这个会话里的设置', trial: true, operations: ['workflows'] } } });

export const WORKFLOW_RUN_PROTOCOL = {
  kind: WORKFLOW_RUN,
  title: '流程运行',
  // Where the run comes from: the workflow of which directory (its record `workflowRecordId(project, workflow)`), a
  // plugin's or a capability, under which name; the commit and branch it runs on (none for a plugin's that checks nothing
  // out; a resume with `commit` moves it), the inputs it was started with as resolved, the requirement it goes with, its
  // key; and who started it (`origin`): an agent, the user, an event, a schedule or another run (`parent`), for which
  // session (`session`, whom it reports to), and for a session's lifecycle, the session it follows (`subject`).
  spec: object({
    project: text, workflow: workflowName, plugin: text, capability: { const: true }, name: text,
    commit: textOrNull, ref: textOrNull,
    inputs: { type: 'object', additionalProperties: RESOLVED },
    message: { type: 'string', maxLength: MESSAGE_LIMIT }, key: text,
    origin: object({ by: { enum: ['agent', 'user', 'event', 'schedule', 'run'] }, session: text, parent: text, event: text, subject: text }, ['by']),
  }, ['project', 'workflow', 'name', 'commit', 'ref', 'inputs', 'origin']),
  status: RUN_STATUS,
  operations: {
    // Cancels a run waiting or going (`workflow_cancel`); renews a failed or cancelled one's workspace and artifacts for
    // another stretch from now (`workflow_renew`); resumes a failed or cancelled one (`workflow_resume`): where it failed,
    // or from its start (`from`), on its commit, on `commit`, or on the newest commit of its branch (`latest`). Each
    // gives the run as it stands after.
    cancel: { input: object({}), result: RUN_STATUS },
    renew: { input: object({}), result: RUN_STATUS },
    resume: { input: object({ commit: text, from: { type: 'string', enum: ['start'] }, latest: { const: true } }, [], { not: { required: ['commit', 'latest'] } }),
      result: RUN_STATUS },
    // Answers a task the run gave the caller's session (`workflow_task`), which only the task's holder may — a caller that
    // is no session (the user, through a plugin's page), one that waits on the user —: `completed` with the `choice`
    // taken, its `options` and their `inputs`, or `rejected`, with `note`; or hands it up (`handUp`) to the level above,
    // with what is to be done in `note`, which only a session does.
    task: { input: object({
      task: text, result: { type: 'string', enum: ['completed', 'rejected'] }, handUp: flag, choice: text,
      options: { type: 'object', additionalProperties: flag },
      inputs: { type: 'object', additionalProperties: { type: 'string', maxLength: INPUT_LIMIT } },
      note: { type: 'string', maxLength: INPUT_LIMIT },
    }, ['task'], { if: { properties: { handUp: { const: true } }, required: ['handUp'] }, then: { required: ['note'] }, else: { required: ['result'] } }),
    result: object({ task: text, name: text, result: { enum: ['completed', 'rejected'] }, choice: text, handedUp: { const: true } }, ['task', 'name'],
      { oneOf: [{ required: ['result'] }, { required: ['handedUp'] }] }) },
    // A message from the user that the run waits on (one of its status's `messages`), as its page's button sends it.
    message: { input: object({ name: { type: 'string', pattern: '^user\\.' } }, ['name']), result: RUN_STATUS },
    // A page of a node's instances in this round, before `before` (a page's `next`), the latest without.
    history: { safe: true, input: object({ node: text, before: { type: 'integer', minimum: 1 } }, ['node']), result: HISTORY },
    // The whole drawing of the run as it stands, for its page to draw.
    graph: { safe: true, input: object({}), result: GRAPH },
    // The requirement it was started for, with the runs under it, their sessions and tasks; asked again as its status's
    // `requirementRevision` changes.
    requirement: { safe: true, input: object({}), result: REQUIREMENT },
    // Its jobs' results in the latest runs of its workflow in its directory.
    recent: { safe: true, input: object({}), result: RECENT },
    // Its steps for the user's eyes only (its status's `userOnly`), as the user's page shows them: refused to a session.
    private: { safe: true, input: object({}), result: object({ jobs: list(JOB) }, ['jobs']) },
  },
  // A step's output as it is (`text/plain`), from byte `after` to its end as it is read, not cut and not followed: step `step`
  // of the job, or the job's own log (`job`), of its current attempt or of `attempt` (transport/record-streams.mjs). Read on
  // from where it was (`after`, the bytes read), the attempt is named, so that one begun meanwhile is not read on.
  streams: {
    log: { input: object({ job: text, step: { type: 'string', pattern: '^(?:[0-9]+|job)$' }, attempt: { type: 'string', pattern: '^[1-9][0-9]*$' },
      after: { type: 'string', pattern: '^[0-9]+$' } }, ['job', 'step']) },
  },
  permissions: {
    read: { title: '查看流程运行：进度、流程图、步骤、节点历史、日志、需求与最近的结果', trial: true, read: true,
      operations: ['history', 'graph', 'requirement', 'recent', 'private'], streams: ['log'] },
    control: { title: '取消、续期、重跑流程运行，或替你点运行在等的按钮', trial: true, operations: ['cancel', 'renew', 'resume', 'message'] },
    task: { title: '答复流程交给会话的任务', trial: true, operations: ['task'] },
  },
  side: 'workflows',
};
