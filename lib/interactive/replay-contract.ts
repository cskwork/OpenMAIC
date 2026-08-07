/**
 * Deterministic, browser-observed contract for replaying an interactive HTML
 * scene.  The inspector deliberately uses a sandboxed iframe and a tiny
 * postMessage protocol so the inspected page never gets same-origin access to
 * the host (and the host never needs to grant allow-same-origin).
 */

export const REPLAY_CONTRACT_VERSION = 1 as const;

export type ReplayVisibility = 'visible' | 'hidden' | 'off-viewport' | 'occluded' | 'unknown';
export type ReplayControlKind = 'button' | 'toggle' | 'input';
export type ReplayCapabilityStatus = 'supported' | 'unsupported' | 'risk' | 'not-detected';

export interface ReplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReplayTarget {
  selector: string;
  tagName: string;
  text: string;
  visibility: ReplayVisibility;
  reasons: string[];
  rect: ReplayRect;
  disabled: boolean;
}

export interface ReplayControl {
  selector: string;
  kind: ReplayControlKind;
  tagName: string;
  label: string;
  inputType?: string;
  bounded: boolean;
  safe: boolean;
  operationValue?: string | number | boolean;
  reason?: string;
}

export interface ReplaySnapshot {
  signature: string;
  targets: ReplayTarget[];
  visible: string[];
  hidden: string[];
  offViewport: string[];
  occluded: string[];
}

export interface ReplayOperation {
  kind: 'click' | 'toggle' | 'input';
  selector: string;
  value?: string | number | boolean;
}

export interface ReplayTransition {
  depth: number;
  operation: ReplayOperation;
  preconditions: { target: string; visibility: ReplayVisibility; enabled: boolean };
  postconditions: {
    changed: boolean;
    visible: string[];
    hidden: string[];
    offViewport: string[];
    occluded: string[];
  };
  wait: { settled: boolean; timeoutMs: number };
  before: ReplaySnapshot;
  after: ReplaySnapshot;
}

export interface ReplayCapabilities {
  reset: ReplayCapabilityStatus;
  timers: ReplayCapabilityStatus;
  canvas: ReplayCapabilityStatus;
  webgl: ReplayCapabilityStatus;
  media: ReplayCapabilityStatus;
  externalResources: ReplayCapabilityStatus;
  nondeterminism: ReplayCapabilityStatus;
  navigation: ReplayCapabilityStatus;
  popups: ReplayCapabilityStatus;
  fileOperations: ReplayCapabilityStatus;
}

export interface ReplayDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  selector?: string;
}

export interface ReplayLimits {
  maxOperations: number;
  maxDepth: number;
  maxStates: number;
  operationTimeoutMs: number;
}

export interface ReplayContract {
  version: typeof REPLAY_CONTRACT_VERSION;
  sourceHtmlHash: string;
  viewport: { width: number; height: number };
  initial: ReplaySnapshot;
  targets: ReplayTarget[];
  controls: ReplayControl[];
  transitions: ReplayTransition[];
  capabilities: ReplayCapabilities;
  diagnostics: ReplayDiagnostic[];
  limits: ReplayLimits;
  exploredStates: number;
  exploredOperations: number;
}

export interface ReplayInspectorOptions {
  viewport?: { width: number; height: number };
  maxOperations?: number;
  maxDepth?: number;
  maxStates?: number;
  operationTimeoutMs?: number;
  settleMs?: number;
}

const DEFAULT_LIMITS: ReplayLimits = {
  maxOperations: 24,
  maxDepth: 1,
  maxStates: 32,
  operationTimeoutMs: 1_200,
};

const SAFE_INPUT_MAX = 64;
const CAPABILITY_KEYS: Array<keyof ReplayCapabilities> = [
  'reset',
  'timers',
  'canvas',
  'webgl',
  'media',
  'externalResources',
  'nondeterminism',
  'navigation',
  'popups',
  'fileOperations',
];

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function statusFor(found: boolean, risky = false): ReplayCapabilityStatus {
  if (!found) return 'not-detected';
  return risky ? 'risk' : 'unsupported';
}

