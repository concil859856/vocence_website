/**
 * ApiExplorer — custom-rendered REST reference for the Vocence developer-API.
 *
 * Fetches /devapi/openapi.json, validates the title prefix, strips any
 * path that isn't under /v1/, then renders one card per operation with
 * tabbed code examples (curl / python / typescript / go / rust), a
 * per-card Authorization input, collapsible parameters, an Execute
 * button that actually fires the request, and a response panel.
 *
 * A right-side "On this page" rail lists every operation with a
 * method-colored badge and scroll-spies the visible card.
 *
 * We hand-render instead of mounting Swagger UI because (1) we want a
 * tight visual fit with the rest of the docs page and (2) every
 * operation is then self-documenting in a single card — better for
 * humans AND for LLM agents scraping the page.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Code2, Copy, Play, Terminal } from 'lucide-react';

interface Props {
  /** Where to fetch the OpenAPI spec from. Same-origin /devapi/* is
   *  Vite-proxied in dev and Vercel/nginx-rewritten in prod. */
  specUrl?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
}

const EXPECTED_TITLE_PREFIX = 'Vocence Developer API';
const ALLOWED_PATH_PREFIXES = ['/v1/'];
/** Base URL prepended to relative request paths when firing Execute. */
const REQUEST_BASE = '/devapi';
/** Public URL shown in code-example snippets. */
const PUBLIC_BASE = 'https://api.vocence.ai';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete' | 'ws';
const METHOD_ORDER: Method[] = ['get', 'post', 'patch', 'put', 'delete'];

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema?: any;
}

interface ResponseEntry {
  status: string;
  description: string;
}

interface Operation {
  id: string;            // slug used as DOM id and TOC anchor
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description: string;
  parameters: Parameter[];
  requestBody?: {
    contentType: string;
    schema: any;
    required: boolean;
  };
  responses: ResponseEntry[];
  /** True when at least one parameter or the requestBody requires the
   *  Authorization header — used for the "this endpoint requires
   *  authentication" footer note. */
  requiresAuth: boolean;
}

interface ParsedSpec {
  ok: true;
  operations: Operation[];
  tags: string[];
}

type FetchResult = ParsedSpec | { ok: false; error: string };

/** Map an HTTP method to the brand colors used in the header pill + TOC dot. */
const METHOD_COLORS: Record<Method, { text: string; bg: string; border: string; dot: string }> = {
  get:    { text: '#34D399', bg: 'rgba(52,211,153,0.10)',  border: 'rgba(52,211,153,0.35)',  dot: '#34D399' },
  post:   { text: '#60A5FA', bg: 'rgba(96,165,250,0.10)',  border: 'rgba(96,165,250,0.35)',  dot: '#60A5FA' },
  patch:  { text: '#FBBF24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)',  dot: '#FBBF24' },
  put:    { text: '#A78BFA', bg: 'rgba(167,139,250,0.10)', border: 'rgba(167,139,250,0.35)', dot: '#A78BFA' },
  delete: { text: '#F87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)', dot: '#F87171' },
  ws:     { text: '#DFFF00', bg: 'rgba(223,255,0,0.10)',   border: 'rgba(223,255,0,0.35)',   dot: '#DFFF00' },
};

/* -------------------------------------------------------------------------- */
/*  Spec fetch + parse                                                        */
/* -------------------------------------------------------------------------- */

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Resolve a single $ref of the form "#/components/schemas/Foo" against the
 *  spec root. Returns the referenced object or the original input if it can't
 *  be resolved. Recursively resolves nested $refs one hop at a time so the
 *  caller doesn't have to keep dereferencing manually. */
function resolveRef(node: any, root: any, seen = new Set<string>()): any {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const ref: string = node.$ref;
    if (seen.has(ref)) return {}; // cycle
    seen.add(ref);
    const parts = ref.replace(/^#\//, '').split('/');
    let cur: any = root;
    for (const p of parts) {
      if (cur == null) return node;
      cur = cur[p];
    }
    return resolveRef(cur, root, seen);
  }
  return node;
}

