/** Connection state and effects, independent of component rendering. */
import { getCredentials, type AwsCredentials } from './auth';
import { attachSource, capturedColumns, discoverVariables, requiredOrigins, unselectedTokens, type AttachedSource, type LargeSourceInfo, type TimeWindow, type ValueFilters } from './datasource';
import { expose } from './debug';
import { setDiagnoseContext } from './diagnose';
import { describeError } from './errors';
import { cancelAllQueries } from './duck';
import { findField } from './fields';
import { t } from './i18n';
import { NO_LOCAL, forgetHandles, openLocal, storeHandles, type LocalSelection } from './localfiles';
import { CancelledError } from './net';
import { ensureHostPermissions } from './permissions';
import type { TokenValue } from './s3list';
import { forgetSecrets, storeSecrets, withSecrets } from './secrets';
import { forgetSource, loadSourceHistory, rememberSource, saveSource, type SourceConfig, type SourceHistoryEntry } from './sources';
import { newId } from './sql';
import type { UrlState } from './state';
import { createStore } from './store';

/** What the running connect is doing; `phase` decides whether Cancel is offered. */
export interface AttachProgress {
  message: string;
  phase: 'auth' | 'list' | 'db';
}

/** Values found for the {name} tokens of the pattern being configured (Data source page). */
export interface Variables {
  pattern: string;
  values: Record<string, TokenValue[]>;
  listedFiles: number;
}

/** A large source waiting for the user's go-ahead before DuckDB is touched. */
export interface LargeConfirm {
  info: LargeSourceInfo;
  resolve: (ok: boolean) => void;
}

export type ConnectionPhase =
  | { status: 'idle' }
  | { status: 'connecting'; progress: AttachProgress | null }
  | { status: 'confirming'; progress: AttachProgress | null; confirmation: LargeConfirm }
  | { status: 'failed'; error: string };

export interface ConnectionState {
  source: SourceConfig;
  pendingSource: SourceConfig | null;
  history: SourceHistoryEntry[];
  switchSeq: number;
  attached: AttachedSource | null;
  phase: ConnectionPhase;
  variables: Variables | null;
  creds: AwsCredentials | null;
}

export interface ConnectRequest {
  window: TimeWindow | null;
  valueFilters: ValueFilters;
  local?: LocalSelection;
  interactive?: boolean;
}

/** Active "is" / "is one of" filters on columns captured from file names → file pruning. */
export function valueFiltersFor(cfg: SourceConfig, url: UrlState): ValueFilters {
  const names = capturedColumns(cfg);
  const out: ValueFilters = {};
  if (!names.length) return out;
  for (const f of url.search.filters) {
    if (f.disabled || f.negate || !names.includes(f.field)) continue;
    const vals = f.op === 'is' && f.value !== undefined ? [f.value] : f.op === 'is_one_of' ? (f.values ?? []) : null;
    if (!vals || !vals.length) continue;
    out[f.field] = out[f.field] ? out[f.field].filter((v) => vals.includes(v)) : vals;
  }
  return out;
}

