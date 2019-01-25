/**
 *  @classdesc
 *  Utils class for mcs-core
 *  @constructor
 *
 */

const C = require('../constants/constants');
const Logger = require('./logger');

exports.isError = (error) => {
  return error && error.stack && error.message && typeof error.stack === 'string'
    && typeof error.message === 'string';
}

exports.handleError = (logPrefix, error) => {
  let { message, code, stack, data, details } = error;

  Logger.trace(logPrefix, "Error stack", error);

  if (code && code >= C.ERROR.MIN_CODE && code <= C.ERROR.MAX_CODE) {
    return error;
  }

  if (code == null) {
    ({ code, message } = C.ERROR.MEDIA_GENERIC_ERROR);
  }
  else {
    ({ code, message } = error);
  }

  if (!this.isError(error)) {
    error = new Error(message);
  }

  error.code = code;
  error.message = message;
  error.stack = stack

  if (details) {
    error.details = details;
  }
  else {
    error.details = message;
  }

  Logger.debug(logPrefix, "Handling error", error.code, error.message);

  return error;
}

exports.convertRange = (originalRange, newRange, value) => {
  const newValue  = Math.round(((value - originalRange.floor) / (originalRange.ceiling - originalRange.floor)) * (newRange.ceiling - newRange.floor) + newRange.floor);

  return newValue;
}
