import { pino, type Logger, type LoggerOptions } from 'pino';

let logger: Logger;

const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

if (process.env.NODE_ENV === 'production') {
  logger = pino(loggerOptions);
} 

else {
  logger = pino(
    loggerOptions,
    pino.transport({
      targets: [
        {
          target: 'pino-pretty',         // Pretty logs to console
          options: { colorize: true },
          level: 'info',
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
