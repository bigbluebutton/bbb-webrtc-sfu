"use strict";

const http = require("http");
const fs = require("fs");
const config = require('config');
const Logger = require('../utils/Logger');
const LOG_PREFIX = '[HttpServer]';

module.exports = class HttpServer {
  constructor() {
    this.port = config.get('clientPort');
    this.host = config.has('clientHost') ? config.get('clientHost') : '127.0.0.1';

    this.server = http.createServer((req,res) => {
    }).on('error', this.handleError.bind(this))
    .on('clientError', this.handleError.bind(this));
  }

  handleError (error) {
    if (error.code === 'EADDRINUSE') {
      Logger.warn(LOG_PREFIX, "Another master SFU instance running, won't spawn HTTP server");
      this.server.close();
    } else if (error.code === 'ECONNRESET') {
       Logger.warn(LOG_PREFIX, "Server throw ECONNRESET for a socket", error);
    } else {
      Logger.error(LOG_PREFIX, "Returned error", error);
    }
  }

  getServerObject() {
    return this.server;
  }

  listen(callback) {
    Logger.info(LOG_PREFIX, "Listening", { host: `${this.host}:${this.port}` });
    this.server.listen(this.port, this.host, callback);
  }
}
