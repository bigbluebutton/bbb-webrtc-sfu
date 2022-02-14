const config = require('config');
const MCS = require('../base/MCSAPIWrapper.js');
const Logger = require('../common/logger.js');

const MCS_ADDRESS = config.get("mcs-address");
const MCS_PORT = config.get("mcs-port");

const mcs = new MCS()

mcs.start(MCS_ADDRESS, MCS_PORT).catch(error => {
  Logger.error('[main-process] Failed to establish MCS connection', {
    errorMessage: error.message, errorCode: error.code,
  });
})

module.exports = mcs;
