/**
 *  @classdesc
 *  Utils class for mcs-core
 *  @constructor
 *
 */

const C = require('../constants/constants');
const Logger = require('./logger');
const { hrTime } = require('../../../common/utils.js');

exports.isError = (error) => {
  return error && error.stack && error.message && typeof error.stack === 'string'
    && typeof error.message === 'string';
}

exports.handleError = (logPrefix, error) => {
  let { message, code, stack, details } = error;

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

  if (stack && !error.stackWasLogged)  {
    Logger.error(logPrefix, `Stack trace for error ${error.code} | ${error.message} ->`,
      { errorStack: error.stack.toString() });
    error.stackWasLogged = true;
  }

  return error;
}

exports.convertRange = (originalRange, newRange, value) => {
  const newValue  = Math.round(((value - originalRange.floor) / (originalRange.ceiling - originalRange.floor)) * (newRange.ceiling - newRange.floor) + newRange.floor);

  return newValue;
}

exports.hrTime = hrTime;
