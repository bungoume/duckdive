import { formatDate } from '../../datefmt';
import { t } from '../../i18n';
import { SOURCE_HISTORY_MAX, type SourceConfig, type SourceHistoryEntry } from '../../sources';

/** Recently connected sources with Connect / Remove. */
export function HistoryCard(props: { history: SourceHistoryEntry[]; currentKey: string | null; busy: boolean; onUse: (cfg: SourceConfig) => void; onForget: (key: string) => void }) {
  return (
    <div class="card source-history">
      <h2>{t('ds.history.title')}</h2>
      <p class="hint">{t('ds.history.hint', { n: SOURCE_HISTORY_MAX })}</p>
      <table class="kv">
        <tbody>
          {props.history.map((h) => {
            const current = props.currentKey === h.key;
            const lines = h.config.urls
              .split(/\r?\n/)
              .filter((l) => l.trim() && !l.trim().startsWith('#'))
              .slice(0, 2)
              .join(' · ');
            return (
              <tr key={h.key} class={current ? 'current' : ''} data-key={h.key}>
                <td class="k" style="white-space:nowrap">
                  <b>{h.config.name || h.config.kind}</b>
                  {current ? <span class="hint"> · {t('ds.history.current')}</span> : ''}
                </td>
                <td class="v mono break-all">
                  {h.config.kind === 'demo' ? t('ds.kind.demo.sub') : lines}
                  {h.lastUsed ? (
                    <span class="hint" style="font-family:inherit">
                      {' '}
                      · {t('ds.history.lastUsed', { time: formatDate(new Date(h.lastUsed)) })}
                    </span>
                  ) : (
                    ''
                  )}
                </td>
                <td class="actions">
                  {!current && (
                    <button class="btn small primary" disabled={props.busy} onClick={() => props.onUse(h.config)}>
                      {t('ds.history.use')}
                    </button>
                  )}{' '}
                  <button class="btn small" onClick={() => props.onForget(h.key)}>
                    {t('common.remove')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
