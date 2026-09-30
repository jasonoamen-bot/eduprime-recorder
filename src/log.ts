export type Logger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  child: (fields: Record<string, unknown>) => Logger;
};

/** One JSON object per line: easy to read live, easy for any log service to parse. */
export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: string) => (message: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg: message, ...base, ...fields });
    (level === "error" ? console.error : console.log)(line);
  };
  return {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