function parseSpec(spec: any): Operation[] {
  const paths = spec?.paths || {};
  const ops: Operation[] = [];
  for (const [pathKey, pathItem] of Object.entries<any>(paths)) {
    if (!ALLOWED_PATH_PREFIXES.some((p) => pathKey.startsWith(p))) continue;
    for (const method of METHOD_ORDER) {
      const op = pathItem?.[method];
      if (!op) continue;
      const tag = (op.tags && op.tags[0]) || 'Other';
      const summary = op.summary || `${method.toUpperCase()} ${pathKey}`;
      const description = op.description || '';
      const id = slugify(`${method}-${pathKey}`);
      const parameters: Parameter[] = (op.parameters || []).map((raw: any) => {
        const p = resolveRef(raw, spec);
        return {
          name: p.name,
          in: p.in,
          required: !!p.required,
          description: p.description || (p.schema && p.schema.description) || '',
          schema: p.schema,
        };
      });
      let requestBody: Operation['requestBody'];
      if (op.requestBody) {
        const rb = resolveRef(op.requestBody, spec);
        const content = rb.content || {};
        const contentType =
          Object.keys(content)[0] || 'application/json';
        const schemaRaw = content[contentType]?.schema;
        const schema = resolveRef(schemaRaw, spec);
        requestBody = {
          contentType,
          schema,
          required: !!rb.required,
        };
      }
      const responses: ResponseEntry[] = [];
      for (const [status, def] of Object.entries<any>(op.responses || {})) {
        const r = resolveRef(def, spec);
        responses.push({ status, description: r?.description || '' });
      }
      // Every operation in our API requires the Authorization header.
      // We detect it by presence rather than hard-coding so the note
      // stays correct if a future endpoint becomes public.
      const requiresAuth = parameters.some(
        (p) => p.in === 'header' && p.name.toLowerCase() === 'authorization'
      );
      ops.push({
        id,
        method,
        path: pathKey,
        tag,
        summary,
        description,
        parameters,
        requestBody,
        responses,
        requiresAuth,
      });
    }
  }
  return ops;
}

