"use strict";

const http = require("http");
const Logger = require('../utils/Logger');
const LOG_PREFIX = '[HttpServer]';

module.exports = class HttpServer {
  constructor(host, port, callback) {
    this.host = host;
    this.port = port;
    this.requestCallback = callback;
  }

  start () {
    this.server = http.createServer(this.requestCallback)
      .on('error', this.handleError.bind(this))
      .on('clientError', this.handleError.bind(this));
  }

  close (callback) {
    return this.server.close(callback);
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
