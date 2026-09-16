import { formatDate } from '../../datefmt';
import { t } from '../../i18n';
import { SOURCE_HISTORY_MAX, type SourceConfig, type SourceHistoryEntry } from '../../state';

const actionStyle = 'visibility:visible;width:auto;height:auto;padding:2px 8px';

/** Recently connected sources with Connect / Remove. */
export function HistoryCard(props: { history: SourceHistoryEntry[]; currentKey: string | null; busy: boolean; onUse: (cfg: SourceConfig) => void; onForget: (key: string) => void }) {
  return (
    <div class="card source-history">
      <h2>{t('ds.history.title')}</h2>
      <p class="hint" style="margin-top:-6px">{t('ds.history.hint', { n: SOURCE_HISTORY_MAX })}</p>
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
              <tr class={current ? 'current' : ''} data-key={h.key}>
                <td class="k" style="white-space:nowrap">
                  <b>{h.config.name || h.config.kind}</b>
                  {current ? <span class="hint"> · {t('ds.history.current')}</span> : ''}
                </td>
                <td class="v mono" style="word-break:break-all">
                  {h.config.kind === 'demo' ? t('ds.kind.demo.sub') : lines}
                  {h.lastUsed ? <span class="hint" style="font-family:inherit"> · {t('ds.history.lastUsed', { time: formatDate(new Date(h.lastUsed)) })}</span> : ''}
                </td>
                <td class="a" style="visibility:visible;white-space:nowrap">
                  <button class="btn small primary" style={actionStyle} disabled={props.busy || current} onClick={() => props.onUse(h.config)}>
                    {t('ds.history.use')}
                  </button>{' '}
                  <button class="btn small" style={actionStyle} onClick={() => props.onForget(h.key)}>
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
