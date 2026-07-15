import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// ponytail: logs only, no traces/metrics — Loki is a log store, and every
// event this server cares about (register/reply/close/etc.) already gets
// emitted as a structured line via log()/audit(); shipping that same line
// via OTLP is the whole feature. Add traces/metrics if a Prometheus/Mimir
// backend shows up later.
let otelLogger: ReturnType<typeof logs.getLogger> | null = null;

export function initOtel() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // no collector configured — stay a no-op

  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "lattice",
    }),
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })],
  });
  logs.setGlobalLoggerProvider(provider);
  otelLogger = logs.getLogger("lattice");
}

export function emitOtelLog(fields: Record<string, unknown>) {
  if (!otelLogger) return;
  const { message, level, ...attributes } = fields;
  otelLogger.emit({
    severityNumber: level === "error" ? SeverityNumber.ERROR : SeverityNumber.INFO,
    body: typeof message === "string" ? message : JSON.stringify(fields),
    attributes: attributes as Record<string, string | number | boolean>,
  });
}
