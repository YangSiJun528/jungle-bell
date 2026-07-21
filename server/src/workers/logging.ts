import { configure, getConsoleSink, getTextFormatter, type ConsoleFormatter } from "@logtape/logtape";

const formatMessage = getTextFormatter({
  timestamp: "disabled",
  format: ({ message }) => message,
});

const cloudflareFormatter: ConsoleFormatter = (record) => [
  {
    ...record.properties,
    timestamp: new Date(record.timestamp).toISOString(),
    level: record.level,
    category: record.category.join("."),
    message: formatMessage(record),
  },
];

let loggingConfigured: Promise<void> | null = null;

export function configureWorkerLogging(): Promise<void> {
  loggingConfigured ??= configure({
    sinks: {
      cloudflare: getConsoleSink({ formatter: cloudflareFormatter }),
    },
    loggers: [
      { category: ["jungle-bell"], lowestLevel: "info", sinks: ["cloudflare"] },
      { category: ["logtape"], lowestLevel: "error", sinks: ["cloudflare"] },
    ],
  });
  return loggingConfigured;
}
