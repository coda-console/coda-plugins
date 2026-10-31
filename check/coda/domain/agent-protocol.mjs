import { AGENT_SCHEMAS, agentMessageProblem, agentValueProblem } from '@coda-console/protocol/agent';

// What Coda says to an agent and takes from it beside the connection itself (coda-protocol docs/agent-protocol.md): the capabilities it
// sends, session instructions, steering, the agent's own waits, and how long Coda waits on it. Part of the plugin contract
// coda-plugins' check is given as written (scripts/plugin-contract.mjs).

// `initialize` as Coda sends it.
export const clientCapabilities = () => ({
  elicitation: { form: {}, url: {} },
  // A config option may be a switch: shown as one, its value on or off (`options`).
  session: { compaction: {}, configOptions: { boolean: {} } },
  // Coda takes the agent's own waits, and relays what is asked of the session from outside to an agent that takes it.
  _meta: { coda: { waits: {}, remote: {} } },
});
// The remote entry (「远端入口」): an agent whose work is done elsewhere (a bot on its own computer) declares it; the code to
// bind that place to its session is asked of Coda (`REMOTE_CODE`), and what that place then asks of the session is handed
// to the agent (`REMOTE`) as it was asked.
export const REMOTE = '_coda/remote', REMOTE_CODE = '_coda/remote/code';
export const supportsRemote = init => init?.agentCapabilities?._meta?.coda?.remote != null
  && typeof init.agentCapabilities._meta.coda.remote === 'object';
// The agent refuses until it is signed in (ACP's auth_required).
export const SIGNED_OUT = -32000;
// Session instructions (「会话指令」): ACP's `systemPrompt`, only to an agent that declares it, the same on every open of
// the session, appended in one text block.
export const takesInstructions = init => init?.agentCapabilities?.sessionCapabilities?.systemPrompt != null;
export const systemPrompt = text => ({ mode: 'append', content: [{ type: 'text', text }] });
// Steering (「插话」): declared beside the capabilities, as the extension has it, and sent only while a turn is under way.
// The agent answers `STEERED` when the message joined the running turn and `NOT_STEERED` when the turn had ended; anything
// else leaves the message of unknown fate.
export const STEERING = '_session/steering';
export const STEERED = 'injected', NOT_STEERED = 'promptRequired';
export const supportsSteering = init => init?._meta?.steering?.supported === true;
export const steeringParams = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: NOT_STEERED } } });
// The model a session runs with: its model option's value, else what ACP's older `models` names.
export const currentModel = session => session?.configOptions?.find?.(x => x?.category === 'model')?.currentValue ?? session?.models?.currentModelId;

// What an agent may say of a wait of its own (「_coda/wait」); anything else is dropped unread.
export const WAIT_STATES = new Set(AGENT_SCHEMAS['wait.json'].properties.state.enum);
export const validWait = p => agentMessageProblem('_coda/wait', p) === null;
// What the agent's own check of a tool call said before running it (「工具调用的审核」): `_meta.coda.review` of the call's
// `tool_call` or `tool_call_update`, as Coda keeps it; null for anything else. A risk it does not know is left out.
export const toolReview = r => agentValueProblem('review.json', r) === null
  ? { state: r.state, ...(r.reason ? { reason: r.reason } : {}),
    ...(agentValueProblem('review.json#/$defs/risk', r.risk) === null ? { risk: r.risk } : {}) } : null;

// Opening a session (initialize, then session/new or session/load) may take this long.
export const OPEN_LIMIT = 60_000;
// A turn the user stops ends within this, or Coda closes the agent's process group (「Agent 活动」).
export const STOP_LIMIT = 30_000;
// Coda stops an agent with SIGTERM to its process group, and SIGKILL this long after.
export const TERM_GRACE = 800;
