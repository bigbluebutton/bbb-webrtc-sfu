'use strict';

const os = require('os')
const mediasoup = require('mediasoup');
const { v4: uuidv4 }= require('uuid');
const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const {
  DEFAULT_NOF_WORKERS, WORKER_SETTINGS, LOG_PREFIX,
  WORKER_EXPORT_RESOURCE_USAGE,
} = require('./configs.js');
const {
  PrometheusAgent, MS_METRIC_NAMES, exportWorkerResourceUsageMetrics
} = require('./prom-metrics.js');

const CORE_COUNT = os.cpus().length
// WORKER_STORAGE: [<worker>]. Registers mediasoup workers, raw form
const WORKER_STORAGE = [];

const _resourceUsageCollector = () => {
  let workerMetricsArray = [];
  return Promise.all(
    WORKER_STORAGE.map(async worker => {
      try {
        const workerResourceUsage = await worker.getResourceUsage();
        workerMetricsArray.push(workerResourceUsage);
      } catch (error) {
        Logger.debug(LOG_PREFIX, 'Failure collecting worker resource metrics', {
          errorMessage: error.message, workerId: worker.internalAdapterId,
          workerResourceUsage,
        });
      }
    })
  ).then(() => {
    const sum = {};
    workerMetricsArray.forEach((workerResourceUsage) => {
      Object.entries(workerResourceUsage).forEach(([key, val]) => {
        sum[key] = val + (sum[key] || 0);
      });
    });

    return sum;
  });
};

const storeWorker = (worker) => {
  if (!worker) return false;

  if (hasWorker(worker.internalAdapterId)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_WORKER_COLLISION"
    });
  }

  WORKER_STORAGE.push(worker);
  PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKERS);

  return true;
}

const getWorker = (id) => {
  return WORKER_STORAGE.find(worker => worker.internalAdapterId === id);
}

const hasWorker = (id) => {
  return WORKER_STORAGE.some(worker => worker.internalAdapterId === id);
}

// Round-robin
const getWorkerRR = () => {
  const worker = WORKER_STORAGE.shift();
  if (worker) {
    WORKER_STORAGE.push(worker);
  }
  return worker;
}

const deleteWorker = (id) => {
  let deleted = false;
  let i = 0;

  while (i < WORKER_STORAGE.length || !deleted) {
    if (WORKER_STORAGE[i].id === id) {
      WORKER_STORAGE.splice(i, 1);
      deleted = true;
    } else {
      i++;
    }
  }

  if (deleted) {
    PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_WORKERS);
  }

  return deleted;
}

const setupWorkerEventHandler = (worker, callback) => {
  worker.once('died', () => {
    PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKER_CRASHES);
    callback('died', worker.internalAdapterId)
  });
};

const _getNofWorkersFromStrat = (workerStrat) => {
  if (typeof workerStrat === 'string' && workerStrat === 'auto') {
    return CORE_COUNT;
  } else if (typeof workerStrat === 'number') {
    return workerStrat;
  }

  // 8w
  return DEFAULT_NOF_WORKERS;
};

const createWorkers = (
  workerStrat,
  workerSettings,
  eventHandler,
) => {
  const nofWorkers = _getNofWorkersFromStrat(workerStrat);
  Logger.info(LOG_PREFIX, `Spawning workers: ${nofWorkers} (${workerStrat})`);

  for (let i = 0; i < nofWorkers; i++) {
    createWorker(workerSettings).then((worker) => {
      if (eventHandler) setupWorkerEventHandler(worker, eventHandler);
      storeWorker(worker);
    }).catch(error => {
      Logger.error(LOG_PREFIX, 'Worker creation failed',
        { errorMessage: error.message, errorCode: error.code });
    });
  }

  if (WORKER_EXPORT_RESOURCE_USAGE) {
    exportWorkerResourceUsageMetrics(_resourceUsageCollector);
  }
}

const createWorker = async (workerSettings = WORKER_SETTINGS) => {
  try {
    const worker = await mediasoup.createWorker(workerSettings)
    worker.internalAdapterId = uuidv4();
    //setupWorkerCrashHandler(this._worker);
    Logger.info(LOG_PREFIX, 'New worker created', { workerId: worker.internalAdapterId });
    return worker;
  } catch (error) {
    Logger.error(LOG_PREFIX, 'Worker creation failed', {
      errorMessage: error.message
    });
    throw error;
  }
}

const stopWorker = (worker) => {
  worker.close();
}

module.exports = {
  WORKER_STORAGE,
  createWorkers,
  createWorker,
  stopWorker,
  getWorker,
  getWorkerRR,
  deleteWorker,
};
