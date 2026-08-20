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
  checked?: boolean | 'mixed';
  value?: string;
  selectedIndex?: number;
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
  exploredTransitions: number;
}

export interface ReplayInspectorOptions {
  viewport?: { width: number; height: number };
  maxOperations?: number;
  maxDepth?: number;
  maxStates?: number;
  operationTimeoutMs?: number;
  settleMs?: number;
}

interface ReplayInjectionOptions {
  operationTimeoutMs: number;
  settleMs: number;
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

function htmlStartTags(html: string): string[] {
  const tags: string[] = [];
  for (let start = 0; start < html.length; start++) {
    if (html[start] !== '<' || !/[a-z]/i.test(html[start + 1] ?? '')) continue;
    let quote = '';
    for (let end = start + 1; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        tags.push(html.slice(start, end + 1));
        start = end;
        break;
      }
    }
  }
  return tags;
}

function hasUncontainableReplaySideEffect(html: string): boolean {
  const executableFragments: string[] = [];
  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const script of parsed.querySelectorAll('script')) {
      if (script.hasAttribute('src')) return true;
      executableFragments.push(script.textContent ?? '');
    }
    for (const element of parsed.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (/^on/i.test(attribute.name)) executableFragments.push(attribute.value);
      }
    }
  } else {
    if (/<script\b[^>]*\bsrc\s*=/i.test(html)) return true;
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      executableFragments.push(match[1] ?? '');
    }
    for (const tag of htmlStartTags(html)) {
      for (const handler of tag.matchAll(
        /\bon[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
      )) {
        executableFragments.push(handler[1] ?? handler[2] ?? handler[3] ?? '');
      }
    }
  }
  return /(?:\[\s*["']location["']\s*\]|\blocation)\s*(?:\.|\[|=)|(?:\[\s*["']history["']\s*\]|\bhistory)\s*(?:\.\s*(?:go|back|forward)|\[\s*["'](?:go|back|forward)["']\s*\])\s*\(|(?:\[\s*["']navigation["']\s*\]|\bnavigation)\s*(?:\.\s*(?:navigate|reload|back|forward|traverseTo)|\[\s*["'](?:navigate|reload|back|forward|traverseTo)["']\s*\])\s*\(|(?:\[\s*["'](?:FileReader|showOpenFilePicker|showSaveFilePicker|showDirectoryPicker)["']\s*\]|\b(?:FileReader|showOpenFilePicker|showSaveFilePicker|showDirectoryPicker)\b)/i.test(
    executableFragments.join('\n'),
  );
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
    navigation: statusFor(has(/<(?:a|form)\b/i) || hasUncontainableReplaySideEffect(html), true),
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
    if (id) selectors.add(stableAttributeSelector('id', id, escapeCssString));
    for (const name of ['data-testid', 'data-step-id', 'data-action']) {
      const value = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs)?.[1];
      if (value) selectors.add(stableAttributeSelector(name, value, escapeCssString));
    }
  }
  return [...selectors].sort();
}

function escapeCssString(value: string): string {
  return String(value)
    .replace(/\0/g, '\uFFFD')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ');
}

function stableAttributeSelector(
  name: string,
  value: string,
  escapeValue: (input: string) => string,
): string {
  const normalized = String(value);
  if (name === 'id' && /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/.test(normalized)) {
    return `#${normalized}`;
  }
  return `[${name}="${escapeValue(normalized)}"]`;
}

