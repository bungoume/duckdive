import { useState } from 'preact/hooks';
import { describeError } from '../errors';
import { EXPORT_FORMATS, downloadBlob, exportFileName, exportToBlob, type ExportFormat } from '../export';
import type { Field } from '../fields';
import { t } from '../i18n';
import { exportDocsSql } from '../queries';
import type { SortDir } from '../state';
import { FormField, Popover } from './ui';

const MAX_ROWS = 1_000_000;

/** "Export" on the Discover page: the matching rows as a CSV, JSON Lines or Parquet download. */
export function ExportMenu(props: {
  where: string;
  timeField: Field | null;
  timeExpr: string | null;
  fields: Field[];
  sort: { field: string; dir: SortDir }[];
  columns: string[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [limit, setLimit] = useState(10000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const sql = exportDocsSql(props.where, props.timeField, props.timeExpr, props.fields, props.sort, props.columns, limit);
      downloadBlob(await exportToBlob(sql, format), exportFileName(format));
      setOpen(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align="right"
      button={
        <button class="sql-toggle" onClick={() => setOpen(!open)} disabled={props.disabled}>
          {t('exp.button')}
        </button>
      }
    >
      <div class="export-menu">
        <h4>{t('exp.title')}</h4>
        <FormField label={t('common.format')}>
          <select class="input" value={format} onChange={(e) => setFormat(e.currentTarget.value as ExportFormat)}>
            {EXPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {t(`exp.format.${f}`)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={t('exp.rows')}>
          <input class="input" type="number" min={1} max={MAX_ROWS} value={limit} onInput={(e) => setLimit(Math.min(MAX_ROWS, Math.max(1, Number(e.currentTarget.value) || 1)))} />
        </FormField>
        <p class="hint">{props.columns.length ? t('exp.hint.columns') : t('exp.hint.all')}</p>
        {error && <div class="alert error">{error}</div>}
        <div class="row end">
          <button class="btn primary small" onClick={() => void run()} disabled={busy}>
            {busy ? t('exp.running') : t('exp.download')}
          </button>
        </div>
      </div>
    </Popover>
  );
}
