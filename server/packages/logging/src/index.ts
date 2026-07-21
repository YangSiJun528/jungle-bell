import { getTextFormatter, type Sink } from "@logtape/logtape";

const formatMessage = getTextFormatter({
  timestamp: "disabled",
  format: ({ message }) => message,
});

export function getCloudflareConsoleSink(): Sink {
  return (record) => {
    const entry = {
      ...record.properties,
      timestamp: new Date(record.timestamp).toISOString(),
      level: record.level,
      category: record.category.join("."),
      message: formatMessage(record),
    };
    if (record.level === "fatal" || record.level === "error") console.error(entry);
    else if (record.level === "warning") console.warn(entry);
    else if (record.level === "info") console.info(entry);
    else console.debug(entry);
  };
}
