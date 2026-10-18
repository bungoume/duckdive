import { useMemo } from 'preact/hooks';
import { buildTrailAnalysisQuery, trailLogsFilter, type CloudTrailTemplate } from '../cloudTrailAnalysis';
import { t } from '../i18n';
import { AnalysisPanel, type AnalysisPanelProps } from './AnalysisPanel';

export function CloudTrailAnalysisPanel(props: AnalysisPanelProps & { template: CloudTrailTemplate }) {
  const { template, compiled } = props;
  const plan = useMemo(() => buildTrailAnalysisQuery(template, compiled), [template, compiled]);
  return (
    <AnalysisPanel {...props} plan={plan} title={t('analysis.cloudtrail.title')}>
      {(data, explore) => (
        <>
          <div class="analysis-metrics">
            <div class="analysis-metric" data-metric="errors">
              <div class="hint">{t('analysis.cloudtrail.errorRate')}</div>
              <strong class="analysis-value">{data.errorRate === null ? '—' : `${data.errorRate.toFixed(2)}%`}</strong>
              <div class="hint">
                {t('analysis.cloudtrail.errorCount', {
                  errors: data.errors.toLocaleString(),
                  total: data.calls.toLocaleString(),
                })}
              </div>
              <button
                class="btn small"
                disabled={!data.errors}
                onClick={() => explore(trailLogsFilter(template, t('analysis.cloudtrail.errorLogs'), { errors: true }))}
              >
                {t('analysis.cloudtrail.errorLogs')}
              </button>
            </div>
            <div class="analysis-metric" data-metric="important">
              <div class="hint">{t('analysis.cloudtrail.important')}</div>
              <strong class="analysis-value">{data.important.toLocaleString()}</strong>
              <div class="hint">{t('analysis.cloudtrail.attempts')}</div>
              <button
                class="btn small"
                disabled={!data.important}
                onClick={() =>
                  explore(trailLogsFilter(template, t('analysis.cloudtrail.importantLogs'), { important: true }))
                }
              >
                {t('analysis.cloudtrail.importantLogs')}
              </button>
            </div>
          </div>
          <p class="hint">{t('analysis.cloudtrail.scope')}</p>
          {data.excluded > 0 && (
            <p class="hint">{t('analysis.cloudtrail.excluded', { n: data.excluded.toLocaleString() })}</p>
          )}
          <div class="trail-rankings">
            {(['user', 'api', 'important'] as const).map((kind) => {
              const rows = data.groups.filter((row) => row.kind === kind);
              return (
                <section class={`trail-ranking trail-${kind}`} key={kind} data-ranking={kind}>
                  <div class="row analysis-ranking-head">
                    <b>
                      {t(`analysis.cloudtrail.${kind === 'user' ? 'users' : kind === 'api' ? 'apis' : 'important'}`)}
                    </b>
                    <span class="hint">{t('analysis.cloudtrail.top')}</span>
                  </div>
                  {rows.length === 0 ? (
                    <div class="empty">{t('analysis.cloudtrail.empty')}</div>
                  ) : (
                    <div class="analysis-table-scroll">
                      <table class="data trail-table">
                        <thead>
                          <tr>
                            <th>{t(kind === 'user' ? 'analysis.cloudtrail.user' : 'analysis.cloudtrail.api')}</th>
                            {kind === 'important' && <th>{t('analysis.cloudtrail.category')}</th>}
                            <th class="num">{t('analysis.cloudtrail.calls')}</th>
                            <th class="num">{t('analysis.cloudtrail.errors')}</th>
                            <th>{t('analysis.logs')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => {
                            const label =
                              kind === 'user'
                                ? (row.user ?? t('analysis.cloudtrail.unknown'))
                                : `${row.source ?? '—'} / ${row.name ?? '—'}`;
                            return (
                              <tr key={JSON.stringify([row.user, row.source, row.name, row.category])}>
                                <td class="mono trail-identity">{label}</td>
                                {kind === 'important' && (
                                  <td>{row.category ? t(`analysis.cloudtrail.${row.category}`) : '—'}</td>
                                )}
                                <td class="num">{row.calls.toLocaleString()}</td>
                                <td class="num">
                                  {row.errors ? (
                                    <button
                                      class="btn small ghost"
                                      aria-label={`${t('analysis.cloudtrail.errorLogs')}: ${label}`}
                                      onClick={() =>
                                        explore(
                                          trailLogsFilter(template, `${label} · ${t('analysis.cloudtrail.errors')}`, {
                                            group: row,
                                            errors: true,
                                          }),
                                        )
                                      }
                                    >
                                      {row.errors.toLocaleString()}
                                    </button>
                                  ) : (
                                    '0'
                                  )}
                                </td>
                                <td>
                                  <button
                                    class="btn small"
                                    onClick={() => explore(trailLogsFilter(template, label, { group: row }))}
                                  >
                                    {t('analysis.logs')}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <p class="hint">{t('analysis.cloudtrail.userHint')}</p>
          <p class="hint">{t('analysis.cloudtrail.importantHint')}</p>
        </>
      )}
    </AnalysisPanel>
  );
}
