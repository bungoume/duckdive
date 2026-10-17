import { findField, type Field } from './fields';
import type { Compiled, QueryPlan } from './queryPlans';
import { lit, newId, VIEW, type Filter } from './sql';

export interface VpcFlowTemplate {
  id: 'vpcflow';
  action: Field;
  bytes: Field;
  packets?: Field;
  source: Field;
  destination: Field;
  port: Field;
  protocol: Field;
  logStatus?: Field;
}

export function vpcFlowTemplateFor(fields: Field[]): VpcFlowTemplate | null {
  const find = (...names: string[]) => names.map((n) => findField(fields, n)).find(Boolean);
  for (const otel of [false, true]) {
    const action = find(otel ? 'aws.vpc.flow.action' : 'action');
    const bytes = find(otel ? 'aws.vpc.flow.bytes' : 'bytes');
    const packets = find(otel ? 'aws.vpc.flow.packets' : 'packets');
    const source = find(otel ? 'source.address' : 'srcaddr');
    const destination = find(otel ? 'destination.address' : 'dstaddr');
    const port = find(otel ? 'destination.port' : 'dstport');
    const protocol = find(otel ? 'aws.vpc.flow.protocol' : 'protocol');
    const logStatus = otel ? find('aws.vpc.flow.log_status') : find('log_status', 'log-status');
    const marker = otel || logStatus || find('interface_id', 'interface-id');
    const numeric = (f: Field | undefined): f is Field => !!f && ['number', 'string'].includes(f.kind);
    if (
      (logStatus && logStatus.kind !== 'string') ||
      !marker ||
      action?.kind !== 'string' ||
      source?.kind !== 'string' ||
      destination?.kind !== 'string' ||
      !numeric(bytes) ||
      !numeric(port) ||
      !numeric(protocol)
    )
      continue;
    return {
      id: 'vpcflow',
      action,
      bytes,
      source,
      destination,
      port,
      protocol,
      packets: numeric(packets) ? packets : undefined,
      logStatus,
    };
  }
  return null;
}

/** Invalid counters are unavailable, never silently counted as zero. */
export function flowCounterExpr(field: Field | undefined, max?: number): string {
  if (!field) return 'NULL::DOUBLE';
  const n = `TRY_CAST(${field.expr} AS DOUBLE)`;
  return `CASE WHEN ${n} >= 0 AND isfinite(${n}) AND floor(${n}) = ${n}${max === undefined ? '' : ` AND ${n} <= ${max}`} THEN ${n} END`;
}
export function flowAddressExpr(field: Field): string {
  return `nullif(nullif(${field.expr}, ''), '-')`;
}
export function flowEligibleExpr(template: VpcFlowTemplate): string {
  return `${template.action.expr} IN ('ACCEPT', 'REJECT')${template.logStatus ? ` AND ${template.logStatus.expr} = 'OK'` : ''}`;
}

export type FlowGroupKind = 'source' | 'destination' | 'port';
export interface FlowGroup {
  kind: FlowGroupKind;
  address: string | null;
  port: number | null;
  protocol: number | null;
  records: number;
  accepted: number;
  rejected: number;
  bytes: number | null;
  packets: number | null;
  measured: number;
}
export interface FlowAnalysis {
  total: number;
  records: number;
  accepted: number;
  rejected: number;
  rejectRate: number | null;
  excluded: number;
  noData: number;
  skipData: number;
  bytes: number | null;
  packets: number | null;
  measured: number;
  groups: FlowGroup[];
}

