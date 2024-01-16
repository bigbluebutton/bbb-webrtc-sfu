'use strict';

const config = require('config');
const LOG_CONFIG = config.get('log') || {};
const {
  level: DEFAULT_LEVEL,
  file: DEFAULT_USE_FILE = true,
  filename: DEFAULT_FILENAME,
  stdout: STDOUT = true,
} = LOG_CONFIG;
const pino = require('pino');

/**
 * @typedef {object} LoggerOptions
 * @property {string} filename - the filename to log to
 * @property {string} level - the maximum log level to use
 * @property {boolean} stdout - whether to log to stdout
 */

/**
 * _newLogger.
 * @private
 * @param {LoggerOptions} options - the options to be used when creating the logger
 * @returns {external:pino.Logger} a Pino logger instance
 */
const _newLogger = ({
  filename,
  level,
  stdout,
}) => {
  const loggingTransports = [];

  if (DEFAULT_USE_FILE && filename) {
    try {
      loggingTransports.push({
        level,
        target: 'pino/file',
        options: {
          destination: filename,
          mkdir: true,
        }
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to create file transport, won't log to file", error);
    }
  }

  if (stdout) {
    if (process.env.NODE_ENV !== 'production') {
      // Development logging - fancier, more human readable stuff
      loggingTransports.push({
        level,
        target: 'pino-pretty',
        colorize: true,
      });
    } else {
      // Production logging - regular stdout, no colors, no fancy stuff
      loggingTransports.push({
        level,
        target: 'pino/file',
        options: {
          destination: 1,
        },
      });
    }
  }

  const hooks = {
    // Reverse the order of arguments for the log method - message comes first,
    // then the rest of the arguments (object params, errors, ...)
    logMethod (inputArgs, method) {
      if (inputArgs.length >= 2) {
        const arg1 = inputArgs.shift()
        const arg2 = inputArgs.shift()
        return method.apply(this, [arg2, arg1, ...inputArgs])
      }
      return method.apply(this, inputArgs)
    }
  }

  const targets = pino.transport({ targets: loggingTransports }) ;

  targets.on('error', error => {
    // eslint-disable-next-line no-console
    console.error('CRITICAL logger failure: ', error.toString());

    if (filename && error.toString().includes('ENOENT') || error.toString().includes('EACCES')) {
      // eslint-disable-next-line no-console
      console.error(`CRITICAL: failed to get log file ${filename}`);
      process.exit(1);
    }
  })

  const logger = pino({
    level,
    hooks,
    timestamp: pino.stdTimeFunctions.isoTime,
  }, targets);

  return logger;
}

const BASE_LOGGER = _newLogger({
  filename: DEFAULT_FILENAME,
  level: DEFAULT_LEVEL,
  stdout: STDOUT,
});

/**
 * Creates a new logger with the specified label prepended to all messages
 * @name newLogger
 * @instance
 * @function
 * @public
 * @param {string} label - the label to be prepended to the message
 * @returns {BbbSfuLogger} the new logger
 */
const newLogger = (label) => {
  return BASE_LOGGER.child({ mod: label });
};

/**
 * The default logger instance for bbb-webrtc-sfu
 * @name logger
 * @instance
 * @public
 * @type {BbbSfuLogger}
 */
const Logger = newLogger(process.env.SFU_MODULE_NAME || 'sfu');

module.exports = Logger;
