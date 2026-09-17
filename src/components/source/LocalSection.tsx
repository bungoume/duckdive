import { useEffect, useState } from 'preact/hooks';
import { expose } from '../../debug';
import { describeError } from '../../errors';
import { FORMAT_IDS, formatLabel } from '../../formats';
import { t } from '../../i18n';
import { NO_LOCAL, dropped, fsAccessAvailable, pickFiles, pickFolder, selectionNames, selectionOf, type LocalSelection } from '../../localfiles';
import type { SourceConfig } from '../../sources';

const ACCEPT = '.parquet,.csv,.tsv,.json,.jsonl,.ndjson,.log,.txt,.ltsv,.gz,.zst';

/** The "Local files" part of the Data source page: a drop zone, the pickers and what was picked. */
export function LocalSection(props: { cfg: SourceConfig; selection: LocalSelection; onSelect: (s: LocalSelection) => void; onChange: (p: Partial<SourceConfig>) => void }) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Take a selection from a picker or a drop; a folder without log files is reported, a dismissed picker ignored. */
  const take = async (get: () => Promise<LocalSelection>) => {
    setError(null);
    try {
      const s = await get();
      if (s.files.length) props.onSelect(s);
      else if (s.handles.length) setError(t('src.local.emptyFolder'));
    } catch (e) {
      setError(describeError(e));
    }
  };

  // e2e builds: let the tests hand in handles (OPFS files), since the pickers cannot be driven
  useEffect(() => {
    expose({ setLocalHandles: (handles: FileSystemHandle[]) => take(() => selectionOf(handles)) });
  });

  const names = selectionNames(props.selection);
  const shown = (list: string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? ' …' : '');
  const remembered = !names.length && props.cfg.localId ? props.cfg.urls.split('\n').filter(Boolean) : [];

  return (
    <div>
      <div
        class={'dropzone' + (over ? ' over' : '')}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dt = e.dataTransfer;
          if (dt) void take(() => dropped(dt));
        }}
      >
        <span>{t('ds.local.drop')}</span>
        {fsAccessAvailable ? (
          <span class="row">
            <button class="btn small" onClick={() => void take(async () => selectionOf(await pickFiles()))}>
              {t('ds.local.chooseFiles')}
            </button>
            <button class="btn small" onClick={() => void take(async () => selectionOf(await pickFolder()))}>
              {t('ds.local.chooseFolder')}
            </button>
          </span>
        ) : (
          <input type="file" multiple accept={ACCEPT} onChange={(e) => props.onSelect({ files: Array.from(e.currentTarget.files ?? []), handles: [] })} />
        )}
      </div>
      {names.length > 0 && (
        <div class="alert ok local-selected">
          {t('ds.local.selected', { n: props.selection.files.length, names: shown(names) })}{' '}
          <button class="btn small" onClick={() => props.onSelect(NO_LOCAL)}>
            {t('ds.local.clear')}
          </button>
        </div>
      )}
      {remembered.length > 0 && <div class="alert info">{t('ds.local.remembered', { names: shown(remembered) })}</div>}
      {error && <div class="alert error">{error}</div>}
      <label class="row hint mt6">
        {t('common.format')}
        <select class="input" style="width:260px" value={props.cfg.format} onChange={(e) => props.onChange({ format: e.currentTarget.value as SourceConfig['format'] })}>
          {FORMAT_IDS.map((id) => (
            <option key={id} value={id}>
              {formatLabel(id)}
            </option>
          ))}
        </select>
      </label>
      <span class="hint">{t('ds.local.hint')}</span>
    </div>
  );
}
