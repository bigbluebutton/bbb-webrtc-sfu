'use strict';

const C = require('../../constants/constants.js');
const FS = require('esl');
const Logger = require('../../utils/logger');
const config = require('config');
const ESL_IP = config.get('freeswitch').esl_ip;
const ESL_PORT = config.get('freeswitch').esl_port;

const sendEslCommand = cmd => {
  return new Promise((resolve, reject) => {
    const client = FS.client(function () {
      Logger.info("[ESL] Sending command to ESL", cmd);
      this.api(cmd)
      .then(function (res) {
        Logger.info("[ESL] Response for command", cmd, "is", res);
        if (!res.body.includes('OK')) {
          Logger.error("[ESL] Command", cmd, "rejected");
          return reject(C.ERROR.MEDIA_ESL_COMMAND_ERROR);
        }
        return resolve();
      })
      .then(function () {
        this.exit();
      })
      .then(function () {
        client.end();
      })
    });
    Logger.info("[ESL] Connecting to ", ESL_IP, ESL_PORT);
    client.connect(ESL_PORT,ESL_IP);
  });
};

module.exports = sendEslCommand