import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AwsCredentials, OidcConfig } from '../auth';
import { capturedColumns, requiredOrigins, unselectedTokens, type AttachedSource } from '../datasource';
import { FORMAT_IDS, TEMPLATES, formatLabel, templateLabel, templateNote } from '../formats';
import { t, tx } from '../i18n';
import type { AttachProgress, Variables } from '../hooks/useConnect';
import { hasHostPermissions, isExtension } from '../permissions';
import { sourceKey, type SourceConfig, type SourceHistoryEntry } from '../sources';
import { CachePanel } from './CachePanel';
import { ConnectedCard } from './source/ConnectedCard';
import { HistoryCard } from './source/HistoryCard';
import { HostsCard } from './source/HostsCard';
import { S3Section } from './source/S3Section';
import { TokenValues } from './source/TokenValues';
import { FormField } from './ui';

/** The Data source page. The form starts from `config`; the parent remounts it (by key) when a remembered source is loaded. */
export function DataSource(props: {
  config: SourceConfig;
  history: SourceHistoryEntry[];
  attached: AttachedSource | null;
  error: string | null;
  busy: boolean;
  /** what the running connect is doing (null when idle or while DuckDB is still starting) */
  progress: AttachProgress | null;
  creds: AwsCredentials | null;
  /** values listed for the {name} tokens of `pattern` (by pressing Connect) */
  variables: Variables | null;
  onConnect: (cfg: SourceConfig, files: File[]) => void;
  onCancel: () => void;
  onTimeField: (name: string | null) => void;
  onCreds: (c: AwsCredentials | null) => void;
  onUseHistory: (cfg: SourceConfig) => void;
  onForgetHistory: (key: string) => void;
}) {
  const [cfg, setCfg] = useState<SourceConfig>(props.config);
  const [files, setFiles] = useState<File[]>([]);
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
  const origins = useMemo(() => (cfg.kind === 'url' ? requiredOrigins(cfg) : []), [cfg]);

  // re-checked after a connect, which may have asked for the permission
  useEffect(() => {
    void hasHostPermissions(origins).then((ok) => setNeedPerm(!ok));
  }, [origins, props.attached]);

  return (
    <div class="source-page">
      <div class="card">
        <h2>{t('ds.title')}</h2>
        <p class="hint" style="margin-top:-6px">
          {t('ds.intro')}
        </p>
        <div class="kinds">
          <button class={cfg.kind === 'url' ? 'active' : ''} aria-pressed={cfg.kind === 'url'} onClick={() => set({ kind: 'url' })}>
            <b>{t('ds.kind.url')}</b>
            <span>{t('ds.kind.url.sub')}</span>
          </button>
          <button class={cfg.kind === 'local' ? 'active' : ''} aria-pressed={cfg.kind === 'local'} onClick={() => set({ kind: 'local' })}>
            <b>{t('ds.kind.local')}</b>
            <span>{t('ds.kind.local.sub')}</span>
          </button>
          <button class={cfg.kind === 'demo' ? 'active' : ''} aria-pressed={cfg.kind === 'demo'} onClick={() => set({ kind: 'demo' })}>
            <b>{t('ds.kind.demo')}</b>
            <span>{t('ds.kind.demo.sub')}</span>
          </button>
        </div>

        {cfg.kind === 'url' && (
          <>
            <div class="template-box">
              <div class="row" style="gap:10px;align-items:center">
                <span class="template-title">{t('ds.template')}</span>
                <select class="input" style="max-width:320px" value={pendingTemplate?.id ?? templateId} onChange={(e) => chooseTemplate(e.currentTarget.value)}>
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
              {!pendingTemplate && templateId && TEMPLATES.find((x) => x.id === templateId) && (
                <div class="hint" style="margin-top:6px">
                  {templateNote(TEMPLATES.find((x) => x.id === templateId)!)}
                </div>
              )}
            </div>
            <FormField label={t('ds.urls.label')}>
              <textarea
                class="input"
                value={cfg.urls}
                onInput={(e) => set({ urls: e.currentTarget.value, timeField: null, tokenValues: {} })}
                placeholder={
                  's3://my-logs/AWSLogs/123456789012/elasticloadbalancing/ap-northeast-1/{yyyy}/{MM}/{dd}/*.log.gz\ns3://my-bucket/events/dt={yyyy}-{MM}-{dd}/*.parquet\nhttps://d1234.cloudfront.net/logs/2026-09-09.parquet'
                }
              />
              <span class="hint">
                {tx('ds.urls.hint', {
                  star: <code>*</code>,
                  q: <code>?</code>,
                  dstar: <code>**</code>,
                  dates: <code>{'{yyyy} {MM} {dd} {HH}'}</code>,
                  name: <code>{'{name}'}</code>,
                  example: <code>{'app.{alb}.*.log.gz'}</code>,
                  alb: <code>alb</code>,
                })}
              </span>
            </FormField>
            {tokens.length > 0 && (
              <TokenValues
                tokens={tokens}
                vars={vars}
                selected={cfg.tokenValues ?? {}}
                missing={missing}
                onSelect={setTokenValues}
                onSelectAll={() => set({ tokenValues: Object.fromEntries(tokens.map((n) => [n, (vars?.values[n] ?? []).map((v) => v.value)])) })}
              />
            )}
            <div class="grid2">
              <FormField label={t('common.format')}>
                <select class="input" value={cfg.format} onChange={(e) => set({ format: e.currentTarget.value as SourceConfig['format'] })}>
                  {FORMAT_IDS.map((id) => (
                    <option value={id}>{formatLabel(id)}</option>
                  ))}
                </select>
              </FormField>
              <FormField label={t('ds.name')}>
                <input class="input" value={cfg.name} onInput={(e) => set({ name: e.currentTarget.value })} />
              </FormField>
              <FormField label={t('ds.maxFiles')}>
                <input class="input" type="number" min={1} value={cfg.maxFiles || ''} placeholder="1000" onInput={(e) => set({ maxFiles: Number(e.currentTarget.value) || 0 })} />
              </FormField>
            </div>
            <span class="hint">{t('ds.listingHint')}</span>
            {usesS3 && <S3Section cfg={cfg} creds={props.creds} onChange={set} onS3={setS3} onOidc={setOidc} onCreds={props.onCreds} />}
            {isExtension && origins.length > 0 && (
              <div class={'alert ' + (needPerm ? 'info' : 'ok')} style="margin-top:8px">
                {needPerm ? t('ds.perm.ask') : t('ds.perm.granted')}
                {origins.join(', ')}
              </div>
            )}
          </>
        )}

        {cfg.kind === 'local' && (
          <FormField label={t('ds.local.files')}>
            <input type="file" multiple accept=".parquet,.csv,.tsv,.json,.jsonl,.ndjson,.gz" onChange={(e) => setFiles(Array.from(e.currentTarget.files ?? []))} />
            <label class="row hint" style="margin-top:6px">
              {t('common.format')}
              <select class="input" style="width:260px" value={cfg.format} onChange={(e) => set({ format: e.currentTarget.value as SourceConfig['format'] })}>
                {FORMAT_IDS.map((id) => (
                  <option value={id}>{formatLabel(id)}</option>
                ))}
              </select>
            </label>
            <span class="hint">{t('ds.local.hint')}</span>
          </FormField>
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
          <button class="btn primary connect" disabled={props.busy || (!!vars && missing.length > 0)} onClick={() => props.onConnect(cfg, files)}>
            {connectLabel}
          </button>
        </div>
      </div>

      {props.attached && <ConnectedCard attached={props.attached} onTimeField={props.onTimeField} />}
      {props.history.length > 0 && (
        <HistoryCard history={props.history} currentKey={props.attached ? sourceKey(props.config) : null} busy={props.busy} onUse={props.onUseHistory} onForget={props.onForgetHistory} />
      )}
      <HostsCard refreshKey={props.attached} />
      <CachePanel />
    </div>
  );
}