/** One materialized source scan feeds the summary and three independently limited rankings. */
export function buildFlowAnalysisQuery(template: VpcFlowTemplate, compiled: Compiled): QueryPlan<FlowAnalysis> {
  const aggregate = `count(*)::DOUBLE AS records,
    count(*) FILTER (WHERE action = 'ACCEPT')::DOUBLE AS accepted,
    count(*) FILTER (WHERE action = 'REJECT')::DOUBLE AS rejected,
    sum(bytes)::DOUBLE AS bytes, sum(packets)::DOUBLE AS packets, count(bytes)::DOUBLE AS measured`;
  const rank = `ORDER BY bytes DESC NULLS LAST, records DESC, address ASC NULLS LAST, protocol ASC NULLS LAST, port ASC NULLS LAST LIMIT 10`;
  const sql = `WITH flow_base AS MATERIALIZED (
    SELECT ${template.action.expr} AS action, (${flowEligibleExpr(template)}) AS eligible,
      ${template.logStatus?.expr ?? 'NULL::VARCHAR'} AS log_status,
      ${flowCounterExpr(template.bytes)} AS bytes, ${flowCounterExpr(template.packets)} AS packets,
      ${flowAddressExpr(template.source)} AS source, ${flowAddressExpr(template.destination)} AS destination,
      ${flowCounterExpr(template.port, 65535)} AS port, ${flowCounterExpr(template.protocol, 255)} AS protocol
    FROM ${VIEW} WHERE ${compiled.where}
  ), flows AS (SELECT * FROM flow_base WHERE eligible), summary AS (
    SELECT ${aggregate} FROM flows
  ), coverage AS (
    SELECT count(*)::DOUBLE AS total,
      count(*) FILTER (WHERE log_status = 'NODATA')::DOUBLE AS no_data,
      count(*) FILTER (WHERE log_status = 'SKIPDATA')::DOUBLE AS skip_data FROM flow_base
  ), sources AS (
    SELECT 'source' AS kind, source AS address, NULL::DOUBLE AS port, NULL::DOUBLE AS protocol, ${aggregate}
    FROM flows WHERE source IS NOT NULL GROUP BY source ${rank}
  ), destinations AS (
    SELECT 'destination' AS kind, destination AS address, NULL::DOUBLE AS port, NULL::DOUBLE AS protocol, ${aggregate}
    FROM flows WHERE destination IS NOT NULL GROUP BY destination ${rank}
  ), ports AS (
    SELECT 'port' AS kind, NULL::VARCHAR AS address, port, protocol, ${aggregate}
    FROM flows GROUP BY port, protocol ${rank}
  ), flow_rankings AS (SELECT * FROM sources UNION ALL SELECT * FROM destinations UNION ALL SELECT * FROM ports)
  SELECT summary.*, coverage.*, r.kind, r.address, r.port, r.protocol,
    r.records AS group_records, r.accepted AS group_accepted, r.rejected AS group_rejected,
    r.bytes AS group_bytes, r.packets AS group_packets, r.measured AS group_measured
  FROM summary CROSS JOIN coverage LEFT JOIN flow_rankings r ON TRUE
  ORDER BY r.kind, r.bytes DESC NULLS LAST, r.records DESC, r.address ASC NULLS LAST, r.protocol ASC NULLS LAST, r.port ASC NULLS LAST`;
  const nullable = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    sql,
    read(rows) {
      const r = rows[0];
      const total = Number(r?.total ?? 0);
      const records = Number(r?.records ?? 0);
      const rejected = Number(r?.rejected ?? 0);
      return {
        total,
        records,
        rejected,
        accepted: Number(r?.accepted ?? 0),
        rejectRate: records ? (rejected / records) * 100 : null,
        excluded: total - records,
        noData: Number(r?.no_data ?? 0),
        skipData: Number(r?.skip_data ?? 0),
        bytes: nullable(r?.bytes),
        packets: nullable(r?.packets),
        measured: Number(r?.measured ?? 0),
        groups: rows
          .filter((row) => row.kind != null)
          .map((row) => ({
            kind: String(row.kind) as FlowGroupKind,
            address: row.address == null ? null : String(row.address),
            port: nullable(row.port),
            protocol: nullable(row.protocol),
            records: Number(row.group_records),
            accepted: Number(row.group_accepted),
            rejected: Number(row.group_rejected),
            bytes: nullable(row.group_bytes),
            packets: nullable(row.group_packets),
            measured: Number(row.group_measured),
          })),
      };
    },
  };
}

export function flowLogsFilter(template: VpcFlowTemplate, label: string, group?: FlowGroup, rejected = false): Filter {
  const clauses = [`(${flowEligibleExpr(template)})`];
  if (rejected) clauses.push(`${template.action.expr} = 'REJECT'`);
  if (group?.kind === 'source' || group?.kind === 'destination')
    clauses.push(`(${flowAddressExpr(template[group.kind])}) = ${lit(group.address ?? '')}`);
  if (group?.kind === 'port') {
    clauses.push(`(${flowCounterExpr(template.port, 65535)}) IS NOT DISTINCT FROM ${group.port ?? 'NULL'}`);
    clauses.push(`(${flowCounterExpr(template.protocol, 255)}) IS NOT DISTINCT FROM ${group.protocol ?? 'NULL'}`);
  }
  return { id: newId(), field: '', op: 'query', label, sql: clauses.join(' AND ') };
}

export function flowProtocolLabel(protocol: number | null): string {
  if (protocol === null) return '—';
  const names: Record<number, string> = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 58: 'ICMPv6', 132: 'SCTP' };
  return names[protocol] ? `${names[protocol]} (${protocol})` : String(protocol);
}
