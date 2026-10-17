import { useMemo } from 'preact/hooks';
import { fmtBytes } from '../cache';
import { t } from '../i18n';
import {
  buildFlowAnalysisQuery,
  flowLogsFilter,
  flowProtocolLabel,
  type FlowGroupKind,
  type VpcFlowTemplate,
} from '../vpcFlowAnalysis';
import { AnalysisPanel, type AnalysisPanelProps } from './AnalysisPanel';

export function VpcFlowAnalysisPanel(props: AnalysisPanelProps & { template: VpcFlowTemplate }) {
  const { template, compiled } = props;
  const plan = useMemo(() => buildFlowAnalysisQuery(template, compiled), [template, compiled]);
  const headings = {
    source: 'analysis.vpc.sources',
    destination: 'analysis.vpc.destinations',
    port: 'analysis.vpc.ports',
  } as const;
  const columns = {
    source: 'analysis.vpc.source',
    destination: 'analysis.vpc.destination',
    port: 'analysis.vpc.port',
  } as const;
  const bytes = (value: number | null) => (value === null ? '—' : fmtBytes(value));
  return (
    <AnalysisPanel {...props} plan={plan} title={t('analysis.vpc.title')}>
      {(data, explore) => (
        <>
          <div class="analysis-metrics">
            <div class="analysis-metric" data-metric="reject">
              <div class="hint">{t('analysis.vpc.rejectRate')}</div>
              <strong class="analysis-value">
                {data.rejectRate === null ? '—' : `${data.rejectRate.toFixed(2)}%`}
              </strong>
              <div class="hint">
                {t('analysis.vpc.rejectCount', {
                  rejected: data.rejected.toLocaleString(),
                  total: data.records.toLocaleString(),
                })}
              </div>
              <button
                class="btn small"
                disabled={!data.rejected}
                onClick={() => explore(flowLogsFilter(template, t('analysis.vpc.rejectLogs'), undefined, true))}
              >
                {t('analysis.vpc.rejectLogs')}
              </button>
            </div>
            <div class="analysis-metric" data-metric="bytes">
              <div class="hint">{t('analysis.vpc.bytes')}</div>
              <strong class="analysis-value" title={data.bytes?.toLocaleString()}>
                {bytes(data.bytes)}
              </strong>
              <div class="hint">
                {t('analysis.vpc.measured', {
                  n: data.measured.toLocaleString(),
                  missing: (data.records - data.measured).toLocaleString(),
                })}
              </div>
              <div class="hint">
                {t('analysis.vpc.packets')}: {data.packets === null ? '—' : data.packets.toLocaleString()}
              </div>
              <button
                class="btn small"
                disabled={!data.records}
                onClick={() => explore(flowLogsFilter(template, t('analysis.vpc.trafficLogs')), template.bytes.name)}
              >
                {t('analysis.vpc.trafficLogs')}
              </button>
            </div>
          </div>
          <p class="hint">{t('analysis.vpc.scope')}</p>
          {!template.logStatus && <p class="hint">{t('analysis.vpc.noStatus')}</p>}
          {data.excluded > 0 && (
            <p class="hint">
              {t('analysis.vpc.excluded', {
                n: data.excluded.toLocaleString(),
                noData: data.noData.toLocaleString(),
                skipData: data.skipData.toLocaleString(),
              })}
            </p>
          )}
          {data.skipData > 0 && <div class="alert warn">{t('analysis.vpc.incomplete')}</div>}
          <div class="flow-rankings">
            {(['source', 'destination', 'port'] as FlowGroupKind[]).map((kind) => {
              const rows = data.groups.filter((row) => row.kind === kind);
              return (
                <section class={`flow-ranking flow-${kind}`} key={kind} data-ranking={kind}>
                  <div class="row analysis-ranking-head">
                    <b>{t(headings[kind])}</b>
                    <span class="hint">{t('analysis.vpc.top')}</span>
                  </div>
                  {rows.length === 0 ? (
                    <div class="empty">{t('analysis.vpc.empty')}</div>
                  ) : (
                    <div class="analysis-table-scroll">
                      <table class="data flow-table">
                        <thead>
                          <tr>
                            <th>{t(columns[kind])}</th>
                            <th class="num">{t('analysis.vpc.bytes')}</th>
                            {kind === 'port' && <th class="num">{t('analysis.vpc.packets')}</th>}
                            <th class="num">ACCEPT</th>
                            <th class="num">REJECT</th>
                            {kind === 'port' && <th class="num">{t('analysis.vpc.rejectRate')}</th>}
                            <th>{t('analysis.logs')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => {
                            const label =
                              kind === 'port'
                                ? `${flowProtocolLabel(row.protocol)} / ${row.port ?? '—'}`
                                : (row.address ?? '—');
                            const groupLabel = `${t(columns[kind])}: ${label}`;
                            return (
                              <tr key={JSON.stringify([row.address, row.protocol, row.port])}>
                                <td class="mono flow-address">{label}</td>
                                <td class="num" title={row.bytes?.toLocaleString()}>
                                  {bytes(row.bytes)}
                                </td>
                                {kind === 'port' && (
                                  <td class="num">{row.packets === null ? '—' : row.packets.toLocaleString()}</td>
                                )}
                                <td class="num">{row.accepted.toLocaleString()}</td>
                                <td class="num">
                                  {row.rejected ? (
                                    <button
                                      class="btn small ghost"
                                      aria-label={`${t('analysis.vpc.rejectLogs')}: ${groupLabel}`}
                                      onClick={() =>
                                        explore(
                                          flowLogsFilter(template, `${groupLabel} · REJECT`, row, true),
                                          template.bytes.name,
                                        )
                                      }
                                    >
                                      {row.rejected.toLocaleString()}
                                    </button>
                                  ) : (
                                    '0'
                                  )}
                                </td>
                                {kind === 'port' && (
                                  <td class="num">{((row.rejected / row.records) * 100).toFixed(2)}%</td>
                                )}
                                <td>
                                  <button
                                    class="btn small"
                                    onClick={() =>
                                      explore(flowLogsFilter(template, groupLabel, row), template.bytes.name)
                                    }
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
          <p class="hint">{t('analysis.vpc.rankingHint')}</p>
        </>
      )}
    </AnalysisPanel>
  );
}
