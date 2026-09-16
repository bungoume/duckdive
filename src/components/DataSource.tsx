import { useEffect, useState } from 'preact/hooks';
import { redirectUrl, secondsUntilExpiry, signIn, storeCredentials, type AwsCredentials, type OidcConfig } from '../auth';
import { capturedColumns, requiredOrigins, unselectedTokens, type AttachedSource } from '../datasource';
import type { TokenValue } from '../s3list';
import { FORMAT_IDS, TEMPLATES, formatLabel, templateLabel, templateNote } from '../formats';
import { t, tx } from '../i18n';
import { isTimeCandidate } from '../fields';
import type { AttachProgress } from '../app';
import { hasHostPermissions, isExtension, listGrantedOrigins, removeOrigin } from '../permissions';
import { SOURCE_HISTORY_MAX, sourceKey, type AuthMode, type SourceConfig, type SourceHistoryEntry } from '../state';
import { formatDate } from '../datefmt';
import { CachePanel } from './CachePanel';

export function DataSource(props: {
  config: SourceConfig;
  /** changes when a remembered source was loaded: the form is reset to `config` */
  switchSeq: number;
  history: SourceHistoryEntry[];
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
  onUseHistory: (cfg: SourceConfig) => void;
  onForgetHistory: (key: string) => void;
}) {
  const [cfg, setCfg] = useState<SourceConfig>(props.config);
  useEffect(() => {
    if (props.switchSeq) setCfg(props.config);
  }, [props.switchSeq]);
  const [files, setFiles] = useState<File[]>([]);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [granted, setGranted] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string>('');
  const [pendingTemplate, setPendingTemplate] = useState<(typeof TEMPLATES)[number] | null>(null);
  const applyTemplate = (tp: (typeof TEMPLATES)[number]) => {
    set({ urls: tp.urls, format: tp.format, timeField: null, tokenValues: {}, name: cfg.name === 'demo-logs' || !cfg.name ? tp.id : cfg.name });
    setTemplateId(tp.id);
    setPendingTemplate(null);
  };
  const chooseTemplate = (id: string) => {
    const tp = TEMPLATES.find((x) => x.id === id);
    if (!tp) return;
    if (cfg.urls.trim() && cfg.urls.trim() !== tp.urls) setPendingTemplate(tp);
    else applyTemplate(tp);
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
  const connectLabel = props.busy ? t('ds.connecting') : tokens.length && !vars ? t('ds.listAndConnect') : t('ds.connect');
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
        <h2>{t('ds.title')}</h2>
        <p class="hint" style="margin-top:-6px">
          {t('ds.intro')}
        </p>
        <div class="kinds">
          <button class={cfg.kind === 'url' ? 'active' : ''} onClick={() => set({ kind: 'url' })}>
            <b>{t('ds.kind.url')}</b>
            <span>{t('ds.kind.url.sub')}</span>
          </button>
          <button class={cfg.kind === 'local' ? 'active' : ''} onClick={() => set({ kind: 'local' })}>
            <b>{t('ds.kind.local')}</b>
            <span>{t('ds.kind.local.sub')}</span>
          </button>
          <button class={cfg.kind === 'demo' ? 'active' : ''} onClick={() => set({ kind: 'demo' })}>
            <b>{t('ds.kind.demo')}</b>
            <span>{t('ds.kind.demo.sub')}</span>
          </button>
        </div>

        {cfg.kind === 'url' && (
          <>
            <div class="template-box">
              <div class="row" style="gap:10px;align-items:center">
                <span class="template-title">{t('ds.template')}</span>
                <select class="input" style="max-width:320px" value={pendingTemplate?.id ?? templateId} onChange={(e) => chooseTemplate((e.target as HTMLSelectElement).value)}>
                  <option value="">{t('ds.template.choose')}</option>
                  {TEMPLATES.map((tp) => (
                    <option value={tp.id}>{templateLabel(tp)}</option>
                  ))}
                </select>
                <span class="hint">{t('ds.template.hint')}</span>
              </div>
              {pendingTemplate && (
                <div class="alert warn" style="margin:8px 0 0">
                  {t('ds.template.confirm', { label: templateLabel(pendingTemplate) })}
                  <span style="margin-left:8px">
                    <button class="btn small primary" onClick={() => applyTemplate(pendingTemplate)}>
                      {t('ds.template.replace')}
                    </button>{' '}
                    <button class="btn small" onClick={() => setPendingTemplate(null)}>
                      {t('ds.template.keep')}
                    </button>
                  </span>
                </div>
              )}
              {!pendingTemplate && templateId && TEMPLATES.find((x) => x.id === templateId) && <div class="hint" style="margin-top:6px">{templateNote(TEMPLATES.find((x) => x.id === templateId)!)}</div>}
            </div>
            <div class="field-row">
              <label>{t('ds.urls.label')}</label>
              <textarea
                class="input"
                value={cfg.urls}
                onInput={(e) => set({ urls: (e.target as HTMLTextAreaElement).value, timeField: null, tokenValues: {} })}
                placeholder={'s3://my-logs/AWSLogs/123456789012/elasticloadbalancing/ap-northeast-1/{yyyy}/{MM}/{dd}/*.log.gz\ns3://my-bucket/events/dt={yyyy}-{MM}-{dd}/*.parquet\nhttps://d1234.cloudfront.net/logs/2026-09-09.parquet'}
              />
              <span class="hint">
                {tx('ds.urls.hint', { star: <code>*</code>, q: <code>?</code>, dstar: <code>**</code>, dates: <code>{'{yyyy} {MM} {dd} {HH}'}</code>, name: <code>{'{name}'}</code>, example: <code>{'app.{alb}.*.log.gz'}</code>, alb: <code>alb</code> })}
              </span>
            </div>
            {tokens.length > 0 && (
              <div class="variables-box">
                <div class="row" style="justify-content:space-between;align-items:center">
                  <span class="variables-title">{t('ds.vars.title', { names: tokens.join(', ') })}</span>
                  {vars && (
                    <span class="row" style="gap:6px">
                      <span class="hint">{t('ds.vars.listed', { n: vars.listedFiles.toLocaleString() })}</span>
                      <button class="btn small" onClick={() => set({ tokenValues: Object.fromEntries(tokens.map((n) => [n, (vars.values[n] ?? []).map((v) => v.value)])) })}>
                        {t('ds.vars.selectAll')}
                      </button>
                    </span>
                  )}
                </div>
                {!vars && (
                  <div class="hint" style="margin-top:6px">
                    {t('ds.vars.hint', { button: t('ds.listAndConnect'), names: tokens.join(', ') })}
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
                          <span class="hint">{t('ds.vars.count', { n: opts.length, sel: sel.length })}</span>
                          <button class="btn ghost small" onClick={() => setTokenValues(n, opts.map((v) => v.value))}>
                            {t('ds.vars.all')}
                          </button>
                          <button class="btn ghost small" onClick={() => setTokenValues(n, [])}>
                            {t('ds.vars.none')}
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
                              <span class="mono">{v.value || t('common.empty')}</span>
                              <span class="hint">{t('common.files', { n: v.files.toLocaleString() })}</span>
                            </label>
                          ))}
                          {opts.length === 0 && <span class="hint">{t('ds.vars.noValue')}</span>}
                        </div>
                      </div>
                    );
                  })}
                {vars && missing.length > 0 && <div class="alert warn" style="margin-top:8px">{t('ds.vars.missing', { names: missing.join(', ') })}</div>}
              </div>
            )}
            <div class="grid2">
              <div class="field-row">
                <label>{t('common.format')}</label>
                <select class="input" value={cfg.format} onChange={(e) => set({ format: (e.target as HTMLSelectElement).value as SourceConfig['format'] })}>
                  {FORMAT_IDS.map((id) => (
                    <option value={id}>{formatLabel(id)}</option>
                  ))}
                </select>
              </div>
              <div class="field-row">
                <label>{t('ds.name')}</label>
                <input class="input" value={cfg.name} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="field-row">
                <label>{t('ds.maxFiles')}</label>
                <input class="input" type="number" min={1} value={cfg.maxFiles || ''} placeholder="1000" onInput={(e) => set({ maxFiles: Number((e.target as HTMLInputElement).value) || 0 })} />
              </div>
            </div>
            <span class="hint">
              {t('ds.listingHint')}
            </span>
            {usesS3 && (
              <div style="margin-top:8px">
                <h4 style="margin:8px 0 6px;font-size:13px">{t('ds.s3.title')}</h4>
                <div class="grid2">
                  <div class="field-row">
                    <label>{t('ds.s3.region')}</label>
                    <input class="input" value={cfg.s3.region} onInput={(e) => setS3({ region: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="field-row">
                    <label>{t('ds.s3.endpoint')}</label>
                    <input class="input" value={cfg.s3.endpoint} onInput={(e) => setS3({ endpoint: (e.target as HTMLInputElement).value })} placeholder="s3.ap-northeast-1.amazonaws.com" />
                  </div>
                  <div class="field-row">
                    <label>{t('ds.s3.urlStyle')}</label>
                    <select class="input" value={cfg.s3.urlStyle} onChange={(e) => setS3({ urlStyle: (e.target as HTMLSelectElement).value as 'vhost' | 'path' })}>
                      <option value="vhost">{t('ds.s3.vhost')}</option>
                      <option value="path">{t('ds.s3.path')}</option>
                    </select>
                  </div>
                  <div class="field-row">
                    <label>{t('ds.s3.auth')}</label>
                    <select class="input" value={cfg.authMode} onChange={(e) => set({ authMode: (e.target as HTMLSelectElement).value as AuthMode })}>
                      <option value="oidc">{t('ds.auth.oidc')}</option>
                      <option value="static">{t('ds.auth.static')}</option>
                      <option value="none">{t('ds.auth.none')}</option>
                    </select>
                  </div>
                </div>

                {cfg.authMode === 'static' && (
                  <>
                    <h4 style="margin:12px 0 6px;font-size:13px">{t('ds.key.title')}</h4>
                    <div class="alert info">{t('ds.key.warn')}</div>
                    <div class="grid2">
                      <div class="field-row">
                        <label>{t('ds.key.id')}</label>
                        <input class="input" value={cfg.s3.accessKeyId} onInput={(e) => setS3({ accessKeyId: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.key.secret')}</label>
                        <input class="input" type="password" value={cfg.s3.secretAccessKey} onInput={(e) => setS3({ secretAccessKey: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.key.token')}</label>
                        <input class="input" type="password" value={cfg.s3.sessionToken} onInput={(e) => setS3({ sessionToken: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                    </div>
                  </>
                )}

                {cfg.authMode === 'oidc' && (
                  <>
                    <h4 style="margin:12px 0 6px;font-size:13px">{t('ds.oidc.title')}</h4>
                    <p class="hint" style="margin-top:0">
                      {tx('ds.oidc.intro', { api: <code>AssumeRoleWithWebIdentity</code>, url: <code>{redirectUrl()}</code> })}
                    </p>
                    <div class="grid2">
                      <div class="field-row">
                        <label>{t('ds.oidc.authUrl')}</label>
                        <input class="input" value={cfg.oidc.authUrl} onInput={(e) => setOidc({ authUrl: (e.target as HTMLInputElement).value })} placeholder="https://accounts.google.com/o/oauth2/v2/auth" />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.oidc.clientId')}</label>
                        <input class="input" value={cfg.oidc.clientId} onInput={(e) => setOidc({ clientId: (e.target as HTMLInputElement).value })} autocomplete="off" />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.oidc.scope')}</label>
                        <input class="input" value={cfg.oidc.scope} onInput={(e) => setOidc({ scope: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.oidc.extra')}</label>
                        <input class="input" value={cfg.oidc.extraParams} onInput={(e) => setOidc({ extraParams: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.oidc.roleArn')}</label>
                        <input class="input" value={cfg.oidc.roleArn} onInput={(e) => setOidc({ roleArn: (e.target as HTMLInputElement).value })} placeholder="arn:aws:iam::123456789012:role/duckdive-readonly" />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.oidc.duration')}</label>
                        <input class="input" type="number" value={cfg.oidc.durationSeconds} onInput={(e) => setOidc({ durationSeconds: Number((e.target as HTMLInputElement).value) || 3600 })} />
                      </div>
                      <div class="field-row">
                        <label>{t('ds.oidc.stsEndpoint')}</label>
                        <input class="input" value={cfg.oidc.stsEndpoint} onInput={(e) => setOidc({ stsEndpoint: (e.target as HTMLInputElement).value })} placeholder={`https://sts.${cfg.s3.region || 'ap-northeast-1'}.amazonaws.com/`} />
                      </div>
                    </div>
                    <div class="row" style="margin-top:8px">
                      <button class="btn" disabled={authBusy || !isExtension} onClick={doSignIn}>
                        {authBusy ? t('ds.oidc.signingIn') : t('ds.oidc.signIn')}
                      </button>
                      {props.creds ? (
                        <span class="hint">
                          {t('ds.oidc.signedIn', { as: props.creds.subject ? t('ds.oidc.as', { subject: props.creds.subject }) : '', min: expiresIn })}
                          <button
                            class="btn ghost small"
                            onClick={async () => {
                              await storeCredentials(null);
                              props.onCreds(null);
                            }}
                          >
                            {t('ds.oidc.signOut')}
                          </button>
                        </span>
                      ) : (
                        <span class="hint">{t('ds.oidc.notSignedIn', { ext: isExtension ? '' : t('ds.oidc.extOnly') })}</span>
                      )}
                    </div>
                    {authError && <div class="alert error" style="margin-top:8px">{authError}</div>}
                  </>
                )}
              </div>
            )}
            {isExtension && origins.length > 0 && (
              <div class={'alert ' + (needPerm ? 'info' : 'ok')} style="margin-top:8px">
                {needPerm ? t('ds.perm.ask') : t('ds.perm.granted')}
                {origins.join(', ')}
              </div>
            )}
          </>
        )}

        {cfg.kind === 'local' && (
          <div class="field-row">
            <label>{t('ds.local.files')}</label>
            <input type="file" multiple accept=".parquet,.csv,.tsv,.json,.jsonl,.ndjson,.gz" onChange={(e) => setFiles(Array.from((e.target as HTMLInputElement).files ?? []))} />
            <div class="row" style="margin-top:6px">
              <label class="hint">{t('common.format')}</label>
              <select class="input" style="width:260px" value={cfg.format} onChange={(e) => set({ format: (e.target as HTMLSelectElement).value as SourceConfig['format'] })}>
                {FORMAT_IDS.map((id) => (
                  <option value={id}>{formatLabel(id)}</option>
                ))}
              </select>
            </div>
            <span class="hint">{t('ds.local.hint')}</span>
          </div>
        )}

        {cfg.kind === 'demo' && <div class="alert info">{t('ds.demo.hint')}</div>}

        {props.error && <div class="alert error">{props.error}</div>}
        <div class="row end" style="margin-top:8px;gap:10px;align-items:center">
          {props.busy && props.progress && (
            <span class="hint connect-progress" style="margin-right:auto">
              {props.progress.message}
            </span>
          )}
          {props.busy && props.progress && props.progress.phase !== 'db' && (
            <button class="btn" onClick={props.onCancel}>
              {t('common.cancel')}
            </button>
          )}
          <button class="btn primary" disabled={props.busy || (!!vars && missing.length > 0)} onClick={() => props.onConnect(cfg, files)}>
            {connectLabel}
          </button>
        </div>
      </div>

      {props.attached && (
        <div class="card">
          <h2>{t('ds.connected.title')}</h2>
          <div class="alert ok">
            {props.attached.description}
            {props.attached.rowCount !== null ? t('ds.connected.rows', { n: props.attached.rowCount.toLocaleString() }) : t('ds.connected.rowsPerRange')}{t('ds.connected.fields', { n: props.attached.fields.length })}
          </div>
          <div class="field-row" style="max-width:420px">
            <label>{t('ds.timeField.label')}</label>
            <select class="input" value={props.attached.timeField?.name ?? ''} onChange={(e) => props.onTimeField((e.target as HTMLSelectElement).value || null)}>
              <option value="">{t('ds.timeField.none')}</option>
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
              {props.attached.rangeDependent ? t('ds.connected.rangeDependent') : ''}
              {props.attached.captures.length > 0 ? t('ds.connected.captures', { names: props.attached.captures.join(', ') }) : ''}
            </div>
          )}
          {props.attached.warning && (
            <div class="alert error" style="font-family:inherit">
              {props.attached.warning}
            </div>
          )}
          {!props.attached.warning && props.attached.totalBytes !== null && props.attached.totalBytes > 512 * 1048576 && (
            <div class="alert error" style="font-family:inherit">
              {t('ds.connected.large', { mb: (props.attached.totalBytes / 1048576).toFixed(0) })}
            </div>
          )}
          {props.attached.files.length > 0 && (
            <details>
              <summary class="hint" style="cursor:pointer">{t('ds.connected.files', { n: props.attached.files.length })}</summary>
              <div class="sql-box" style="max-height:240px">{props.attached.files.slice(0, 500).join('\n')}{props.attached.files.length > 500 ? '\n…' : ''}</div>
            </details>
          )}
          <details>
            <summary class="hint" style="cursor:pointer">{t('ds.connected.fieldsTitle')}</summary>
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
      {props.history.length > 0 && (
        <div class="card source-history">
          <h2>{t('ds.history.title')}</h2>
          <p class="hint" style="margin-top:-6px">{t('ds.history.hint', { n: SOURCE_HISTORY_MAX })}</p>
          <table class="kv">
            <tbody>
              {props.history.map((h) => {
                const current = !!props.attached && sourceKey(props.config) === h.key;
                return (
                  <tr class={current ? 'current' : ''} data-key={h.key}>
                    <td class="k" style="white-space:nowrap">
                      <b>{h.config.name || h.config.kind}</b>
                      {current ? <span class="hint"> · {t('ds.history.current')}</span> : ''}
                    </td>
                    <td class="v mono" style="word-break:break-all">
                      {h.config.kind === 'demo' ? t('ds.kind.demo.sub') : h.config.urls.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).slice(0, 2).join(' · ')}
                      {h.lastUsed ? <span class="hint" style="font-family:inherit"> · {t('ds.history.lastUsed', { time: formatDate(new Date(h.lastUsed)) })}</span> : ''}
                    </td>
                    <td class="a" style="visibility:visible;white-space:nowrap">
                      <button class="btn small primary" style="visibility:visible;width:auto;height:auto;padding:2px 8px" disabled={props.busy || current} onClick={() => props.onUseHistory(h.config)}>
                        {t('ds.history.use')}
                      </button>{' '}
                      <button class="btn small" style="visibility:visible;width:auto;height:auto;padding:2px 8px" onClick={() => props.onForgetHistory(h.key)}>
                        {t('common.remove')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {isExtension && granted.length > 0 && (
        <div class="card">
          <h2>{t('ds.hosts.title')}</h2>
          <p class="hint" style="margin-top:-6px">{t('ds.hosts.hint')}</p>
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
                        {t('ds.hosts.revoke')}
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