/** Static, DOM-free capability scan used before opening a browser frame. */
export function analyzeReplayHtml(html: string): {
  capabilities: ReplayCapabilities;
  diagnostics: ReplayDiagnostic[];
} {
  const has = (pattern: RegExp) => pattern.test(html);
  const diagnostics: ReplayDiagnostic[] = [];
  const capabilities: ReplayCapabilities = {
    reset: 'supported',
    timers: statusFor(has(/\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/), true),
    canvas: statusFor(has(/<canvas\b/i)),
    webgl: statusFor(has(/\b(?:webgl|webgl2|getContext\s*\(\s*['"]experimental-webgl)/i), true),
    media: statusFor(has(/<(?:audio|video)\b/i), true),
    externalResources: statusFor(
      has(
        /(?:src|href)\s*=\s*["']?(?:https?:|\/\/|\.\.\/|\.\/)|url\s*\(\s*["']?(?:https?:|\/\/|\.\.\/|\.\/)/i,
      ),
      true,
    ),
    nondeterminism: statusFor(
      has(/\b(?:Date\.now|new\s+Date|Math\.random|crypto\.getRandomValues)\b/),
      true,
    ),
    navigation: statusFor(
      has(/<(?:a|form)\b|\b(?:location\.(?:assign|replace|href)|history\.)/i),
      true,
    ),
    popups: statusFor(has(/\b(?:window\.)?open\s*\(/i), true),
    fileOperations: statusFor(
      has(/<input\b[^>]*type\s*=\s*["']file|\b(?:FileReader|showOpenFilePicker|download)\b/i),
      true,
    ),
  };
  for (const key of CAPABILITY_KEYS) {
    const value = capabilities[key];
    if (value === 'risk' || value === 'unsupported') {
      diagnostics.push({
        code: `capability-${key}`,
        severity: value === 'risk' ? 'warning' : 'error',
        message: `${key} is ${value === 'risk' ? 'present and may be nondeterministic' : 'not supported by deterministic replay'}`,
      });
    }
  }
  return { capabilities, diagnostics };
}

/** A conservative inventory parser for unit tests and non-browser callers. */
export function parseReplayTargets(html: string): string[] {
  const selectors = new Set<string>();
  const markup = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const tag = /<([a-z][\w-]*)([^>]*)>/gi;
  for (const match of markup.matchAll(tag)) {
    const attrs = match[2] ?? '';
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (id) selectors.add(`#${cssEscape(id)}`);
    for (const name of ['data-testid', 'data-step-id', 'data-action']) {
      const value = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs)?.[1];
      if (value) selectors.add(`[${name}="${cssEscape(value)}"]`);
    }
  }
  return [...selectors].sort();
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function injectInspector(
  html: string,
  options: Required<Pick<ReplayInspectorOptions, 'operationTimeoutMs' | 'settleMs'>>,
): string {
  const timeout = Math.max(100, Math.floor(options.operationTimeoutMs));
  const settle = Math.max(0, Math.floor(options.settleMs));
  const script = `<script data-openmaic-replay-inspector>(function(){
var TIMEOUT=${timeout},SETTLE=${settle},PREFIX='__openmaicReplay';
function esc(s){return String(s).replace(/[^a-zA-Z0-9_-]/g,function(c){return '\\\\'+c})}
function selector(el){if(el.id)return '#'+esc(el.id);for(var i=0,n=['data-testid','data-step-id','data-action'];i<n.length;i++){var v=el.getAttribute(n[i]);if(v)return '['+n[i]+'="'+esc(v)+'"]'}var parts=[],node=el;while(node&&node.nodeType===1&&node.tagName.toLowerCase()!=='html'){var index=1,sibling=node.previousElementSibling;while(sibling){if(sibling.tagName===node.tagName)index++;sibling=sibling.previousElementSibling}parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+index+')');node=node.parentElement}return parts.join(' > ')}
function text(el){return String(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160)}
function vis(el){var r=el.getBoundingClientRect(),reasons=[],v='visible',n=el;while(n){var s=getComputedStyle(n);if(n.hidden||n.inert||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0){v='hidden';reasons.push('css-hidden');break}n=n.parentElement}if(v==='visible'&&(r.width<=0||r.height<=0)){v='hidden';reasons.push('zero-size')}else if(v==='visible'&&(r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight)){v='off-viewport';reasons.push('outside-viewport')}else if(v==='visible'){var x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)),top=document.elementFromPoint(x,y);if(!top){v='unknown';reasons.push('hit-test-unavailable')}else if(top!==el&&!el.contains(top)){v='occluded';reasons.push('covered-by-'+String(top.id||top.tagName||'element'))}}return {selector:selector(el),tagName:el.tagName.toLowerCase(),text:text(el),visibility:v,reasons:reasons,rect:{x:Math.round(r.x*100)/100,y:Math.round(r.y*100)/100,width:Math.round(r.width*100)/100,height:Math.round(r.height*100)/100},disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true'}}
function snapshot(){var els=[].slice.call(document.querySelectorAll('[id],[data-testid],[data-step-id],[data-action],button,input,select,textarea,[role]')),seen={},targets=[];els.forEach(function(el){var s=selector(el);if(!s||seen[s])return;seen[s]=1;targets.push(vis(el))});targets.sort(function(a,b){return a.selector.localeCompare(b.selector)});var groups={visible:[],hidden:[],offViewport:[],occluded:[]};targets.forEach(function(t){if(groups[t.visibility])groups[t.visibility].push(t.selector)});var serial=targets.map(function(t){return [t.selector,t.visibility,t.text,t.disabled,t.rect.x,t.rect.y,t.rect.width,t.rect.height].join('|')}).join('\\n');return {signature:fnv(serial),targets:targets,visible:groups.visible,hidden:groups.hidden,offViewport:groups.offViewport,occluded:groups.occluded}}
function fnv(s){var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(16).padStart(8,'0')}
function controls(){var out=[],seen={};[].slice.call(document.querySelectorAll('button,input,select,textarea,[role="button"],[role="switch"],[role="checkbox"]')).forEach(function(el){var s=selector(el);if(!s||seen[s])return;seen[s]=1;var tag=el.tagName.toLowerCase(),type=(el.getAttribute('type')||'').toLowerCase(),toggle=type==='checkbox'||type==='radio'||el.getAttribute('role')==='switch'||el.getAttribute('role')==='checkbox',button=tag==='button'||(tag==='input'&&type==='button'),kind=toggle?'toggle':(button?'button':(tag==='input'||tag==='select'||tag==='textarea'?'input':'button')),bounded=true,reason='',value;if(tag==='a'){bounded=false;reason='navigation-control'}if(tag==='input'&&(type==='file'||type==='url'||type==='email'||type==='submit'||type==='image')){bounded=false;reason='unsafe-input-type'}if(kind==='input'&&tag==='textarea'&&!(el.maxLength>0&&el.maxLength<=${SAFE_INPUT_MAX})){bounded=false;reason='unbounded-input'}if(kind==='input'&&tag==='input'&&(type===''||type==='text'||type==='search')&&!(el.maxLength>0&&el.maxLength<=${SAFE_INPUT_MAX})){bounded=false;reason='unbounded-input'}if(kind==='input'&&tag==='input'&&(type==='number'||type==='range')){var min=Number(el.min),max=Number(el.max);if(!Number.isFinite(min)||!Number.isFinite(max)||max<min){bounded=false;reason='unbounded-input'}else value=(min+max)/2}if(kind==='input'&&tag==='select'){value=el.options&&el.options.length?el.options[Math.min(1,el.options.length-1)].value:''}if(kind==='input'&&value===undefined)value='';if(tag==='button'&&el.form&&(type===''||type==='submit'||type==='reset')){bounded=false;reason='form-navigation'}out.push({selector:s,kind:kind,tagName:tag,label:text(el)||el.getAttribute('aria-label')||'',inputType:type||undefined,bounded:bounded,safe:bounded&&!el.disabled,operationValue:value,reason:reason||undefined})});return out.sort(function(a,b){return a.selector.localeCompare(b.selector)})}
function emit(kind,payload){try{var x={kind:PREFIX+'-'+kind};Object.keys(payload||{}).forEach(function(k){x[k]=payload[k]});parent.postMessage(x,'*')}catch(_){} }
function settle(){return new Promise(function(resolve){var done=false,t=setTimeout(function(){if(!done){done=true;resolve()}},Math.max(50,TIMEOUT-50));requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(function(){if(done)return;done=true;clearTimeout(t);resolve()},SETTLE)})})})}
function safeOp(op){var el=document.querySelector(op.selector);if(!el)return {ok:false,error:'target-not-found'};if(el.disabled||el.getAttribute('aria-disabled')==='true')return {ok:false,error:'target-disabled'};try{if(op.kind==='input'){var value=String(op.value==null?'':op.value);if(value.length>${SAFE_INPUT_MAX})return {ok:false,error:'input-too-long'};el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}else{el.click()}return {ok:true}}catch(e){return {ok:false,error:String(e&&e.message||e)}}}
window.addEventListener('message',function(e){var d=e.data||{};if(!d||d.kind!==PREFIX+'-operation')return;var before=snapshot(),result=safeOp(d.operation||{});settle().then(function(){emit('operation-result',{id:d.id,before:before,after:snapshot(),result:result,controls:controls()})})});
window.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a');if(a)emit('diagnostic',{code:'navigation-blocked',message:'link activation is not explored'})},true);
window.addEventListener('submit',function(e){e.preventDefault();emit('diagnostic',{code:'navigation-blocked',message:'form submission is not explored'})},true);
function ready(){emit('ready',{snapshot:snapshot(),controls:controls(),viewport:{width:innerWidth,height:innerHeight}})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();</script>`;
  // Keep an authored doctype at byte zero so the inspected page stays in
  // standards mode. The inspector still runs before the authored head/CSP.
  const doctype = /^\s*<!doctype\s+html\s*>/i.exec(html);
  if (doctype && doctype.index !== undefined) {
    return (
      html.slice(0, doctype.index) +
      doctype[0] +
      script +
      html.slice(doctype.index + doctype[0].length)
    );
  }
  return script + html;
}

/**
 * Build the sandbox document used by the runtime inspector. Exported for
 * browser-level contract tests and for callers that already own an iframe.
 */
export function buildReplayInspectorDocument(
  html: string,
  options: Pick<ReplayInspectorOptions, 'operationTimeoutMs' | 'settleMs'> = {},
): string {
  return injectInspector(html, {
    operationTimeoutMs: options.operationTimeoutMs ?? DEFAULT_LIMITS.operationTimeoutMs,
    settleMs: options.settleMs ?? 30,
  });
}

function waitForMessage(
  iframe: HTMLIFrameElement,
  predicate: (data: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('replay-inspector-timeout'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || !event.data || typeof event.data !== 'object')
        return;
      const data = event.data as Record<string, unknown>;
      if (!predicate(data)) return;
      globalThis.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(data);
    };
    window.addEventListener('message', onMessage);
  });
}

function normalizeSnapshot(value: unknown): ReplaySnapshot {
  const snapshot = value as ReplaySnapshot;
  return {
    signature: String(snapshot?.signature ?? ''),
    targets: Array.isArray(snapshot?.targets) ? snapshot.targets : [],
    visible: [...(snapshot?.visible ?? [])].sort(),
    hidden: [...(snapshot?.hidden ?? [])].sort(),
    offViewport: [...(snapshot?.offViewport ?? [])].sort(),
    occluded: [...(snapshot?.occluded ?? [])].sort(),
  };
}

export class ReplayContractParseError extends Error {
  constructor(
    public readonly code: 'invalid-contract' | 'unsupported-version' | 'stale-source',
    message: string,
  ) {
    super(message);
    this.name = 'ReplayContractParseError';
  }
}

/** Parse a persisted contract and optionally reject it when the source changed. */
export function parseReplayContract(
  value: unknown,
  expectedSourceHtmlHash?: string,
): ReplayContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplayContractParseError('invalid-contract', 'ReplayContract must be an object');
  }
  const contract = value as Partial<ReplayContract>;
  if (contract.version !== REPLAY_CONTRACT_VERSION) {
    throw new ReplayContractParseError(
      'unsupported-version',
      `Unsupported ReplayContract version: ${String(contract.version)}`,
    );
  }
  if (
    typeof contract.sourceHtmlHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(contract.sourceHtmlHash) ||
    !contract.viewport ||
    typeof contract.viewport.width !== 'number' ||
    typeof contract.viewport.height !== 'number' ||
    !contract.initial ||
    !Array.isArray(contract.targets) ||
    !Array.isArray(contract.controls) ||
    !Array.isArray(contract.transitions) ||
    !contract.capabilities ||
    !Array.isArray(contract.diagnostics) ||
    !contract.limits
  ) {
    throw new ReplayContractParseError(
      'invalid-contract',
      'ReplayContract is missing required fields',
    );
  }
  if (expectedSourceHtmlHash && contract.sourceHtmlHash !== expectedSourceHtmlHash) {
    throw new ReplayContractParseError(
      'stale-source',
      `ReplayContract source hash ${contract.sourceHtmlHash} does not match ${expectedSourceHtmlHash}`,
    );
  }
  return contract as ReplayContract;
}

/** Inspect authored HTML in a fresh sandboxed iframe and return its replay contract. */
export async function inspectReplayContract(
  html: string,
  options: ReplayInspectorOptions = {},
): Promise<ReplayContract> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new Error('inspectReplayContract requires a browser document');
  }
  const limits: ReplayLimits = {
    maxOperations: Math.max(0, Math.floor(options.maxOperations ?? DEFAULT_LIMITS.maxOperations)),
    maxDepth: Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_LIMITS.maxDepth)),
    maxStates: Math.max(1, Math.floor(options.maxStates ?? DEFAULT_LIMITS.maxStates)),
    operationTimeoutMs: Math.max(
      100,
      Math.floor(options.operationTimeoutMs ?? DEFAULT_LIMITS.operationTimeoutMs),
    ),
  };
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const staticReport = analyzeReplayHtml(html);
  const iframe = document.createElement('iframe');
  iframe.title = 'ReplayContract inspector';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${viewport.width}px;height:${viewport.height}px;border:0;pointer-events:none`;
  document.body.appendChild(iframe);
  const sourceHash = await sha256Hex(html);
  const transitions: ReplayTransition[] = [];
  const diagnostics: ReplayDiagnostic[] = [...staticReport.diagnostics];
  const loadFresh = async (): Promise<Record<string, unknown>> => {
    const ready = waitForMessage(
      iframe,
      (data) => data.kind === '__openmaicReplay-ready',
      limits.operationTimeoutMs,
    );
    iframe.srcdoc = injectInspector(html, {
      operationTimeoutMs: limits.operationTimeoutMs,
      settleMs: options.settleMs ?? 30,
    });
    return ready;
  };
  try {
    const ready = await loadFresh();
    const initial = normalizeSnapshot(ready.snapshot);
    for (const target of initial.targets) {
      if (target.visibility === 'unknown') {
        diagnostics.push({
          code: 'ambiguous-visibility',
          severity: 'warning',
          message: target.reasons.join(', ') || 'visibility could not be determined',
          selector: target.selector,
        });
      }
    }
    const controls = (Array.isArray(ready.controls) ? ready.controls : []) as ReplayControl[];
    const safeControls =
      limits.maxDepth === 0
        ? []
        : controls
            .filter((control) => control.safe && control.bounded)
            .slice(0, limits.maxOperations);
    let states = 1;
    for (const control of safeControls) {
      if (states >= limits.maxStates || transitions.length >= limits.maxOperations) break;
      try {
        const operation: ReplayOperation = {
          kind: control.kind === 'toggle' ? 'toggle' : control.kind === 'input' ? 'input' : 'click',
          selector: control.selector,
          ...(control.kind === 'input' ? { value: control.operationValue ?? '' } : {}),
        };
        const id = `${transitions.length + 1}`;
        const fresh = await loadFresh();
        const before = normalizeSnapshot(fresh.snapshot);
        const operationResult = waitForMessage(
          iframe,
          (data) => data.kind === '__openmaicReplay-operation-result' && data.id === id,
          limits.operationTimeoutMs,
        );
        iframe.contentWindow?.postMessage(
          { kind: '__openmaicReplay-operation', id, operation },
          '*',
        );
        const result = await operationResult;
        const after = normalizeSnapshot(result.after);
        const opResult = result.result as { ok?: boolean; error?: string };
        if (!opResult?.ok) {
          diagnostics.push({
            code: 'operation-failed',
            severity: 'warning',
            message: opResult?.error ?? 'operation failed',
            selector: control.selector,
          });
          continue;
        }
        states++;
        transitions.push({
          depth: 1,
          operation,
          preconditions: {
            target: control.selector,
            visibility:
              before.targets.find((target) => target.selector === control.selector)?.visibility ??
              'unknown',
            enabled: !control.reason,
          },
          postconditions: {
            changed: before.signature !== after.signature,
            visible: after.visible,
            hidden: after.hidden,
            offViewport: after.offViewport,
            occluded: after.occluded,
          },
          wait: { settled: true, timeoutMs: limits.operationTimeoutMs },
          before,
          after,
        });
      } catch (error) {
        diagnostics.push({
          code: 'operation-timeout',
          severity: 'warning',
          message: error instanceof Error ? error.message : String(error),
          selector: control.selector,
        });
      }
    }
    const childDiagnostics = (
      Array.isArray(ready.diagnostics) ? ready.diagnostics : []
    ) as ReplayDiagnostic[];
    diagnostics.push(...childDiagnostics);
    return {
      version: REPLAY_CONTRACT_VERSION,
      sourceHtmlHash: sourceHash,
      viewport,
      initial,
      targets: initial.targets,
      controls,
      transitions,
      capabilities: staticReport.capabilities,
      diagnostics: diagnostics.sort((a, b) =>
        `${a.code}:${a.selector ?? ''}`.localeCompare(`${b.code}:${b.selector ?? ''}`),
      ),
      limits,
      exploredStates: states,
      exploredOperations: transitions.length,
    };
  } catch (error) {
    diagnostics.push({
      code: 'runtime-inspection-failed',
      severity: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      version: REPLAY_CONTRACT_VERSION,
      sourceHtmlHash: sourceHash,
      viewport,
      initial: {
        signature: '',
        targets: [],
        visible: [],
        hidden: [],
        offViewport: [],
        occluded: [],
      },
      targets: [],
      controls: [],
      transitions: [],
      capabilities: staticReport.capabilities,
      diagnostics,
      limits,
      exploredStates: 0,
      exploredOperations: 0,
    };
  } finally {
    iframe.remove();
  }
}
