import { useEffect, useState } from 'preact/hooks';
import { redirectUrl, secondsUntilExpiry, signIn, storeCredentials, type AwsCredentials, type OidcConfig } from '../auth';
import { capturedColumns, requiredOrigins, unselectedTokens, type AttachedSource } from '../datasource';
import type { TokenValue } from '../s3list';
import { FORMAT_OPTIONS, TEMPLATES } from '../formats';
import { isTimeCandidate } from '../fields';
import type { AttachProgress } from '../app';
import { hasHostPermissions, isExtension, listGrantedOrigins, removeOrigin } from '../permissions';
import type { AuthMode, SourceConfig } from '../state';
import { CachePanel } from './CachePanel';

export function DataSource(props: {
  config: SourceConfig;
  attached: AttachedSource | null;
  error: string | null;
  busy: boolean;
  /** what the running connect is doing (null when idle or while DuckDB is still starting) */
  progress: AttachProgress | null;
  creds: AwsCredentials | null;
  /** values listed for the {name} tokens of `pattern` (by pressing Connect) */
  variables: { pattern: string; values: Record<string, TokenValue[]>; listedFiles: number } | null;
  onConnect: (cfg: SourceConfig, files: File[]) => void;
  onCancel: () => void;
  onTimeField: (name: string | null) => void;
  onCreds: (c: AwsCredentials | null) => void;
}) {
  const [cfg, setCfg] = useState<SourceConfig>(props.config);
  const [files, setFiles] = useState<File[]>([]);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [granted, setGranted] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string>('');
  const [pendingTemplate, setPendingTemplate] = useState<(typeof TEMPLATES)[number] | null>(null);
  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    set({ urls: t.urls, format: t.format, timeField: null, tokenValues: {}, name: cfg.name === 'demo-logs' || !cfg.name ? t.id : cfg.name });
    setTemplateId(t.id);
    setPendingTemplate(null);
  };
  const chooseTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    if (cfg.urls.trim() && cfg.urls.trim() !== t.urls) setPendingTemplate(t);
    else applyTemplate(t);
  };
  const [needPerm, setNeedPerm] = useState(false);
  const set = (p: Partial<SourceConfig>) => setCfg({ ...cfg, ...p });
  const setS3 = (p: Partial<SourceConfig['s3']>) => setCfg({ ...cfg, s3: { ...cfg.s3, ...p } });
  const setOidc = (p: Partial<OidcConfig>) => setCfg({ ...cfg, oidc: { ...cfg.oidc, ...p } });
  const usesS3 = cfg.kind === 'url' && /(^|\n)\s*s3:\/\//.test(cfg.urls);
  const tokens = cfg.kind === 'url' ? capturedColumns(cfg) : [];
  const vars = props.variables && props.variables.pattern === cfg.urls ? props.variables : null;
  const missing = unselectedTokens(cfg);
  const setTokenValues = (name: string, values: string[]) => set({ tokenValues: { ...(cfg.tokenValues ?? {}), [name]: values } });
  const connectLabel = props.busy ? 'Connecting…' : tokens.length && !vars ? 'List values & connect' : 'Connect';
  const origins = cfg.kind === 'url' ? requiredOrigins(cfg) : [];

  useEffect(() => {
    listGrantedOrigins().then(setGranted);
    hasHostPermissions(origins).then((ok) => setNeedPerm(!ok));
  }, [cfg.urls, cfg.s3.endpoint, cfg.s3.urlStyle, props.attached]);

  const doSignIn = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const c = await signIn(cfg.oidc, true);
      props.onCreds(c);
    } catch (e) {
      setAuthError(String(e));
    } finally {
      setAuthBusy(false);
    }
  };
  const expiresIn = props.creds ? Math.max(0, Math.round(secondsUntilExpiry(props.creds) / 60)) : 0;

  return (
    <div class="source-page">
      <div class="card">
        <h2>Data source</h2>
        <p class="hint" style="margin-top:-6px">
          Files are read straight from the storage that hosts them, and only the parts a query needs. Nothing is sent anywhere else.
        </p>
        <div class="kinds">
          <button class={cfg.kind === 'url' ? 'active' : ''} onClick={() => set({ kind: 'url' })}>
            <b>S3 / HTTPS URL</b>
            <span>s3://bucket/prefix/*.parquet or https://…</span>
          </button>
          <button class={cfg.kind === 'local' ? 'active' : ''} onClick={() => set({ kind: 'local' })}>
            <b>Local files</b>
            <span>Parquet / CSV / JSON on this machine</span>
          </button>
          <button class={cfg.kind === 'demo' ? 'active' : ''} onClick={() => set({ kind: 'demo' })}>
            <b>Demo data</b>
            <span>120k synthetic web access logs</span>
          </button>
        </div>

        {cfg.kind === 'url' && (
          <>
            <div class="template-box">
              <div class="row" style="gap:10px;align-items:center">
                <span class="template-title">Template</span>
                <select class="input" style="max-width:320px" value={pendingTemplate?.id ?? templateId} onChange={(e) => chooseTemplate((e.target as HTMLSelectElement).value)}>
                  <option value="">Choose an AWS log family…</option>
                  {TEMPLATES.map((t) => (
                    <option value={t.id}>{t.label}</option>
                  ))}
                </select>
                <span class="hint">Fills the pattern and format below; replace &lt;bucket&gt; / &lt;prefix&gt; afterwards.</span>
              </div>
              {pendingTemplate && (
                <div class="alert warn" style="margin:8px 0 0">
                  Applying "{pendingTemplate.label}" replaces the current URL pattern and format. Continue?
                  <span style="margin-left:8px">
                    <button class="btn small primary" onClick={() => applyTemplate(pendingTemplate)}>
                      Replace
                    </button>{' '}
                    <button class="btn small" onClick={() => setPendingTemplate(null)}>
                      Keep current
                    </button>
                  </span>
                </div>
              )}
              {!pendingTemplate && templateId && TEMPLATES.find((t) => t.id === templateId) && <div class="hint" style="margin-top:6px">{TEMPLATES.find((t) => t.id === templateId)!.note}</div>}
            </div>
            <div class="field-row">
              <label>URLs or patterns, one per line (s3://, https://; lines starting with # are ignored)</label>
              <textarea
                class="input"
                value={cfg.urls}
                onInput={(e) => set({ urls: (e.target as HTMLTextAreaElement).value, timeField: null, tokenValues: {} })}
                placeholder={'s3://my-logs/AWSLogs/123456789012/elasticloadbalancing/ap-northeast-1/{yyyy}/{MM}/{dd}/*.log.gz\ns3://my-bucket/events/dt={yyyy}-{MM}-{dd}/*.parquet\nhttps://d1234.cloudfront.net/logs/2026-09-09.parquet'}
              />
              <span class="hint">
                s3:// patterns may use <code>*</code>, <code>?</code>, <code>**</code> and the date tokens <code>{'{yyyy} {MM} {dd} {HH}'}</code>, which are filled from the time picker (UTC) so only the partitions inside the selected range are listed and read. Any other <code>{'{name}'}</code> is a named wildcard: the matched text becomes a column (e.g. <code>{'app.{alb}.*.log.gz'}</code> gives an <code>alb</code> field you can search and filter on; an "is" filter on it also stops the other files from being read).
              </span>
            </div>
            {tokens.length > 0 && (
              <div class="variables-box">
                <div class="row" style="justify-content:space-between;align-items:center">
                  <span class="variables-title">Pattern variables · {tokens.join(', ')}</span>
                  {vars && (
                    <span class="row" style="gap:6px">
                      <span class="hint">{vars.listedFiles.toLocaleString()} files in the newest partition(s)</span>
                      <button class="btn small" onClick={() => set({ tokenValues: Object.fromEntries(tokens.map((n) => [n, (vars.values[n] ?? []).map((v) => v.value)])) })}>
                        Select all values
                      </button>
                    </span>
                  )}
                </div>
                {!vars && (
                  <div class="hint" style="margin-top:6px">
                    Each {'{name}'} in the pattern is a variable. Press "List values & connect": the newest partition is listed, the values found for {tokens.join(', ')} are shown here, and you choose which ones to read (at least one per variable). Nothing is read until then.
                  </div>
                )}
                {vars &&
                  tokens.map((n) => {
                    const opts = vars.values[n] ?? [];
                    const sel = cfg.tokenValues?.[n] ?? [];
                    return (
                      <div class="var-values" data-token={n} style="margin-top:8px">
                        <div class="row" style="gap:8px;align-items:center">
                          <b class="mono" style="font-size:12px">{'{' + n + '}'}</b>
                          <span class="hint">{opts.length} value(s) · {sel.length} selected</span>
                          <button class="btn ghost small" onClick={() => setTokenValues(n, opts.map((v) => v.value))}>
                            All
                          </button>
                          <button class="btn ghost small" onClick={() => setTokenValues(n, [])}>
                            None
                          </button>
                        </div>
                        <div class="var-list">
                          {opts.map((v) => (
                            <label class="var-item">
                              <input
                                type="checkbox"
                                checked={sel.includes(v.value)}
                                onChange={(e) => setTokenValues(n, (e.target as HTMLInputElement).checked ? [...sel, v.value] : sel.filter((x) => x !== v.value))}
                              />
                              <span class="mono">{v.value || '(empty)'}</span>
                              <span class="hint">{v.files.toLocaleString()} file(s)</span>
                            </label>
                          ))}
                          {opts.length === 0 && <span class="hint">No value found in the newest partition.</span>}
                        </div>
                      </div>
                    );
                  })}
                {vars && missing.length > 0 && <div class="alert warn" style="margin-top:8px">Select at least one value for: {missing.join(', ')}</div>}
              </div>
            )}
            <div class="grid2">
              <div class="field-row">
                <label>Format</label>
                <select class="input" value={cfg.format} onChange={(e) => set({ format: (e.target as HTMLSelectElement).value as SourceConfig['format'] })}>
                  {FORMAT_OPTIONS.map((o) => (
                    <option value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div class="field-row">
                <label>Name</label>
                <input class="input" value={cfg.name} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="field-row">
                <label>Warn when more files than this match before connecting (default 1000)</label>
                <input class="input" type="number" min={1} value={cfg.maxFiles || ''} placeholder="1000" onInput={(e) => set({ maxFiles: Number((e.target as HTMLInputElement).value) || 0 })} />
              </div>
            </div>
            <span class="hint">
              Listing uses the literal text before the first wildcard as the S3 prefix, so put the load balancer name in the pattern when a day folder holds many ALBs. Files whose name carries a timestamp (…_20260909T0105Z_…) outside the time range are skipped automatically.
            </span>
            {usesS3 && (
              <div style="margin-top:8px">
                <h4 style="margin:8px 0 6px;font-size:13px">S3 endpoint</h4>
                <div class="grid2">
                  <div class="field-row">
                    <label>Region</label>
                    <input class="input" value={cfg.s3.region} onInput={(e) => setS3({ region: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="field-row">
                    <label>Endpoint (optional; AWS: s3.&lt;region&gt;.amazonaws.com, MinIO / R2: host or http://host:9000)</label>
                    <input class="input" value={cfg.s3.endpoint} onInput={(e) => setS3({ endpoint: (e.target as HTMLInputElement).value })} placeholder="s3.ap-northeast-1.amazonaws.com" />
                  </div>
                  <div class="field-row">
                    <label>URL style</label>
                    <select class="input" value={cfg.s3.urlStyle} onChange={(e) => setS3({ urlStyle: (e.target as HTMLSelectElement).value as 'vhost' | 'path' })}>
                      <option value="vhost">Virtual-hosted: bucket.endpoint/key (AWS default)</option>
                      <option value="path">Path style: endpoint/bucket/key (MinIO, R2, localhost)</option>
                    </select>
                  </div>
                  <div class="field-row">
                    <label>Authentication</label>
                    <select class="input" value={cfg.authMode} onChange={(e) => set({ authMode: (e.target as HTMLSelectElement).value as AuthMode })}>
                      <option value="oidc">Sign in (OIDC) → STS temporary credentials (recommended)</option>
                      <option value="static">Access key (stored in this browser)</option>
                      <option value="none">None (public bucket)</option>
                    </select>
                  </div>
                </div>

                {cfg.authMode === 'static' && (
                  <>
                    <h4 style="margin:12px 0 6px;font-size:13px">Access key</h4>
                    <div class="alert info">Keys are kept in this extension's localStorage. Prefer temporary credentials (session token) or the OIDC sign-in.</div>
                    <div class="grid2">
                      <div class="field-row">
                        <label>Access key ID</label>
                        <input class="input" value={cfg.s3.accessKeyId} onInput={(e) => setS3({ accessKeyId: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                      <div class="field-row">
                        <label>Secret access key</label>
                        <input class="input" type="password" value={cfg.s3.secretAccessKey} onInput={(e) => setS3({ secretAccessKey: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                      <div class="field-row">
                        <label>Session token (for temporary credentials)</label>
                        <input class="input" type="password" value={cfg.s3.sessionToken} onInput={(e) => setS3({ sessionToken: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                    </div>
                  </>
                )}

                {cfg.authMode === 'oidc' && (
                  <>
                    <h4 style="margin:12px 0 6px;font-size:13px">OIDC sign-in → AWS STS</h4>
                    <p class="hint" style="margin-top:0">
                      The browser signs in at your identity provider, then calls STS <code>AssumeRoleWithWebIdentity</code> directly. No long-lived key exists anywhere; temporary credentials live in memory (chrome.storage.session) and are refreshed automatically. Register this redirect URL at the identity provider: <code>{redirectUrl()}</code>
                    </p>
                    <div class="grid2">
                      <div class="field-row">
                        <label>Authorization endpoint</label>
                        <input class="input" value={cfg.oidc.authUrl} onInput={(e) => setOidc({ authUrl: (e.target as HTMLInputElement).value })} placeholder="https://accounts.google.com/o/oauth2/v2/auth" />
                      </div>
                      <div class="field-row">
                        <label>Client ID</label>
                        <input class="input" value={cfg.oidc.clientId} onInput={(e) => setOidc({ clientId: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                      <div class="field-row">
                        <label>Scope</label>
                        <input class="input" value={cfg.oidc.scope} onInput={(e) => setOidc({ scope: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="field-row">
                        <label>Extra parameters (optional, e.g. hd=example.com)</label>
                        <input class="input" value={cfg.oidc.extraParams} onInput={(e) => setOidc({ extraParams: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="field-row">
                        <label>IAM role ARN (trusts the OIDC provider)</label>
                        <input class="input" value={cfg.oidc.roleArn} onInput={(e) => setOidc({ roleArn: (e.target as HTMLInputElement).value })} placeholder="arn:aws:iam::123456789012:role/duckdive-readonly" />
                      </div>
                      <div class="field-row">
                        <label>Session duration (seconds, 900–43200, within the role's maximum)</label>
                        <input class="input" type="number" value={cfg.oidc.durationSeconds} onInput={(e) => setOidc({ durationSeconds: Number((e.target as HTMLInputElement).value) || 3600 })} />
                      </div>
                      <div class="field-row">
                        <label>STS endpoint (optional override)</label>
                        <input class="input" value={cfg.oidc.stsEndpoint} onInput={(e) => setOidc({ stsEndpoint: (e.target as HTMLInputElement).value })} placeholder={`https://sts.${cfg.s3.region || 'ap-northeast-1'}.amazonaws.com/`} />
                      </div>
                    </div>
                    <div class="row" style="margin-top:8px">
                      <button class="btn" disabled={authBusy || !isExtension} onClick={doSignIn}>
                        {authBusy ? 'Signing in…' : 'Sign in'}
                      </button>
                      {props.creds ? (
                        <span class="hint">
                          Signed in{props.creds.subject ? ` as ${props.creds.subject}` : ''} · credentials expire in {expiresIn} min
                          <button
                            class="btn ghost small"
                            onClick={async () => {
                              await storeCredentials(null);
                              props.onCreds(null);
                            }}
                          >
                            Sign out
                          </button>
                        </span>
                      ) : (
                        <span class="hint">Not signed in{isExtension ? '' : ' (only available inside the extension)'}</span>
                      )}
                    </div>
                    {authError && <div class="alert error" style="margin-top:8px">{authError}</div>}
                  </>
                )}
              </div>
            )}
            {isExtension && origins.length > 0 && (
              <div class={'alert ' + (needPerm ? 'info' : 'ok')} style="margin-top:8px">
                {needPerm ? 'Connecting will ask for permission to access: ' : 'Access granted for: '}
                {origins.join(', ')}
              </div>
            )}
          </>
        )}

        {cfg.kind === 'local' && (
          <div class="field-row">
            <label>Files</label>
            <input type="file" multiple accept=".parquet,.csv,.tsv,.json,.jsonl,.ndjson,.gz" onChange={(e) => setFiles(Array.from((e.target as HTMLInputElement).files ?? []))} />
            <div class="row" style="margin-top:6px">
              <label class="hint">Format</label>
              <select class="input" style="width:260px" value={cfg.format} onChange={(e) => set({ format: (e.target as HTMLSelectElement).value as SourceConfig['format'] })}>
                {FORMAT_OPTIONS.map((o) => (
                  <option value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
            <span class="hint">Files are read in place through the browser File API; they are never uploaded.</span>
          </div>
        )}

        {cfg.kind === 'demo' && <div class="alert info">A synthetic access-log table (host/http/geo structs, tags list, JSON extra column) is generated in DuckDB so you can try every feature without any storage.</div>}

        {props.error && <div class="alert error">{props.error}</div>}
        <div class="row end" style="margin-top:8px;gap:10px;align-items:center">
          {props.busy && props.progress && (
            <span class="hint connect-progress" style="margin-right:auto">
              {props.progress.message}
            </span>
          )}
          {props.busy && props.progress && props.progress.phase !== 'db' && (
            <button class="btn" onClick={props.onCancel}>
              Cancel
            </button>
          )}
          <button class="btn primary" disabled={props.busy || (!!vars && missing.length > 0)} onClick={() => props.onConnect(cfg, files)}>
            {connectLabel}
          </button>
        </div>
      </div>

      {props.attached && (
        <div class="card">
          <h2>Connected</h2>
          <div class="alert ok">
            {props.attached.description}
            {props.attached.rowCount !== null ? ` · ${props.attached.rowCount.toLocaleString()} rows` : ' · rows are counted per time range in Discover'} · {props.attached.fields.length} fields
          </div>
          <div class="field-row" style="max-width:420px">
            <label>Time field (used for the time picker and histogram)</label>
            <select class="input" value={props.attached.timeField?.name ?? ''} onChange={(e) => props.onTimeField((e.target as HTMLSelectElement).value || null)}>
              <option value="">(none – no time filtering)</option>
              {props.attached.fields
                .filter((f) => f.kind === 'date' || isTimeCandidate(f))
                .map((f) => (
                  <option value={f.name}>
                    {f.name} ({f.duckType})
                  </option>
                ))}
            </select>
          </div>
          {(props.attached.rangeDependent || props.attached.captures.length > 0) && (
            <div class="alert info">
              {props.attached.rangeDependent ? 'This source uses date tokens: the file list is re-resolved whenever the time range changes. ' : ''}
              {props.attached.captures.length > 0 ? `Columns captured from file names: ${props.attached.captures.join(', ')} (filtering on them also prunes the file list).` : ''}
            </div>
          )}
          {props.attached.warning && (
            <div class="alert error" style="font-family:inherit">
              {props.attached.warning}
            </div>
          )}
          {!props.attached.warning && props.attached.totalBytes !== null && props.attached.totalBytes > 512 * 1048576 && (
            <div class="alert error" style="font-family:inherit">
              The matched files total {(props.attached.totalBytes / 1048576).toFixed(0)} MB. Text / gzip files are fetched whole and one after another, so the first query over this range will be slow. Narrow the time range, or convert wide ranges to hourly Parquet (scripts/alb-to-parquet.sh).
            </div>
          )}
          {props.attached.files.length > 0 && (
            <details>
              <summary class="hint" style="cursor:pointer">Files ({props.attached.files.length})</summary>
              <div class="sql-box" style="max-height:240px">{props.attached.files.slice(0, 500).join('\n')}{props.attached.files.length > 500 ? '\n…' : ''}</div>
            </details>
          )}
          <details>
            <summary class="hint" style="cursor:pointer">Fields</summary>
            <table class="kv" style="margin-top:6px">
              <tbody>
              {props.attached.fields.map((f) => (
                <tr>
                  <td class="k">{f.name}</td>
                  <td class="v">{f.duckType}</td>
                </tr>
              ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
      {isExtension && granted.length > 0 && (
        <div class="card">
          <h2>Granted hosts</h2>
          <p class="hint" style="margin-top:-6px">Hosts this extension is allowed to read from. AWS endpoints are allowed by default; any other host is requested when you connect.</p>
          <table class="kv">
            <tbody>
              {granted.map((g) => (
                <tr>
                  <td class="v">{g}</td>
                  <td class="a" style="visibility:visible">
                    {!/amazonaws\.com/.test(g) && (
                      <button
                        class="btn small"
                        style="visibility:visible;width:auto;height:auto;padding:2px 8px"
                        onClick={async () => {
                          await removeOrigin(g);
                          setGranted(await listGrantedOrigins());
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CachePanel />
    </div>
  );
}
