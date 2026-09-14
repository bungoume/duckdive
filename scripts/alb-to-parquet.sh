#!/usr/bin/env bash
# Convert one UTC day of ALB access logs (gzip, 30–34 fields) into hourly Parquet files,
# using the DuckDB CLI. Run it from a laptop, a cron job or GitHub Actions – no server needed.
#
#   scripts/alb-to-parquet.sh \
#     s3://my-alb-logs/AWSLogs/123456789012/elasticloadbalancing/ap-northeast-1 \
#     app.alb-app-dev 2026-09-09 s3://my-analytics/alb/alb-app-dev
#
# Output: <dest>/dt=2026-09-09/hour=00/data.parquet … (one file per hour, sorted by time,
# zstd, 100k-row row groups) — readable in the extension with
#   s3://my-analytics/alb/alb-app-dev/dt={yyyy}-{MM}-{dd}/hour={HH}/*.parquet
# AWS credentials come from the usual environment / profile (DuckDB's credential chain).
set -euo pipefail
SRC_PREFIX=${1:?source prefix, e.g. s3://bucket/AWSLogs/<account>/elasticloadbalancing/<region>}
ALB=${2:?load balancer name as it appears in file names, e.g. app.my-alb}
DAY=${3:?day (UTC) as YYYY-MM-DD}
DEST=${4:?destination prefix, e.g. s3://bucket/alb-parquet/my-alb or ./out}
ACCOUNT=$(echo "$SRC_PREFIX" | sed -E 's#.*/AWSLogs/([0-9]+)/.*#\1#')
REGION=$(echo "$SRC_PREFIX" | sed -E 's#.*/elasticloadbalancing/([^/]+).*#\1#')
Y=${DAY:0:4}; M=${DAY:5:2}; D=${DAY:8:2}
GLOB="${SRC_PREFIX}/${Y}/${M}/${D}/${ACCOUNT}_elasticloadbalancing_${REGION}_${ALB}.*.log.gz"

duckdb <<SQL
INSTALL httpfs; LOAD httpfs;
CREATE SECRET IF NOT EXISTS (TYPE s3, PROVIDER credential_chain);
COPY (
  SELECT *, strftime(time, '%H') AS hour
  FROM read_csv('${GLOB}',
    delim = ' ', quote = '"', escape = '"', header = false,
    auto_detect = false, null_padding = true, strict_mode = false,
    timestampformat = '%Y-%m-%dT%H:%M:%S.%fZ',
    columns = {
      'type': 'VARCHAR', 'time': 'TIMESTAMP', 'elb': 'VARCHAR', 'client_port': 'VARCHAR', 'target_port': 'VARCHAR',
      'request_processing_time': 'DOUBLE', 'target_processing_time': 'DOUBLE', 'response_processing_time': 'DOUBLE',
      'elb_status_code': 'INTEGER', 'target_status_code': 'VARCHAR', 'received_bytes': 'BIGINT', 'sent_bytes': 'BIGINT',
      'request': 'VARCHAR', 'user_agent': 'VARCHAR', 'ssl_cipher': 'VARCHAR', 'ssl_protocol': 'VARCHAR', 'target_group_arn': 'VARCHAR',
      'trace_id': 'VARCHAR', 'domain_name': 'VARCHAR', 'chosen_cert_arn': 'VARCHAR', 'matched_rule_priority': 'VARCHAR',
      'request_creation_time': 'TIMESTAMP', 'actions_executed': 'VARCHAR', 'redirect_url': 'VARCHAR', 'error_reason': 'VARCHAR',
      'target_port_list': 'VARCHAR', 'target_status_code_list': 'VARCHAR', 'classification': 'VARCHAR', 'classification_reason': 'VARCHAR',
      'conn_trace_id': 'VARCHAR', 'transformed_host': 'VARCHAR', 'transformed_uri': 'VARCHAR', 'request_transform_status': 'VARCHAR', 'ip_address': 'VARCHAR'
    })
  WHERE time >= TIMESTAMP '${DAY} 00:00:00' AND time < TIMESTAMP '${DAY} 00:00:00' + INTERVAL 1 DAY
  ORDER BY hour, time
) TO '${DEST}/dt=${DAY}' (FORMAT PARQUET, PARTITION_BY (hour), COMPRESSION zstd, ROW_GROUP_SIZE 100000, OVERWRITE_OR_IGNORE);
SQL
echo "wrote ${DEST}/dt=${DAY}/hour=*/"
