import { getConsoleSink, getTextFormatter, type ConsoleFormatter, type Sink } from "@logtape/logtape";

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

export function getCloudflareConsoleSink(): Sink {
  return getConsoleSink({ formatter: cloudflareFormatter });
}
