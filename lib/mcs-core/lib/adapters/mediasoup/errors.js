const C = require('../../constants/constants');
const { isError } = require('../../utils/util');
const Logger = require('../../utils/logger');

const ERRORS = {
  /* GENERIC MEDIA ERRORS */
  40004:  { type: "CONNECT_ERROR", error: C.ERROR.MEDIA_CONNECT_ERROR },
  40005:  { type: "UNSUPPORTED_MEDIA_TYPE",  error: C.ERROR.MEDIA_INVALID_TYPE },
  40006:  { type: "NOT_IMPLEMENTED" , error: C.ERROR.MEDIA_INVALID_OPERATION },
  40009:  { type: "NOT_ENOUGH_RESOURCES", error: C.ERROR.MEDIA_SERVER_NO_RESOURCES },

  /* MediaObject ERRORS */
  40100:  { type: "MEDIA_OBJECT_TYPE_NOT_FOUND", error: C.ERROR.MEDIA_INVALID_TYPE },
  40101:  { type: "MEDIA_OBJECT_NOT_FOUND", error: C.ERROR.MEDIA_NOT_FOUND },
  40104:  { type: "MEDIA_OBJECT_CONSTRUCTOR_NOT_FOUND", error: C.ERROR.MEDIA_INVALID_OPERATION },
  40105:  { type: "MEDIA_OBJECT_METHOD_NOT_FOUND", error: C.ERROR.MEDIA_INVALID_OPERATION },
  40106:  { type: "MEDIA_OBJECT_EVENT_NOT_SUPPORTED", error: C.ERROR.MEDIA_INVALID_OPERATION },
  40107:  { type: "MEDIA_OBJECT_ILLEGAL_PARAM_ERROR", error: C.ERROR.MEDIA_INVALID_OPERATION },
  40108:  { type: "MEDIA_OBJECT_NOT_AVAILABLE", error: C.ERROR.MEDIA_NOT_FOUND },
  40109:  { type: "MEDIA_OBJECT_NOT_FOUND_TRANSACTION_NO_COMMIT", error: C.ERROR.MEDIA_INVALID_OPERATION },
  40110:  { type: "MEDIA_OBJECT_TAG_KEY_NOT_FOUND", error: C.ERROR.MEDIA_INVALID_OPERATION },
  40111:  { type: "MEDIA_OBJECT_OPERATION_NOT_SUPPORTED", error: C.ERROR.MEDIA_INVALID_OPERATION },

  /* SDP ERRORS */
  40200:  { type: "SDP_CREATE_ERROR", error: C.ERROR.MEDIA_GENERIC_ERROR },
  40201:  { type: "SDP_PARSE_ERROR", error: C.ERROR.MEDIA_INVALID_SDP },
  40202:  { type: "SDP_END_POINT_NO_LOCAL_SDP_ERROR", error: C.ERROR.MEDIA_INVALID_SDP },
  40203:  { type: "SDP_END_POINT_NO_REMOTE_SDP_ERROR", error: C.ERROR.MEDIA_INVALID_SDP },
  40204:  { type: "SDP_END_POINT_GENERATE_OFFER_ERROR", error: C.ERROR.MEDIA_GENERATE_OFFER_FAILED },
  40205:  { type: "SDP_END_POINT_PROCESS_OFFER_ERROR" , error: C.ERROR.MEDIA_PROCESS_OFFER_FAILED },
  40206:  { type: "SDP_END_POINT_PROCESS_ANSWER_ERROR", error: C.ERROR.MEDIA_PROCESS_ANSWER_FAILED },
  40207:  { type: "SDP_CONFIGURATION_ERROR", error: C.ERROR.MEDIA_GENERIC_ERROR },
  40208:  { type: "SDP_END_POINT_ALREADY_NEGOTIATED", error: C.ERROR.MEDIA_PROCESS_OFFER_FAILED },
  40209:  { type: "SDP_END_POINT_NOT_OFFER_GENERATED", error: C.ERROR.MEDIA_GENERATE_OFFER_FAILED },
  40210:  { type: "SDP_END_POINT_ANSWER_ALREADY_PROCCESED", error: C.ERROR.MEDIA_PROCESS_ANSWER_FAILED },
  40211:  { type: "SDP_END_POINT_CANNOT_CREATE_SESSON", error: C.ERROR.MEDIA_GENERIC_ERROR },

  /* ICE ERRORS */
  40400:  { type: "ICE_GATHER_CANDIDATES_ERROR", error: C.ERROR.ICE_GATHERING_FAILED },
  40401:  { type: "ICE_ADD_CANDIDATE_ERROR", error: C.ERROR.ICE_CANDIDATE_FAILED },
};

// TODO review
const handleError = (err) => {
  let { message: oldMessage , code, stack } = err;
  let message;

  if (code && code >= C.ERROR.MIN_CODE && code <= C.ERROR.MAX_CODE) {
    return err;
  }

  const error = ERRORS[code]? ERRORS[code].error : null;

  if (error == null) {
    switch (oldMessage) {
      case "Request has timed out":
        ({ code, message }  = C.ERROR.MEDIA_SERVER_REQUEST_TIMEOUT);
        break;

      case "Connection error":
        ({ code, message } = C.ERROR.CONNECTION_ERROR);
        break;

      default:
        ({ code, message } = C.ERROR.MEDIA_SERVER_GENERIC_ERROR);
    }
  }
  else {
    ({ code, message } = error);
  }

  // Checking if the error needs to be wrapped into a JS Error instance
  if (!isError(err)) {
    err = new Error(message);
  }

  err.code = code;
  err.message = message;
  err.details = oldMessage;
  err.stack = stack

  if (stack && !err.stackWasLogged)  {
    Logger.error(process.env.LOG_PREFIX, `Stack trace for error ${err.code} | ${err.message} ->`,
      { errorStack: err.stack.toString() });
    err.stackWasLogged = true;
  }
  return err;
}

module.exports = {
  ERRORS,
  handleError,
}
