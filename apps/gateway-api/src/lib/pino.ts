// Pino seems to have some issues with ESM imports
import pino from 'pino';
import { type Logger, type LoggerOptions } from 'pino';
import { environment } from '@lib/environment';

let logger: Logger;

const loggerOptions: LoggerOptions = {
  // This is 'global' log level, the minimum level of logs that will be emitted.
  // The transport must be AT OR BELOW this level.
  //
  // For example, if this is set to 'info', then the transport can't be set to
  // 'debug' because those logs are never emitted to begin with.
  level: environment.LOG_LEVEL,

  // UPPERCASE the log level in the text output because it looks better.
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

if (environment.NODE_ENV=== 'production') {
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
          level: environment.LOG_LEVEL,
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

export default logger;
