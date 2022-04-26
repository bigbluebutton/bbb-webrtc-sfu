'use strict';

const { addColors, format, createLogger, transports } = require('winston');
const { combine, colorize, timestamp, label, json, printf, errors } = format;
const config = require('config');

const LOG_CONFIG = config.get('log') || {};
const { level, filename, stdout = true } = LOG_CONFIG;

addColors({
  error: 'red',
  warn: 'yellow',
  info: 'green',
  verbose: 'cyan',
  debug: 'magenta',
  trace: 'gray'
});

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
  trace: 5,
};

const loggingTransports = [];

if (filename) {
  loggingTransports.push(new transports.File({
    filename,
    format: combine(
      timestamp(),
      label({ label: process.env.SFU_MODULE_NAME || 'sfu' }),
      errors({ stack: true }),
      json(),
    )
  }));
}

if (stdout) {
  if (process.env.NODE_ENV !== 'production') {
    // Development logging - fancier, more human readable stuff
    const jsonStringify = require('safe-stable-stringify');
    loggingTransports.push(new transports.Console({
      format: combine(
        colorize(),
        timestamp(),
        label({ label: process.env.SFU_MODULE_NAME || 'sfu' }),
        errors({ stack: true }),
        printf(({ level, message, timestamp, label = 'sfu', ...meta}) => {
          const stringifiedRest = jsonStringify(Object.assign({}, meta, {
            splat: undefined
          }));

          if (stringifiedRest !== '{}') {
            return `${timestamp} - ${level}: [${label}] ${message} ${stringifiedRest}`;
          } else {
            return `${timestamp} - ${level}: [${label}] ${message}`;
          }
        }),
      )
    }));
  } else {
    loggingTransports.push(new transports.Console({
      format: combine(
        timestamp(),
        label({ label: process.env.SFU_MODULE_NAME || 'sfu' }),
        errors({ stack: true }),
        json(),
      )
    }));
  }
}

const Logger = createLogger({
  levels: LEVELS,
  level,
  transports: loggingTransports,
  exitOnError: false,
});

Logger.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error("Logger failure", error);
});

module.exports = Logger;
