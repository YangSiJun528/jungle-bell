import { configure, getConsoleSink, getTextFormatter, type ConsoleFormatter } from "@logtape/logtape";

const formatMessage = getTextFormatter({
  timestamp: "disabled",
  format: ({ message }) => message,
});

const structuredConsoleFormatter: ConsoleFormatter = (record) => [
  {
    ...record.properties,
    timestamp: new Date(record.timestamp).toISOString(),
    level: record.level,
    category: record.category.join("."),
    message: formatMessage(record),
  },
];

let loggingConfigured: Promise<void> | null = null;

export function configureServerLogging(): Promise<void> {
  loggingConfigured ??= configure({
    sinks: {
      console: getConsoleSink({ formatter: structuredConsoleFormatter }),
    },
    loggers: [
      { category: ["jungle-bell"], lowestLevel: "info", sinks: ["console"] },
      { category: ["logtape"], lowestLevel: "error", sinks: ["console"] },
    ],
  });
  return loggingConfigured;
}
