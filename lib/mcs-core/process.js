/*
 * WIP: the mcs-core lib will be turned into a dependecy sometime in the near
 * future, and it will probably act with a separate process that answers via
 * its own redis channel
 */

'use strict';
const Logger = require('./lib/utils/logger');
const MMR = require('./lib/media/mcs-message-router');
const API = require('mcs-js');
const http = require('http');
const config = require('config');

const controller = MMR;
controller.start();

Logger.info('[app] MCS Server is initializing ...');

// HTTPS server
const port = config.get('mcs-port');
const connectionTimeout = config.get('mcs-ws-timeout');
const serverHttps = http.createServer().listen(port, () => {
  Logger.info('[app] MCS Server is ready to receive connections');
});

const mcsServer = new API.Server({
  path: config.get('mcs-path'),
  server: serverHttps,
  connectionTimeout
});

mcsServer.on('connection', controller.setupClient.bind(controller));

const exit = async () => {
  try {
    const ret = await controller.stop();
    process.exit(ret);
  } catch (e) {
    process.exit(1);
  }
}

process.on('SIGINT', exit.bind(controller));

process.on('SIGTERM', exit.bind(controller));

process.on('uncaughtException', (e) => {
  if (e.code === 'EADDRINUSE') {
    Logger.warn("[mcs-core] There's probably another master SFU instance running, keep this one as slave");
    exit();
    return;
  }

  Logger.error('[mcs-core] Uncaught exception', e.stack);
});

process.on('unhandledRejection', (e1, e2) => {
  Logger.error('[mcs-core] Unhandled exception', e1, e2);
});