function injectInspector(html: string, options: ReplayInjectionOptions): string {
  const timeout = Math.max(100, Math.floor(options.operationTimeoutMs));
  const settle = Math.max(0, Math.floor(options.settleMs));
  const escapeCssStringSource = escapeCssString.toString();
  const stableAttributeSelectorSource = stableAttributeSelector.toString();
  const script = `<script data-openmaic-replay-inspector>(function(){
var TIMEOUT=${timeout},SETTLE=${settle},PREFIX='__openmaicReplay',CHANNEL=new MessageChannel();
var escapeCssString=${escapeCssStringSource},stableAttributeSelector=${stableAttributeSelectorSource};
function selector(element){if(element.id)return stableAttributeSelector('id',element.id,escapeCssString);var attributeNames=['data-testid','data-step-id','data-action'];for(var attributeIndex=0;attributeIndex<attributeNames.length;attributeIndex++){var attributeValue=element.getAttribute(attributeNames[attributeIndex]);if(attributeValue)return stableAttributeSelector(attributeNames[attributeIndex],attributeValue,escapeCssString)}var parts=[],node=element;while(node&&node.nodeType===1&&node.tagName.toLowerCase()!=='html'){var index=1,sibling=node.previousElementSibling;while(sibling){if(sibling.tagName===node.tagName)index++;sibling=sibling.previousElementSibling}parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+index+')');node=node.parentElement}return parts.join(' > ')}
function normalizedText(element){return String(element.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160)}
function inspectTarget(element){var rect=element.getBoundingClientRect(),reasons=[],visibility='visible',ancestor=element;while(ancestor){var style=getComputedStyle(ancestor);if(ancestor.hidden||ancestor.inert||ancestor.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0){visibility='hidden';reasons.push('css-hidden');break}ancestor=ancestor.parentElement}if(visibility==='visible'&&(rect.width<=0||rect.height<=0)){visibility='hidden';reasons.push('zero-size')}else if(visibility==='visible'&&(rect.right<=0||rect.bottom<=0||rect.left>=innerWidth||rect.top>=innerHeight)){visibility='off-viewport';reasons.push('outside-viewport')}else if(visibility==='visible'){var pointX=Math.max(0,Math.min(innerWidth-1,rect.left+rect.width/2)),pointY=Math.max(0,Math.min(innerHeight-1,rect.top+rect.height/2)),topElement=document.elementFromPoint(pointX,pointY);if(!topElement){visibility='unknown';reasons.push('hit-test-unavailable')}else if(topElement!==element&&!element.contains(topElement)){visibility='occluded';reasons.push('covered-by-'+String(topElement.id||topElement.tagName||'element'))}}var tagName=element.tagName.toLowerCase(),state={},ariaChecked=element.getAttribute('aria-checked');if(tagName==='input'&&(element.type==='checkbox'||element.type==='radio'))state.checked=element.indeterminate?'mixed':!!element.checked;else if((element.getAttribute('role')==='switch'||element.getAttribute('role')==='checkbox')&&ariaChecked!==null)state.checked=ariaChecked==='mixed'?'mixed':ariaChecked==='true';if(tagName==='select'){state.value=String(element.value||'').slice(0,${SAFE_INPUT_MAX});state.selectedIndex=element.selectedIndex}else if(tagName==='textarea'&&element.maxLength>0&&element.maxLength<=${SAFE_INPUT_MAX})state.value=String(element.value||'').slice(0,${SAFE_INPUT_MAX});else if(tagName==='input'&&(element.type===''||element.type==='text'||element.type==='search'||element.type==='number'||element.type==='range')&&((element.type==='number'||element.type==='range')||(element.maxLength>0&&element.maxLength<=${SAFE_INPUT_MAX})))state.value=String(element.value||'').slice(0,${SAFE_INPUT_MAX});return Object.assign({selector:selector(element),tagName:tagName,text:normalizedText(element),visibility:visibility,reasons:reasons,rect:{x:Math.round(rect.x*100)/100,y:Math.round(rect.y*100)/100,width:Math.round(rect.width*100)/100,height:Math.round(rect.height*100)/100},disabled:!!element.disabled||element.getAttribute('aria-disabled')==='true'},state)}
function snapshot(){var elements=[].slice.call(document.querySelectorAll('[id],[data-testid],[data-step-id],[data-action],button,input,select,textarea,[role]')),seen={},targets=[];elements.forEach(function(element){var targetSelector=selector(element);if(!targetSelector||seen[targetSelector])return;seen[targetSelector]=1;targets.push(inspectTarget(element))});targets.sort(function(first,second){return first.selector.localeCompare(second.selector)});var groups={visible:[],hidden:[],offViewport:[],occluded:[]};targets.forEach(function(target){if(groups[target.visibility])groups[target.visibility].push(target.selector)});var serialized=targets.map(function(target){return [target.selector,target.visibility,target.text,target.disabled,target.checked,target.value,target.selectedIndex,target.rect.x,target.rect.y,target.rect.width,target.rect.height].join('|')}).join('\\n');return {signature:hashSnapshot(serialized),targets:targets,visible:groups.visible,hidden:groups.hidden,offViewport:groups.offViewport,occluded:groups.occluded}}
function hashSnapshot(serialized){var hash=2166136261;for(var index=0;index<serialized.length;index++){hash^=serialized.charCodeAt(index);hash=Math.imul(hash,16777619)}return (hash>>>0).toString(16).padStart(8,'0')}
function collectControls(){var controls=[],seen={};[].slice.call(document.querySelectorAll('button,input,select,textarea,[role="button"],[role="switch"],[role="checkbox"]')).forEach(function(element){var targetSelector=selector(element);if(!targetSelector||seen[targetSelector])return;seen[targetSelector]=1;var tagName=element.tagName.toLowerCase(),inputType=(element.getAttribute('type')||'').toLowerCase(),toggle=inputType==='checkbox'||inputType==='radio'||element.getAttribute('role')==='switch'||element.getAttribute('role')==='checkbox',button=tagName==='button'||(tagName==='input'&&inputType==='button'),kind=toggle?'toggle':(button?'button':(tagName==='input'||tagName==='select'||tagName==='textarea'?'input':'button')),bounded=true,reason='',operationValue,visibility=inspectTarget(element).visibility,disabled=!!element.disabled||element.getAttribute('aria-disabled')==='true';if(tagName==='a'){bounded=false;reason='navigation-control'}if(tagName==='input'&&!(inputType===''||inputType==='text'||inputType==='search'||inputType==='number'||inputType==='range'||inputType==='checkbox'||inputType==='radio'||inputType==='button')){bounded=false;reason='unsafe-input-type'}if(kind==='input'&&tagName==='textarea'&&!(element.maxLength>0&&element.maxLength<=${SAFE_INPUT_MAX})){bounded=false;reason='unbounded-input'}if(kind==='input'&&tagName==='input'&&(inputType===''||inputType==='text'||inputType==='search')&&!(element.maxLength>0&&element.maxLength<=${SAFE_INPUT_MAX})){bounded=false;reason='unbounded-input'}if(kind==='input'&&tagName==='input'&&(inputType==='number'||inputType==='range')){var minimum=Number(element.min),maximum=Number(element.max);if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||maximum<minimum){bounded=false;reason='unbounded-input'}else operationValue=(minimum+maximum)/2}if(kind==='input'&&tagName==='select'){operationValue=element.options&&element.options.length?element.options[Math.min(1,element.options.length-1)].value:'';if(String(operationValue).length>${SAFE_INPUT_MAX}){bounded=false;reason='unbounded-input'}}if(kind==='input'&&operationValue===undefined)operationValue='';if(tagName==='button'&&element.form&&(inputType===''||inputType==='submit'||inputType==='reset')){bounded=false;reason='form-navigation'}if(!reason&&disabled)reason='target-disabled';if(!reason&&visibility!=='visible')reason='target-'+visibility;controls.push({selector:targetSelector,kind:kind,tagName:tagName,label:normalizedText(element)||element.getAttribute('aria-label')||'',inputType:inputType||undefined,bounded:bounded,safe:bounded&&!disabled&&visibility==='visible',operationValue:operationValue,reason:reason||undefined})});return controls.sort(function(first,second){return first.selector.localeCompare(second.selector)})}
function emit(kind,payload){try{var message={kind:PREFIX+'-'+kind};Object.keys(payload||{}).forEach(function(key){message[key]=payload[key]});CHANNEL.port1.postMessage(message)}catch(ignoredError){} }
function settle(){return new Promise(function(resolve){var done=false,timeoutHandle=setTimeout(function(){if(!done){done=true;resolve(false)}},Math.max(50,TIMEOUT-50));requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(function(){if(done)return;done=true;clearTimeout(timeoutHandle);resolve(true)},SETTLE)})})})}
function applySafeOperation(operation){var control=collectControls().find(function(candidate){return candidate.selector===operation.selector});if(!control)return {ok:false,error:'target-not-found'};if(!control.safe)return {ok:false,error:control.reason||'target-unsafe'};if(operation.kind==='input'&&control.kind!=='input')return {ok:false,error:'operation-kind-mismatch'};try{var element=document.querySelector(operation.selector);if(operation.kind==='input'){var value=String(operation.value==null?'':operation.value);if(value.length>${SAFE_INPUT_MAX})return {ok:false,error:'input-too-long'};element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}))}else{element.click()}return {ok:true}}catch(error){return {ok:false,error:String(error&&error.message||error)}}}
CHANNEL.port1.addEventListener('message',function(event){var data=event.data||{};if(!data||data.kind!==PREFIX+'-operation')return;var before=snapshot(),result=applySafeOperation(data.operation||{});settle().then(function(settled){emit('operation-result',{id:data.id,before:before,after:snapshot(),result:result,settled:settled,controls:collectControls()})})});CHANNEL.port1.start();parent.postMessage({kind:PREFIX+'-hello'},'*',[CHANNEL.port2]);
window.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a');if(a){e.preventDefault();e.stopPropagation();emit('diagnostic',{code:'navigation-blocked',message:'link activation is not explored'})}},true);
window.addEventListener('submit',function(e){e.preventDefault();emit('diagnostic',{code:'navigation-blocked',message:'form submission is not explored'})},true);
try{window.open=function(){emit('diagnostic',{code:'popup-blocked',message:'popup activation is not explored'});return null};window.alert=function(){emit('diagnostic',{code:'popup-blocked',message:'modal activation is not explored'})};window.confirm=function(){emit('diagnostic',{code:'popup-blocked',message:'modal activation is not explored'});return false};if(window.navigator&&window.navigator.share)window.navigator.share=function(){emit('diagnostic',{code:'popup-blocked',message:'share activation is not explored'});return Promise.reject(new Error('replay-popup-blocked'))};if(window.HTMLAnchorElement){HTMLAnchorElement.prototype.click=function(){emit('diagnostic',{code:'navigation-blocked',message:'programmatic link activation is not explored'})}}if(window.HTMLFormElement){HTMLFormElement.prototype.submit=function(){emit('diagnostic',{code:'navigation-blocked',message:'programmatic form submission is not explored'})}}if(window.history){history.pushState=function(){emit('diagnostic',{code:'navigation-blocked',message:'history mutation is not explored'})};history.replaceState=function(){emit('diagnostic',{code:'navigation-blocked',message:'history mutation is not explored'})}}if(window.Location){['assign','replace'].forEach(function(name){try{Location.prototype[name]=function(){emit('diagnostic',{code:'navigation-blocked',message:'location mutation is not explored'})}}catch(_) {}})}}catch(_){}
function ready(){emit('ready',{snapshot:snapshot(),controls:collectControls(),viewport:{width:innerWidth,height:innerHeight}})}
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

function waitForPort(iframe: HTMLIFrameElement, timeoutMs: number): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('replay-inspector-timeout'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (
        event.source !== iframe.contentWindow ||
        event.data?.kind !== '__openmaicReplay-hello' ||
        !event.ports?.[0]
      )
        return;
      globalThis.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      event.ports[0].start();
      resolve(event.ports[0]);
    };
    window.addEventListener('message', onMessage);
  });
}

function waitForPortMessage(
  port: MessagePort,
  predicate: (data: Record<string, unknown>) => boolean,
  timeoutMs: number,
  diagnostics: ReplayDiagnostic[],
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      port.removeEventListener('message', onMessage);
      reject(new Error('replay-inspector-timeout'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      const data = event.data as Record<string, unknown>;
      if (data.kind === '__openmaicReplay-diagnostic') {
        diagnostics.push({
          code: String(data.code ?? 'runtime-diagnostic'),
          severity: 'warning',
          message: String(data.message ?? 'interactive runtime diagnostic'),
          ...(typeof data.selector === 'string' ? { selector: data.selector } : {}),
        });
        return;
      }
      if (!predicate(data)) return;
      globalThis.clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      resolve(data);
    };
    port.addEventListener('message', onMessage);
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

function replayOperationsFromControls(value: unknown, limit: number): ReplayOperation[] {
  if (!Array.isArray(value)) return [];
  return (value as ReplayControl[])
    .filter(
      (control) =>
        control.safe &&
        control.bounded &&
        typeof control.selector === 'string' &&
        control.selector.length > 0,
    )
    .map(
      (control): ReplayOperation => ({
        kind: control.kind === 'toggle' ? 'toggle' : control.kind === 'input' ? 'input' : 'click',
        selector: control.selector,
        ...(control.kind === 'input' ? { value: control.operationValue ?? '' } : {}),
      }),
    )
    .sort((a, b) => `${a.selector}:${a.kind}`.localeCompare(`${b.selector}:${b.kind}`))
    .slice(0, limit);
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
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${viewport.width}px;height:${viewport.height}px;border:0;pointer-events:none`;
  document.body.appendChild(iframe);
  const sourceHash = await sha256Hex(html);
  const transitions: ReplayTransition[] = [];
  const diagnostics: ReplayDiagnostic[] = [...staticReport.diagnostics];
  const loadFresh = async (): Promise<{ ready: Record<string, unknown>; port: MessagePort }> => {
    const portPromise = waitForPort(iframe, limits.operationTimeoutMs);
    iframe.srcdoc = injectInspector(html, {
      operationTimeoutMs: limits.operationTimeoutMs,
      settleMs: options.settleMs ?? 30,
    });
    const port = await portPromise;
    const ready = await waitForPortMessage(
      port,
      (data) => data.kind === '__openmaicReplay-ready',
      limits.operationTimeoutMs,
      diagnostics,
    );
    return { ready, port };
  };
  try {
    const freshInitial = await loadFresh();
    const ready = freshInitial.ready;
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
      if (target.checked === 'mixed') {
        diagnostics.push({
          code: 'ambiguous-control-state',
          severity: 'warning',
          message: 'Control has an indeterminate or mixed checked state',
          selector: target.selector,
        });
      }
    }
    const controls = (Array.isArray(ready.controls) ? ready.controls : []) as ReplayControl[];
    const unsafeSourceExploration = hasUncontainableReplaySideEffect(html);
    if (unsafeSourceExploration) {
      diagnostics.push({
        code: 'exploration-skipped-uncontainable-side-effect',
        severity: 'warning',
        message:
          'Candidate exploration skipped because programmatic navigation or file access cannot be safely contained',
      });
    }
    const operations =
      limits.maxDepth === 0 || unsafeSourceExploration
        ? []
        : replayOperationsFromControls(controls, limits.maxOperations);
    const queue: ReplayOperation[][] = operations.map((operation) => [operation]);
    const seenSignatures = new Set([initial.signature]);
    let requestId = 0;
    let attemptedOperations = 0;
    let states = 1;
    while (
      queue.length > 0 &&
      states < limits.maxStates &&
      transitions.length < limits.maxOperations
    ) {
      const path = queue.shift()!;
      try {
        const fresh = await loadFresh();
        const port = fresh.port;
        const snapshots = [normalizeSnapshot(fresh.ready.snapshot)];
        let availableControls: unknown = fresh.ready.controls;
        let settled = true;
        let failed = false;
        for (const operation of path) {
          if (attemptedOperations >= limits.maxOperations) {
            diagnostics.push({
              code: 'operation-limit-reached',
              severity: 'warning',
              message: 'Replay exploration stopped at the configured operation limit',
              selector: operation.selector,
            });
            failed = true;
            break;
          }
          attemptedOperations++;
          const id = `${++requestId}`;
          const operationResult = waitForPortMessage(
            port,
            (data) => data.kind === '__openmaicReplay-operation-result' && data.id === id,
            limits.operationTimeoutMs,
            diagnostics,
          );
          port.postMessage({ kind: '__openmaicReplay-operation', id, operation });
          const result = await operationResult;
          const opResult = result.result as { ok?: boolean; error?: string };
          if (!opResult?.ok) {
            diagnostics.push({
              code: 'operation-failed',
              severity: 'warning',
              message: opResult?.error ?? 'operation failed',
              selector: operation.selector,
            });
            failed = true;
            break;
          }
          snapshots.push(normalizeSnapshot(result.after));
          availableControls = result.controls;
          settled = settled && result.settled === true;
        }
        if (failed) continue;
        const before = snapshots[snapshots.length - 2];
        const after = snapshots[snapshots.length - 1];
        if (!settled) {
          diagnostics.push({
            code: 'operation-not-settled',
            severity: 'warning',
            message: 'Operation timed out before the iframe reached a stable state',
            selector: path[path.length - 1].selector,
          });
        }
        const isNewState = !seenSignatures.has(after.signature);
        const operatedTarget = before.targets.find(
          (target) => target.selector === path[path.length - 1].selector,
        );
        if (isNewState) {
          seenSignatures.add(after.signature);
          states++;
        }
        transitions.push({
          depth: path.length,
          operation: path[path.length - 1],
          preconditions: {
            target: path[path.length - 1].selector,
            visibility: operatedTarget?.visibility ?? 'unknown',
            enabled: operatedTarget ? !operatedTarget.disabled : false,
          },
          postconditions: {
            changed: before.signature !== after.signature,
            visible: after.visible,
            hidden: after.hidden,
            offViewport: after.offViewport,
            occluded: after.occluded,
          },
          wait: { settled, timeoutMs: limits.operationTimeoutMs },
          before,
          after,
        });
        if (isNewState && path.length < limits.maxDepth) {
          const nextOperations = replayOperationsFromControls(
            availableControls,
            limits.maxOperations,
          );
          for (const operation of nextOperations) {
            if (queue.length + transitions.length >= limits.maxOperations) break;
            queue.push([...path, operation]);
          }
        }
      } catch (error) {
        diagnostics.push({
          code: 'operation-timeout',
          severity: 'warning',
          message: error instanceof Error ? error.message : String(error),
          selector: path[path.length - 1].selector,
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
      exploredOperations: attemptedOperations,
      exploredTransitions: transitions.length,
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
      exploredTransitions: 0,
    };
  } finally {
    iframe.remove();
  }
}
