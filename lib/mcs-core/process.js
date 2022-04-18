'use strict';
const Logger = require('./lib/utils/logger.js');
const BaseProcess = require('../common/base-process.js');
  const MediaController = require('./lib/media/media-controller.js');
const API = require('mcs-js');
const MCSRouter = require('./lib/api/mcs-message-router.js');
const http = require('http');
const config = require('config');

const MCS_ROUTER = new MCSRouter(MediaController);

class CoreProcess extends BaseProcess {
  constructor (app, prefix) {
    super(app, prefix)
  }

  startMCSServer () {
    // HTTPS server
    const port = config.get('mcs-port');
    const host = config.has('mcs-host') ? config.get('mcs-host') : '127.0.0.1';
    const connectionTimeout = config.get('mcs-ws-timeout');
    const serverHttps = http.createServer().listen(port, host, () => {
      Logger.info('API transport: up');
    });

    const mcsServer = new API.Server({
      path: config.get('mcs-path'),
      server: serverHttps,
      connectionTimeout
    });

    mcsServer.on('connection', this.app.setupClient.bind(this.app));
  }

  handleException (error) {
    if (error.code === 'EADDRINUSE') {
      Logger.warn("There's probably another master mcs-core instance running, kill this one");
      this.stop();
      return;
    }

    Logger.error('TODO => Uncaught exception', error.stack);

    if (this.runningState === "STOPPING") {
      Logger.warn("Exiting process with code 1");
      process.exit(1);
    }
  }
}

const coreProcess = new CoreProcess(MCS_ROUTER, '[mcs-core]');

coreProcess.start();
coreProcess.startMCSServer();
