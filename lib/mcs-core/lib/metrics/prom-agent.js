const {
  register,
  collectDefaultMetrics,
} = require('prom-client');
const HTTPServer = require('../../../connection-manager/HttpServer.js');
const Logger = require('../../../utils/Logger.js');
const LOG_PREFIX = '[prom-scrape-agt]';

module.exports = class PrometheusScrapeAgent {
  constructor (host, port, options) {
    this.host = host;
    this.port = port;
    this.metrics = {};
    this.started = false;

    this.path = options.path || '/metrics';
    this.collectDefaultMetrics = options.collectDefaultMetrics || false;
    this.metricsPrefix = options.prefix || '';
    this.collectionTimeout = options.collectionTimeout || 10000;
  }

  async collect (response) {
    try {
      response.writeHead(200, { 'Content-Type': register.contentType });
      const content = await register.metrics();
      response.end(content);
    } catch (error) {
      response.writeHead(500)
      response.end(error.message);
      Logger.error(LOG_PREFIX, 'Error collecting metrics',
        { errorCode: error.code, errorMessage: error.message });
    }
  }

  getMetricsHandler (request, response) {
    switch (request.method) {
      case 'GET':
        if (request.url === this.path) return this.collect(response);
        response.writeHead(404).end();
        break;
      default:
        response.writeHead(501)
        response.end();
        break;
    }
  }

  start (requestHandler = this.getMetricsHandler.bind(this)) {
    if (this.collectDefaultMetrics) collectDefaultMetrics({
      prefix: this.metricsPrefix,
      timeout: this.collectionTimeout,
    });

    this.metricsServer = new HTTPServer(this.host, this.port, requestHandler);
    this.metricsServer.start();
    this.metricsServer.listen();
    this.started = true;
  };

  injectMetrics (metricsDictionary) {
    this.metrics = { ...this.metrics, ...metricsDictionary }
  }

  increment (metricName, labelsObject) {
    if (!this.started) return;

    const metric = this.metrics[metricName];
    if (metric) {
      metric.inc(labelsObject)
    }
  }

  decrement (metricName, labelsObject) {
    if (!this.started) return;

    const metric = this.metrics[metricName];
    if (metric) {
      metric.dec(labelsObject)
    }
  }

  set (metricName, value, labelsObject = {}) {
    if (!this.started) return;

    const metric = this.metrics[metricName];
    if (metric) {
      metric.set(labelsObject, value)
    }
  }
}