export function createConnection(initialSource: SourceConfig, onSourcePage: () => void, queryBusy: () => boolean) {
  const store = createStore<ConnectionState>({
    source: initialSource,
    pendingSource: null,
    history: loadSourceHistory(),
    switchSeq: 0,
    attached: null,
    phase: { status: 'idle' },
    variables: null,
    creds: null,
  });
  const update = (patch: Partial<ConnectionState>) => store.set({ ...store.get(), ...patch });
  const generation = { current: 0 };
  const ackedFiles = { current: '' };
  let controller: AbortController | null = null;
  let pendingConfirmation: ((ok: boolean) => void) | null = null;

  const setCreds = (creds: AwsCredentials | null) => update({ creds });
  const restore = (source: SourceConfig) => update({ source, switchSeq: store.get().switchSeq + 1 });

  const begin = () => {
    pendingConfirmation?.(false);
    controller?.abort();
    return ++generation.current;
  };

  const run = async (cfg: SourceConfig, request: ConnectRequest, attempt: number): Promise<AttachedSource | null> => {
    const ctl = new AbortController();
    controller = ctl;
    const stale = () => generation.current !== attempt;
    const { window, valueFilters, local = NO_LOCAL, interactive = true } = request;
    const report = (message: string, phase: AttachProgress['phase']) => {
      if (stale()) throw new CancelledError();
      const note = phase === 'db' ? (queryBusy() ? t('app.note.queued') : t('app.note.inDb')) : '';
      update({
        ...(phase === 'db' ? { attached: null } : {}),
        phase: { status: 'connecting', progress: { message: message + note, phase } },
      });
    };
    update({ phase: { status: 'connecting', progress: null }, variables: null });
    let confirmedLarge = false;
    const confirmLarge = (info: LargeSourceInfo) =>
      new Promise<boolean>((resolve) => {
        if (stale()) return resolve(false);
        const previous = store.get().phase;
        const finish = (ok: boolean) => {
          if (pendingConfirmation !== finish) return;
          pendingConfirmation = null;
          confirmedLarge = ok;
          if (!stale()) update({ phase: { status: 'connecting', progress: null } });
          resolve(ok);
        };
        pendingConfirmation = finish;
        update({
          phase: {
            status: 'confirming',
            progress: previous.status === 'connecting' ? previous.progress : null,
            confirmation: { info, resolve: finish },
          },
        });
      });
    try {
      if (cfg.kind === 'url' && !window) throw new Error(t('tp.invalid'));
      // A remembered local source: its files come from the stored handles (the browser may ask for permission).
      let sel = local;
      if (cfg.kind === 'local' && !sel.files.length && cfg.localId) {
        report(t('app.progress.openingLocal'), 'list');
        const opened = await openLocal(cfg.localId, interactive);
        if (stale()) return null;
        if (!opened) {
          onSourcePage();
          return null;
        }
        sel = opened;
      }
      if (cfg.kind === 'url') {
        const perm = await ensureHostPermissions(requiredOrigins(cfg));
        if (stale()) return null;
        if (!perm.ok) throw new Error(t('app.error.hostPermission', { origins: perm.missing.join(', ') }));
      }
      if (cfg.kind === 'url' && cfg.authMode === 'oidc') report(interactive ? t('app.progress.signingIn') : t('app.progress.refreshingCreds'), 'auth');
      const c = cfg.kind === 'url' && cfg.authMode === 'oidc' ? await getCredentials(cfg.oidc, interactive, 300, () => !stale()) : null;
      if (stale()) return null;
      // Patterns with {name} tokens: list the values first and let the user choose before any file is read.
      if (cfg.kind === 'url' && unselectedTokens(cfg).length) {
        report(t('app.progress.listingVars'), 'list');
        const found = await discoverVariables(cfg, c, window, { signal: ctl.signal, onProgress: report });
        if (stale()) return null;
        update({ variables: { pattern: cfg.urls, ...found } });
        onSourcePage();
        return null;
      }
      // Whatever is still running belongs to the previous file set: stop it so the new view
      // is not queued behind it.
      report(t('app.progress.stopping'), 'list');
      await cancelAllQueries();
      if (stale()) return null;
      const a = await attachSource(cfg, sel.files, c, window, valueFilters, { signal: ctl.signal, onProgress: report, confirmLarge });
      if (stale()) return null;
      // The user already accepted this file set: do not ask again at query time.
      if (confirmedLarge) ackedFiles.current = a.files.join('\n');
      const saved: SourceConfig = { ...cfg, timeField: a.timeField ? { mode: 'field', name: a.timeField.name } : cfg.timeField.mode === 'none' ? { mode: 'none' } : { mode: 'auto' } };
      if (cfg.kind === 'local' && sel.handles.length) {
        // picked with handles: keep them so the source can be reopened from the history
        saved.localId = cfg.localId ?? newId();
        await storeHandles(saved.localId, sel.handles);
      }
      if (stale()) return null;
      expose({ attached: a });
      setDiagnoseContext(cfg.kind === 'url' ? { files: a.files, fileSizes: a.fileSizes, format: cfg.format } : null);

      saveSource(saved);
      void storeSecrets(saved);
      update({ source: saved, attached: a, pendingSource: null, creds: c, history: rememberSource(saved) });
      return a;
    } catch (e) {
      if (stale()) return null;
      update({ phase: { status: 'failed', error: e instanceof CancelledError ? t('app.error.cancelled') : describeError(e) } });
      return null;
    } finally {
      if (!stale()) {
        pendingConfirmation?.(false);
        if (store.get().phase.status !== 'failed') update({ phase: { status: 'idle' } });
      }
    }
  };

  const connect = (cfg: SourceConfig, request: ConnectRequest) => run(cfg, request, begin());

  const select = async (entry: SourceConfig, request: ConnectRequest) => {
    // Loading secrets is also part of this selection: a slower load must not replace a newer choice.
    const selection = begin();
    update({ pendingSource: entry, switchSeq: store.get().switchSeq + 1, phase: { status: 'connecting', progress: null } });
    try {
      const cfg = await withSecrets(entry);
      if (generation.current !== selection) return null;
      update({ pendingSource: cfg });
      return await run(cfg, request, selection);
    } catch (error) {
      if (generation.current === selection) update({ phase: { status: 'failed', error: describeError(error) } });
      return null;
    }
  };

  const forget = (key: string) => {
    const localId = store.get().history.find((h) => h.key === key)?.config.localId;
    if (localId) void forgetHandles(localId);
    update({ history: forgetSource(key) });
    void forgetSecrets(key);
  };

  const cancel = () => {
    const { phase } = store.get();
    if ((phase.status !== 'connecting' && phase.status !== 'confirming') || phase.progress?.phase === 'db') return;
    pendingConfirmation?.(false);
    generation.current++;
    controller?.abort();
    update({ phase: { status: 'failed', error: t('app.error.cancelled') } });
  };

  const onTimeField = (name: string | null) => {
    const { attached, source } = store.get();
    if (!attached) return;
    const field = name ? (findField(attached.fields, name) ?? null) : null;
    const config: SourceConfig = { ...source, timeField: field ? { mode: 'field', name: field.name } : { mode: 'none' } };
    saveSource(config);
    update({ source: config, attached: { ...attached, timeField: field }, history: rememberSource(config) });
  };

  const dispose = () => {
    pendingConfirmation?.(false);
    generation.current++;
    controller?.abort();
  };

  return { ...store, connect, select, cancel, dispose, restore, forget, onTimeField, setCreds, generation, ackedFiles };
}
