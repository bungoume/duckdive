import type { AttachedSource } from '../../datasource';
import { isTimeCandidate } from '../../fields';
import { t } from '../../i18n';
import { FormField } from '../ui';

const LARGE_MB = 512;

/** What the current connection looks like: description, time field choice, file list, fields. */
export function ConnectedCard(props: { attached: AttachedSource; onTimeField: (name: string | null) => void }) {
  const a = props.attached;
  return (
    <div class="card">
      <h2>{t('ds.connected.title')}</h2>
      <div class="alert ok">
        {a.description}
        {a.rowCount !== null ? t('ds.connected.rows', { n: a.rowCount.toLocaleString() }) : t('ds.connected.rowsPerRange')}
        {t('ds.connected.fields', { n: a.fields.length })}
      </div>
      <FormField label={t('ds.timeField.label')} style="max-width:420px">
        <select class="input" value={a.timeField?.name ?? ''} onChange={(e) => props.onTimeField(e.currentTarget.value || null)}>
          <option value="">{t('ds.timeField.none')}</option>
          {a.fields
            .filter((f) => f.kind === 'date' || isTimeCandidate(f))
            .map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} ({f.duckType})
              </option>
            ))}
        </select>
      </FormField>
      {(a.rangeDependent || a.captures.length > 0) && (
        <div class="alert info">
          {a.rangeDependent ? t('ds.connected.rangeDependent') : ''}
          {a.captures.length > 0 ? t('ds.connected.captures', { names: a.captures.join(', ') }) : ''}
        </div>
      )}
      {a.warning && (
        <div class="alert error" style="font-family:inherit">
          {a.warning}
        </div>
      )}
      {!a.warning && a.totalBytes !== null && a.totalBytes > LARGE_MB * 1048576 && (
        <div class="alert error" style="font-family:inherit">
          {t('ds.connected.large', { mb: (a.totalBytes / 1048576).toFixed(0) })}
        </div>
      )}
      {a.files.length > 0 && (
        <details>
          <summary class="hint" style="cursor:pointer">
            {t('ds.connected.files', { n: a.files.length })}
          </summary>
          <div class="sql-box" style="max-height:240px">
            {a.files.slice(0, 500).join('\n')}
            {a.files.length > 500 ? '\n…' : ''}
          </div>
        </details>
      )}
      <details>
        <summary class="hint" style="cursor:pointer">
          {t('ds.connected.fieldsTitle')}
        </summary>
        <table class="kv" style="margin-top:6px">
          <tbody>
            {a.fields.map((f) => (
              <tr key={f.name}>
                <td class="k">{f.name}</td>
                <td class="v">{f.duckType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
