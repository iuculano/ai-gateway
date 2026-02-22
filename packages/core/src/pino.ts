// Pino seems to have some issues with ESM imports
import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';

let logger: Logger;
const nodeEnv = process.env.NODE_ENV ?? 'development';
const logLevel = process.env.LOG_LEVEL ?? 'info';

const loggerOptions: LoggerOptions = {
  // This is 'global' log level, the minimum level of logs that will be emitted.
  // The transport must be AT OR BELOW this level.
  //
  // For example, if this is set to 'info', then the transport can't be set to
  // 'debug' because those logs are never emitted to begin with.
  level: logLevel,

  // UPPERCASE the log level in the text output because it looks better.
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

if (nodeEnv === 'production') {
  logger = pino(loggerOptions);
}

else {
  logger = pino(
    loggerOptions,
    pino.transport({
      targets: [
        {
          target: 'pino-pretty', // Pretty logs to console
          options: { colorize: true },

          // For now, just use the same log level
          level: logLevel,
        },
        //{
        //  target: 'pino/file',
        //  options: { destination: './logs.json' },
        //  level: 'info'
        //}
      ]
    })
  );
}

export { logger };
export default logger;