async function fetchSpec(specUrl: string): Promise<FetchResult> {
  let resp: Response;
  try {
    resp = await fetch(specUrl, { headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, error: `Could not reach the API spec at ${specUrl}.` };
  }
  if (!resp.ok) {
    return { ok: false, error: `Spec endpoint returned HTTP ${resp.status}.` };
  }
  let raw: any;
  try {
    raw = await resp.json();
  } catch {
    return { ok: false, error: 'API spec is not valid JSON.' };
  }
  const title: string = raw?.info?.title || '';
  if (!title.startsWith(EXPECTED_TITLE_PREFIX)) {
    return {
      ok: false,
      error: `Refusing to render explorer: spec title "${title || '(empty)'}" is not Vocence Developer API.`,
    };
  }
  const operations = parseSpec(raw);
  // Inject the WebSocket session as a first-class operation so it
  // appears in cards and the right-rail TOC. WS isn't representable
  // in OpenAPI, so we hand-author the shape the rest of the explorer
  // expects. Key-management routes are intentionally NOT here —
  // they're session-authed website-backend endpoints, not part of the
  // public API surface; keys are managed via Account → Developer UI.
  operations.push(WS_AGENT_SESSION);
  const tagSet = new Set<string>();
  for (const op of operations) tagSet.add(op.tag);
  return { ok: true, operations, tags: Array.from(tagSet) };
}

/** Hand-authored entry for the voice-agent WebSocket session. */
const WS_AGENT_SESSION: Operation = {
  id: 'ws-agent-session',
  method: 'ws',
  path: '/v1/agents/{agent_id}/session',
  tag: 'Agents',
  summary: 'Open a real-time voice / text session with an agent',
  description:
    'Bidirectional WebSocket. Send text turns, base64 audio turns, or `{"type":"cancel"}` to barge in. The server streams back `transcript`, `token`, `audio_meta` (followed by binary PCM16LE 24 kHz frames), `tool_call_*`, `turn_end`, and `error` JSON events. First audio typically arrives in ~600 ms – 1 s. Close codes: 4401 (auth), 4404 (agent not found), 4502 (upstream unavailable), 4503 (misconfigured).',
  parameters: [
    {
      name: 'Authorization',
      in: 'header',
      required: true,
      description: '`Bearer voc_live_...` — must own the agent.',
      schema: { type: 'string' },
    },
    {
      name: 'agent_id',
      in: 'path',
      required: true,
      description: 'Agent id to connect to.',
      schema: { type: 'string' },
    },
  ],
  responses: [
    { status: '101', description: 'WebSocket upgrade' },
    { status: '4401', description: 'Authentication failed' },
    { status: '4404', description: 'Agent not found' },
    { status: '4502', description: 'Upstream voice pipeline unavailable' },
    { status: '4503', description: 'Service misconfigured' },
  ],
  requiresAuth: true,
};

/* -------------------------------------------------------------------------- */
/*  Example value generator (drives Try-It-Out body + snippets)               */
/* -------------------------------------------------------------------------- */

function exampleFromSchema(schema: any, depth = 0): any {
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length) return schema.enum[0];
  // OpenAPI 3.1 nullable encoding: anyOf:[{type:"string"},{type:"null"}]
  if (Array.isArray(schema.anyOf)) {
    const non = schema.anyOf.find((s: any) => s && s.type !== 'null');
    return exampleFromSchema(non, depth + 1);
  }
  if (Array.isArray(schema.oneOf)) {
    return exampleFromSchema(schema.oneOf[0], depth + 1);
  }
  const t = schema.type;
  if (t === 'string') return '';
  if (t === 'integer' || t === 'number') return 0;
  if (t === 'boolean') return false;
  if (t === 'array') return [exampleFromSchema(schema.items, depth + 1)].filter((v) => v !== null);
  if (t === 'object' || schema.properties) {
    const props = schema.properties || {};
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(props)) {
      out[k] = exampleFromSchema(v, depth + 1);
    }
    return out;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Code-snippet generators                                                   */
/* -------------------------------------------------------------------------- */

type Lang = 'curl' | 'python' | 'typescript' | 'go' | 'rust';
const LANGS: { id: Lang; label: string }[] = [
  { id: 'curl', label: 'Curl' },
  { id: 'python', label: 'Python' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
];

interface SnippetCtx {
  method: string;
  url: string;            // full https URL with path params substituted
  body?: string;          // pretty-printed JSON body, undefined for no body
  hasBody: boolean;
}

function buildSnippetCtx(op: Operation, paramVals: Record<string, string>, bodyJson: string): SnippetCtx {
  let path = op.path;
  for (const p of op.parameters.filter((x) => x.in === 'path')) {
    const supplied = paramVals[p.name] || '';
    // Encode supplied values so the snippet is copy-pasteable as-is,
    // but leave the literal `{name}` placeholder unencoded when empty
    // so devs see what to replace instead of a confusing `%7Bname%7D`.
    const replacement = supplied ? encodeURIComponent(supplied) : `{${p.name}}`;
    path = path.replace(`{${p.name}}`, replacement);
  }
  const qsPairs = op.parameters
    .filter((x) => x.in === 'query')
    .map((x) => [x.name, paramVals[x.name] || ''])
    .filter(([_, v]) => v !== '');
  const qs = qsPairs.length ? '?' + qsPairs.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&') : '';
  // WS uses wss:// scheme — distinct enough that we materialize a
  // fully-formed URL here so each snippet template stays language-flat.
  const scheme = op.method === 'ws' ? PUBLIC_BASE.replace(/^https/, 'wss') : PUBLIC_BASE;
  return {
    method: op.method.toUpperCase(),
    url: `${scheme}${path}${qs}`,
    body: bodyJson || undefined,
    hasBody: !!op.requestBody && (op.method === 'post' || op.method === 'patch' || op.method === 'put'),
  };
}

function snippetCurl(ctx: SnippetCtx): string {
  // No curl one-liner is useful for opening a real-time WebSocket —
  // point devs at the Python snippet which is the right shape.
  if (ctx.method === 'WS') {
    return [
      '# curl cannot maintain a WebSocket session. Use one of the',
      '# language tabs (Python / TS / Go / Rust) for a runnable client.',
      '#',
      `# Endpoint: ${ctx.url}`,
      '# Auth:     Authorization: Bearer YOUR_API_KEY (sent on upgrade)',
    ].join('\n');
  }
  const lines = [`curl -X ${ctx.method} '${ctx.url}' \\`];
  lines.push(`  -H 'Authorization: Bearer YOUR_API_KEY' \\`);
  if (ctx.hasBody) {
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '${ctx.body || '{}'}'`);
  } else {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, '');
  }
  return lines.join('\n');
}

function snippetPython(ctx: SnippetCtx): string {
  if (ctx.method === 'WS') {
    return [
      'import asyncio, json, aiohttp',
      '',
      'API_KEY = "voc_live_..."',
      `URL = "${ctx.url}"`,
      '',
      'async def main():',
      '    headers = {"Authorization": f"Bearer {API_KEY}"}',
      '    async with aiohttp.ClientSession() as s:',
      '        async with s.ws_connect(URL, headers=headers) as ws:',
      '            await ws.send_str(json.dumps({"type": "text", "text": "hello"}))',
      '            async for msg in ws:',
      '                if msg.type == aiohttp.WSMsgType.TEXT:',
      '                    print("event:", msg.data[:120])',
      '                elif msg.type == aiohttp.WSMsgType.BINARY:',
      '                    print(f"audio: {len(msg.data)} bytes")',
      '',
      'asyncio.run(main())',
    ].join('\n');
  }
  const body = ctx.hasBody ? `\n\npayload = ${ctx.body || '{}'}\n` : '';
  const call = ctx.hasBody
    ? `requests.request("${ctx.method}", url, headers=headers, json=payload)`
    : `requests.request("${ctx.method}", url, headers=headers)`;
  return [
    'import requests',
    '',
    `url = "${ctx.url}"`,
    `headers = {`,
    `    "Authorization": "Bearer YOUR_API_KEY",`,
    ctx.hasBody ? `    "Content-Type": "application/json",` : '',
    `}` + body,
    `resp = ${call}`,
    `print(resp.status_code, resp.json())`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function snippetTypeScript(ctx: SnippetCtx): string {
  if (ctx.method === 'WS') {
    return [
      `// Browsers can't set custom headers on WebSocket, so for prod`,
      `// use a Node/Deno/Bun client (\`ws\` library) that supports headers.`,
      `import WebSocket from "ws";`,
      ``,
      `const ws = new WebSocket("${ctx.url}", {`,
      `  headers: { Authorization: "Bearer YOUR_API_KEY" },`,
      `});`,
      `ws.on("open", () => ws.send(JSON.stringify({ type: "text", text: "hello" })));`,
      `ws.on("message", (data, isBinary) => {`,
      `  if (isBinary) console.log("audio:", (data as Buffer).length, "bytes");`,
      `  else console.log("event:", data.toString().slice(0, 120));`,
      `});`,
    ].join('\n');
  }
  const body = ctx.hasBody
    ? `\n\nconst payload = ${ctx.body || '{}'};\n`
    : '';
  const init = ctx.hasBody
    ? `{
  method: "${ctx.method}",
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
}`
    : `{
  method: "${ctx.method}",
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
  },
}`;
  return `const url = "${ctx.url}";${body}\nconst resp = await fetch(url, ${init});\nconst data = await resp.json();\nconsole.log(resp.status, data);`;
}

function snippetGo(ctx: SnippetCtx): string {
  if (ctx.method === 'WS') {
    return [
      `// go get nhooyr.io/websocket`,
      `package main`,
      ``,
      `import (`,
      `\t"context"`,
      `\t"fmt"`,
      `\t"net/http"`,
      `\t"nhooyr.io/websocket"`,
      `)`,
      ``,
      `func main() {`,
      `\tctx := context.Background()`,
      `\theaders := http.Header{"Authorization": []string{"Bearer YOUR_API_KEY"}}`,
      `\tc, _, _ := websocket.Dial(ctx, "${ctx.url}", &websocket.DialOptions{HTTPHeader: headers})`,
      `\tdefer c.Close(websocket.StatusNormalClosure, "")`,
      `\tc.Write(ctx, websocket.MessageText, []byte(\`{"type":"text","text":"hello"}\`))`,
      `\tfor {`,
      `\t\t_, data, err := c.Read(ctx)`,
      `\t\tif err != nil { return }`,
      `\t\tfmt.Println(string(data))`,
      `\t}`,
      `}`,
    ].join('\n');
  }
  const bodyDecl = ctx.hasBody
    ? `\tpayload := []byte(\`${ctx.body || '{}'}\`)\n\treq, _ := http.NewRequest("${ctx.method}", "${ctx.url}", bytes.NewBuffer(payload))\n\treq.Header.Set("Content-Type", "application/json")`
    : `\treq, _ := http.NewRequest("${ctx.method}", "${ctx.url}", nil)`;
  const imports = ctx.hasBody ? '"bytes"\n\t"fmt"\n\t"io"\n\t"net/http"' : '"fmt"\n\t"io"\n\t"net/http"';
  return `package main\n\nimport (\n\t${imports}\n)\n\nfunc main() {\n${bodyDecl}\n\treq.Header.Set("Authorization", "Bearer YOUR_API_KEY")\n\tresp, _ := http.DefaultClient.Do(req)\n\tdefer resp.Body.Close()\n\tbody, _ := io.ReadAll(resp.Body)\n\tfmt.Println(resp.StatusCode, string(body))\n}`;
}

function snippetRust(ctx: SnippetCtx): string {
  if (ctx.method === 'WS') {
    return [
      `// Cargo.toml: tokio-tungstenite = "0.23"  futures-util = "0.3"  tokio = { version = "1", features = ["full"] }`,
      `use futures_util::{SinkExt, StreamExt};`,
      `use tokio_tungstenite::{connect_async, tungstenite::{Message, client::IntoClientRequest}};`,
      ``,
      `#[tokio::main]`,
      `async fn main() -> Result<(), Box<dyn std::error::Error>> {`,
      `    let mut req = "${ctx.url}".into_client_request()?;`,
      `    req.headers_mut().insert("Authorization", "Bearer YOUR_API_KEY".parse()?);`,
      `    let (mut ws, _) = connect_async(req).await?;`,
      `    ws.send(Message::Text(r#"{"type":"text","text":"hello"}"#.into())).await?;`,
      `    while let Some(msg) = ws.next().await {`,
      `        println!("{:?}", msg?);`,
      `    }`,
      `    Ok(())`,
      `}`,
    ].join('\n');
  }
  const body = ctx.hasBody
    ? `\n    let payload = serde_json::json!(${ctx.body || '{}'});\n    let resp = client\n        .${ctx.method.toLowerCase()}("${ctx.url}")\n        .bearer_auth("YOUR_API_KEY")\n        .json(&payload)\n        .send()\n        .await?;`
    : `\n    let resp = client\n        .${ctx.method.toLowerCase()}("${ctx.url}")\n        .bearer_auth("YOUR_API_KEY")\n        .send()\n        .await?;`;
  return `// Cargo.toml: reqwest = { version = "0.12", features = ["json"] }\nuse reqwest::Client;\n\n#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {\n    let client = Client::new();${body}\n    println!("{} {}", resp.status(), resp.text().await?);\n    Ok(())\n}`;
}

function buildSnippet(lang: Lang, ctx: SnippetCtx): string {
  switch (lang) {
    case 'curl': return snippetCurl(ctx);
    case 'python': return snippetPython(ctx);
    case 'typescript': return snippetTypeScript(ctx);
    case 'go': return snippetGo(ctx);
    case 'rust': return snippetRust(ctx);
  }
}

/* -------------------------------------------------------------------------- */
/*  UI primitives                                                             */
/* -------------------------------------------------------------------------- */

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
    >
      <Copy size={12} strokeWidth={2} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Collapsible({
  title,
  count,
  dotColor,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  dotColor?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-white/[0.06] bg-black/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-[13px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.02]"
      >
        <span className="inline-flex items-center gap-2">
          {dotColor && <span className="h-1.5 w-1.5 rounded-full" style={{ background: dotColor }} />}
          {title}
          {count !== undefined && <span className="text-zinc-500">({count})</span>}
        </span>
        {/* ChevronDown rotated to "right" when closed and back to down
            when open — matches the inline triangle/caret pattern in
            the screenshot without needing a second icon component. */}
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={`text-zinc-400 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
        />
      </button>
      {open && <div className="border-t border-white/[0.06] px-4 py-3 space-y-3">{children}</div>}
    </div>
  );
}

/* Renders a JSON-Schema type string like "string | null" or "integer". */
function formatType(schema: any): string {
  if (!schema) return 'any';
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf
      .map((s: any) => formatType(s))
      .join(' | ');
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((s: any) => formatType(s)).join(' | ');
  }
  if (schema.enum) return 'enum';
  if (schema.type === 'array') {
    const inner = schema.items ? formatType(schema.items) : 'any';
    return `${inner}[]`;
  }
  return schema.type || 'any';
}

/** Collect every constraint and enum from a schema (recursing into
 *  anyOf/oneOf) and return them as small strings the table can render
 *  as chips. We pull from JSON-Schema fields Pydantic emits when you
 *  use Field(max_length=..., ge=..., enum, etc.). */
interface SchemaConstraints {
  enums: string[];
  ranges: string[]; // ['1–120 chars', '0.0–2.0', '≤ 16 items', etc.]
}

function collectConstraints(schema: any, out: SchemaConstraints = { enums: [], ranges: [] }): SchemaConstraints {
  if (!schema || typeof schema !== 'object') return out;
  // Walk anyOf/oneOf branches (the "string | null" union case).
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) collectConstraints(sub, out);
    }
  }
  if (Array.isArray(schema.enum)) {
    for (const v of schema.enum) {
      const s = String(v);
      if (!out.enums.includes(s)) out.enums.push(s);
    }
  }
  // String length: "≤ N chars" or "1–N chars"
  const min = schema.minLength;
  const max = schema.maxLength;
  if (typeof max === 'number') {
    if (typeof min === 'number' && min > 0) out.ranges.push(`${min}–${max} chars`);
    else out.ranges.push(`≤ ${max} chars`);
  }
  // Number range: "0.0–2.0", "≥ 1", "≤ 50"
  const gMin = schema.minimum ?? schema.exclusiveMinimum;
  const gMax = schema.maximum ?? schema.exclusiveMaximum;
  if (typeof gMin === 'number' && typeof gMax === 'number') out.ranges.push(`${gMin}–${gMax}`);
  else if (typeof gMin === 'number') out.ranges.push(`≥ ${gMin}`);
  else if (typeof gMax === 'number') out.ranges.push(`≤ ${gMax}`);
  // Array constraints
  if (typeof schema.maxItems === 'number') out.ranges.push(`≤ ${schema.maxItems} items`);
  if (typeof schema.minItems === 'number' && schema.minItems > 0)
    out.ranges.push(`≥ ${schema.minItems} items`);
  // Recurse into array items so we also surface their enum / range.
  if (schema.items) collectConstraints(schema.items, out);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Operation card                                                            */
/* -------------------------------------------------------------------------- */

function ParameterRow({ name, type, required, description, schema }: {
  name: string;
  type: string;
  required: boolean;
  description: string;
  schema?: any;
}) {
  const c = schema ? collectConstraints(schema) : { enums: [], ranges: [] };
  return (
    <tr className="align-top">
      <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-cyan-300">{name}</td>
      <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-zinc-400">{type}</td>
      <td className="whitespace-nowrap px-4 py-3 text-zinc-400">{required ? 'Yes' : 'No'}</td>
      <td className="px-4 py-3 text-zinc-500">
        {description ? (
          <p className="whitespace-pre-line leading-relaxed">{description}</p>
        ) : (
          <span>—</span>
        )}
        {(c.ranges.length > 0 || c.enums.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {c.ranges.map((r) => (
              <span
                key={`r-${r}`}
                className="rounded-md border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-200"
              >
                {r}
              </span>
            ))}
            {c.enums.length > 0 && c.enums.length <= 24 && c.enums.map((e) => (
              <span
                key={`e-${e}`}
                className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
              >
                {e}
              </span>
            ))}
            {c.enums.length > 24 && (
              <span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                enum · {c.enums.length} values
              </span>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function ParameterTable({ params, body }: { params: Parameter[]; body?: Operation['requestBody'] }) {
  // Flatten the request body's top-level properties into the same
  // table so audio size / language enum / enabled_tools / etc. are
  // documented next to the path-and-query params instead of being
  // hidden inside the raw JSON example.
  const bodyRows: Array<{ name: string; required: boolean; description: string; schema: any }> = [];
  if (body && body.schema && body.schema.properties) {
    const required: string[] = Array.isArray(body.schema.required) ? body.schema.required : [];
    for (const [k, v] of Object.entries<any>(body.schema.properties)) {
      bodyRows.push({
        name: k,
        required: required.includes(k),
        description: v?.description || '',
        schema: v,
      });
    }
  }
  if (!params.length && !bodyRows.length) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-white">Parameters</h3>
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-white/[0.03]">
            <tr className="border-b border-white/[0.06]">
              <th className="px-4 py-2.5 font-medium text-zinc-300">Parameter</th>
              <th className="px-4 py-2.5 font-medium text-zinc-300">Type</th>
              <th className="px-4 py-2.5 font-medium text-zinc-300">Required</th>
              <th className="px-4 py-2.5 font-medium text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {params.map((p) => (
              <ParameterRow
                key={`${p.in}-${p.name}`}
                name={p.name}
                type={formatType(p.schema)}
                required={p.required}
                description={p.description || ''}
                schema={p.schema}
              />
            ))}
            {bodyRows.map((b) => (
              <ParameterRow
                key={`body-${b.name}`}
                name={b.name}
                type={formatType(b.schema)}
                required={b.required}
                description={b.description}
                schema={b.schema}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResponseTable({ responses }: { responses: ResponseEntry[] }) {
  if (!responses.length) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-white">Responses</h3>
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-white/[0.03]">
            <tr className="border-b border-white/[0.06]">
              <th className="px-4 py-2.5 font-medium text-zinc-300">Status Code</th>
              <th className="px-4 py-2.5 font-medium text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody>
            {responses.map((r, i) => (
              <tr
                key={r.status}
                className={`${i + 1 < responses.length ? 'border-b border-white/[0.04]' : ''}`}
              >
                <td className="px-4 py-3 font-mono text-[12px] text-zinc-200">{r.status}</td>
                <td className="px-4 py-3 text-zinc-400">{r.description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuthNote({ required }: { required: boolean }) {
  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold text-white">Authentication</h3>
      <p className="text-[13px] text-zinc-500">
        {required
          ? 'This endpoint requires authentication.'
          : 'This endpoint does not require authentication.'}
      </p>
    </div>
  );
}

function OperationCard({ op }: { op: Operation }) {
  const color = METHOD_COLORS[op.method];
  const [lang, setLang] = useState<Lang>('curl');
  const [token, setToken] = useState('');
  // Per-param string values for path/query params.
  const [paramVals, setParamVals] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of op.parameters) {
      if (p.in === 'header' && p.name.toLowerCase() === 'authorization') continue;
      initial[p.name] = '';
    }
    return initial;
  });
  const initialBody = useMemo(() => {
    if (!op.requestBody) return '';
    const ex = exampleFromSchema(op.requestBody.schema);
    return ex === null ? '' : JSON.stringify(ex, null, 2);
  }, [op.requestBody]);
  const [bodyJson, setBodyJson] = useState<string>(initialBody);
  const [execState, setExecState] = useState<{ loading: boolean; status?: number; body?: string; error?: string }>({
    loading: false,
  });

  const ctx = useMemo(() => buildSnippetCtx(op, paramVals, bodyJson), [op, paramVals, bodyJson]);
  const snippet = useMemo(() => buildSnippet(lang, ctx), [lang, ctx]);

  // Non-auth header/path/query parameters (auth gets a dedicated input above).
  const visibleParams = op.parameters.filter(
    (p) => !(p.in === 'header' && p.name.toLowerCase() === 'authorization')
  );

  async function execute() {
    setExecState({ loading: true });
    try {
      // Build request URL relative to REQUEST_BASE so Vite/Vercel
      // proxy us to the developer-api.
      let path = op.path;
      for (const p of op.parameters.filter((x) => x.in === 'path')) {
        path = path.replace(`{${p.name}}`, encodeURIComponent(paramVals[p.name] || ''));
      }
      const qsPairs = op.parameters
        .filter((x) => x.in === 'query')
        .map((x) => [x.name, paramVals[x.name] || ''])
        .filter(([_, v]) => v !== '');
      const qs = qsPairs.length ? '?' + qsPairs.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&') : '';
      const url = `${REQUEST_BASE}${path}${qs}`;
      const headers: Record<string, string> = {};
      if (token.trim()) {
        const v = token.trim();
        headers['Authorization'] = v.toLowerCase().startsWith('bearer ') ? v : `Bearer ${v}`;
      }
      const init: RequestInit = { method: op.method.toUpperCase(), headers };
      if (ctx.hasBody && bodyJson.trim()) {
        headers['Content-Type'] = 'application/json';
        init.body = bodyJson;
      }
      for (const p of op.parameters.filter((x) => x.in === 'header')) {
        if (p.name.toLowerCase() === 'authorization') continue;
        const v = paramVals[p.name];
        if (v) headers[p.name] = v;
      }
      const resp = await fetch(url, init);
      const text = await resp.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      setExecState({ loading: false, status: resp.status, body: pretty });
    } catch (e) {
      setExecState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <article id={op.id} className="space-y-6 scroll-mt-24">
      {/* === The card === */}
      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0B0D10]">
        <header
          className="space-y-1 border-b px-5 py-3"
          style={{ borderColor: color.border, background: color.bg }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Terminal size={18} style={{ color: color.text }} strokeWidth={2} />
              <span
                className="rounded-md px-2 py-0.5 text-[11px] font-bold uppercase"
                style={{ background: 'rgba(0,0,0,0.25)', color: color.text, border: `1px solid ${color.border}` }}
              >
                {op.method}
              </span>
              <code className="truncate text-sm font-medium text-zinc-100">{op.path}</code>
            </div>
            <span className="hidden shrink-0 items-center gap-1 text-[11px] uppercase tracking-wider text-zinc-500 sm:inline-flex">
              API
            </span>
          </div>
          {op.summary && (
            <p className="pl-9 text-[13px] leading-snug text-zinc-300">{op.summary}</p>
          )}
        </header>

        <div className="space-y-4 p-5">
          {/* Code examples */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
              <Code2 size={13} /> Code Examples
            </div>
            <div className="flex flex-wrap gap-1">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLang(l.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    lang === l.id
                      ? 'bg-white text-[#07080A]'
                      : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <div className="relative rounded-lg border border-white/[0.06] bg-black/40">
              <pre className="overflow-x-auto p-3 pr-12 font-mono text-[12px] leading-relaxed text-zinc-200 whitespace-pre">{snippet}</pre>
              <div className="absolute right-2 top-2">
                <CopyButton value={snippet} />
              </div>
            </div>
          </div>

          {/* Request Configuration — collapsed by default like the screenshot. */}
          <Collapsible title="Request Configuration" defaultOpen={false}>
            {/* Authorization sub-card */}
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="mb-2 inline-flex items-center gap-2 text-[12px] font-medium text-zinc-200">
                <span className="h-1.5 w-1.5 rounded-full bg-[#F59E0B]" />
                Authorization
              </div>
              <p className="mb-2 text-[11px] text-zinc-500">API Key or Bearer Token</p>
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Bearer your-api-key"
                spellCheck={false}
                className="w-full rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
              />
            </div>
          </Collapsible>

          {/* Parameters + Body (form values to send). Hidden for WS —
              you can't fire a WebSocket via Execute Request anyway. */}
          {op.method !== 'ws' && (visibleParams.length > 0 || op.requestBody) && (
            <Collapsible
              title="Parameters"
              count={visibleParams.length + (op.requestBody ? 1 : 0)}
              dotColor="#60A5FA"
              defaultOpen={false}
            >
              {visibleParams.map((p) => (
                <div key={`${p.in}-${p.name}`} className="space-y-1">
                  <label className="flex items-center gap-2 text-[12px] font-medium text-zinc-300">
                    <span>{p.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">{p.in}</span>
                    {p.required && <span className="text-[10px] text-red-400">required</span>}
                  </label>
                  {p.description && <p className="text-[11px] leading-relaxed text-zinc-500">{p.description}</p>}
                  <input
                    type="text"
                    value={paramVals[p.name] || ''}
                    onChange={(e) => setParamVals((v) => ({ ...v, [p.name]: e.target.value }))}
                    placeholder={p.schema?.example ? String(p.schema.example) : p.schema?.type || 'value'}
                    spellCheck={false}
                    className="w-full rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
                  />
                </div>
              ))}
              {op.requestBody && (
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-[12px] font-medium text-zinc-300">
                    Body
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">{op.requestBody.contentType}</span>
                    {op.requestBody.required && <span className="text-[10px] text-red-400">required</span>}
                  </label>
                  <textarea
                    value={bodyJson}
                    onChange={(e) => setBodyJson(e.target.value)}
                    rows={Math.min(12, Math.max(4, bodyJson.split('\n').length))}
                    spellCheck={false}
                    className="w-full rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
                  />
                </div>
              )}
            </Collapsible>
          )}

          {/* Execute — REST only. WS opens a live, long-lived connection
              that doesn't fit the request/response shape this button is
              built for; the language snippets are the runnable form. */}
          {op.method !== 'ws' && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={execState.loading}
                onClick={execute}
                className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <Play size={14} strokeWidth={2.5} />
                {execState.loading ? 'Executing…' : 'Execute Request'}
              </button>
              {execState.status !== undefined && (
                <span
                  className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                    execState.status >= 200 && execState.status < 300
                      ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-red-400/40 bg-red-500/10 text-red-300'
                  }`}
                >
                  HTTP {execState.status}
                </span>
              )}
            </div>
          )}

          {/* Response panel (only after Execute) */}
          {(execState.body || execState.error) && (
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">Response</div>
              <pre className="max-h-[400px] overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-zinc-200 whitespace-pre-wrap">
                {execState.error || execState.body}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* === Below-the-card sections (full width) === */}
      <div className="text-[12px] text-zinc-500">
        <span className="font-semibold text-zinc-300">Endpoint:</span>{' '}
        <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-zinc-200">
          {op.method.toUpperCase()} {op.path}
        </code>
      </div>

      <ParameterTable params={visibleParams} body={op.requestBody} />
      <ResponseTable responses={op.responses} />
      <AuthNote required={op.requiresAuth} />
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Right-side TOC                                                            */
/* -------------------------------------------------------------------------- */

function ApiToc({ operations, groups }: { operations: Operation[]; groups: Map<string, Operation[]> }) {
  const [activeId, setActiveId] = useState<string | null>(operations[0]?.id || null);

  useEffect(() => {
    if (!operations.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );
    for (const op of operations) {
      const el = document.getElementById(op.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [operations]);

  return (
    <nav className="space-y-6 text-[12px]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">On this page</div>
      {Array.from(groups.entries()).map(([tag, ops]) => (
        <div key={tag} className="space-y-1.5 border-l border-white/[0.06] pl-3">
          <div className="text-[11px] font-medium text-zinc-300">{tag} API Reference</div>
          <ul className="space-y-0.5">
            {ops.map((op) => {
              const color = METHOD_COLORS[op.method];
              const active = op.id === activeId;
              return (
                <li key={op.id}>
                  <a
                    href={`#${op.id}`}
                    className={`flex items-center gap-2 rounded px-2 py-1 transition-colors ${
                      active ? 'bg-white/[0.05] text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300'
                    }`}
                  >
                    <span
                      className="text-[10px] font-bold uppercase"
                      style={{ color: color.dot, minWidth: 42 }}
                    >
                      {op.method}
                    </span>
                    <span className="truncate">{op.summary}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/*  Top-level                                                                 */
/* -------------------------------------------------------------------------- */

export function ApiExplorer({ specUrl = '/devapi/openapi.json', className }: Props) {
  const [state, setState] = useState<FetchResult | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSpec(specUrl).then((r) => {
      if (!cancelled) setState(r);
    });
    return () => { cancelled = true; };
  }, [specUrl]);

  if (state === null) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2 text-sm text-zinc-400 py-6">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#DFFF00] border-t-transparent" />
          Loading API reference…
        </div>
      </div>
    );
  }
  if (!state.ok) {
    return (
      <div className={className}>
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.05] p-4 text-sm text-red-200">
          {state.error}
        </div>
      </div>
    );
  }

  // Stable tag order = order of first appearance.
  const groups = new Map<string, Operation[]>();
  for (const op of state.operations) {
    if (!groups.has(op.tag)) groups.set(op.tag, []);
    groups.get(op.tag)!.push(op);
  }

  return (
    <div ref={containerRef} className={className}>
      <div className="flex gap-8">
        <div className="min-w-0 flex-1 space-y-10">
          {Array.from(groups.entries()).map(([tag, ops]) => (
            <section key={tag} className="space-y-4">
              <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">{tag}</h2>
              <div className="space-y-6">
                {ops.map((op) => (
                  <OperationCard key={op.id} op={op} />
                ))}
              </div>
            </section>
          ))}
        </div>
        {/* Right rail. Sticky AND has its own scrollbar so a long TOC
            can be scrolled independently of the main content. The
            inner div gets the height + overflow so the sticky wrapper
            stays pinned to the viewport. */}
        <aside className="hidden w-[260px] shrink-0 xl:block">
          <div className="sticky top-[5.5rem] max-h-[calc(100vh-6rem)] overflow-y-auto pr-2">
            <ApiToc operations={state.operations} groups={groups} />
          </div>
        </aside>
      </div>
    </div>
  );
}
