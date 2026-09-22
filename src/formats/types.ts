export type FormatId =
  | 'auto'
  | 'parquet'
  | 'csv'
  | 'json'
  | 'alb'
  | 'cloudfront'
  | 'cloudtrail'
  | 'flowlogs'
  | 's3access'
  | 'waf'
  | 'r53resolver'
  | 'gcplog'
  | 'cflogpush'
  | 'ltsv'
  | 'cwlexport'
  | 'lines';

/**
 * How a format is read under the OpenTelemetry names. `columns` is the whole projection, in
 * order. A projection that brings its own `reader` replaces the format's reader and its wrap:
 * the JSON families read the records as they are rather than through an inferred schema.
 */
export interface OtelProjection {
  columns: [string, string][];
  reader?: (list: string, withFilename: boolean) => string;
}

export interface FormatDef {
  id: FormatId;
  /** table function over the file list */
  reader: (list: string, withFilename: boolean) => string;
  /** star modifier for the reader's columns (starts with " REPLACE (") */
  replace?: string;
  /** extra SELECT expressions (start with ", ") */
  select?: string;
  /** wrap "SELECT … FROM reader" → e.g. unnest Records */
  wrap?: (inner: string) => string;
  /** preferred time field */
  timeField?: string;
  /** projection under the OpenTelemetry names; the time field is then "timestamp" */
  otel?: OtelProjection;
  /** the same, for a format whose columns are only known once a file has been read */
  otelByName?: OtelByName;
  /** detect from the first URL */
  detect?: RegExp;
}

// ---- OpenTelemetry field names ----
//
// A fixed layout can be read under its own field names (`native`) or under the names of the
// OpenTelemetry semantic conventions (`otel`). The second is a projection: every column of the
// layout appears exactly once, renamed, and a few are split into the parts the conventions ask
// for (host:port, the request line, the TLS version). Values are not rewritten; a derived column
// is NULL when the text it is derived from does not have that part.
//
// Names that the conventions do not cover — most of what a load balancer logs — keep the AWS
// field name under the vendor namespace of the service (aws.alb.*, aws.cloudfront.*, aws.s3.*).
// Other providers follow the same rule with their own namespace (gcp.*, cloudflare.*).

export type Naming = 'native' | 'otel';

export const NAMING_IDS: Naming[] = ['native', 'otel'];

// ---- VPC Flow Logs ----
//
// The fields of a flow log and their order are chosen when the flow log is created, and the file
// names them in its header line, so there is no column list to project and no reader that can
// name them in advance. This mapping is applied to the columns that a source turns out to have
// (see otelRename): a field that is not there simply produces no column, and one this mapping
// does not name keeps its own under aws.vpc.flow.*, which covers a custom field as well as one
// AWS adds later. Parquet delivery spells the fields with underscores and text with hyphens; the
// two are the same key here.

/** Mapping for a format whose columns are only known once a file has been read. */
export interface OtelByName {
  /** field → the columns it becomes, as [name, expression]; `{}` in the expression is the column as the file spells it */
  map: Record<string, [string, string?][]>;
  /** namespace for a field the map does not name */
  prefix: string;
}
