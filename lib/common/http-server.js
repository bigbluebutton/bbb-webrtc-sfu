"use strict";

const http = require("http");
const Logger = require('./logger.js');

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
      Logger.warn("EADDRINUSE, won't spawn HTTP server", {
        host: this.host, port: this.port,
      });
      this.server.close();
    } else if (error.code === 'ECONNRESET') {
      Logger.warn("HTTPServer: ECONNRESET ", { errorMessage: error.message });
    } else {
      Logger.error("Returned error", error);
    }
  }

  getServerObject() {
    return this.server;
  }

  listen(callback) {
    Logger.info(`HTTPServer is listening: ${this.host}:${this.port}`);
    this.server.listen(this.port, this.host, callback);
  }
}
