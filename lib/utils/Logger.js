'use strict';

const Winston = require('winston');
const Logger = new Winston.Logger();
const config = require('config');

const LOG_CONFIG = config.get('log') || {};
const { level, filename } = LOG_CONFIG;
const COLORIZE = process.env.NODE_ENV !== 'production';

Logger.configure({
  levels: { error: 0, warn: 1, info: 2, verbose: 3, debug: 4, trace: 5 },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    verbose: 'cyan',
    debug: 'magenta',
    trace: 'gray'
  },
});

Logger.add(Winston.transports.Console, {
  timestamp:true,
  prettyPrint: false,
  humanReadableUnhandledException: true,
  colorize: COLORIZE,
  handleExceptions: false,
  silent: false,
  stringify: (obj) => JSON.stringify(obj),
  level,
});


if (filename) {
  Logger.add(Winston.transports.File, {
    filename,
    prettyPrint: false,
    prepend: false,
    stringify: (obj) => JSON.stringify(obj), // single lines
    level,
  });
}

module.exports = Logger;
