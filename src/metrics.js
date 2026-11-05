const os = require('os');
const config = require('./config.js');

// In-memory counters
const requestsByMethod = {};
let requestLatencyTotal = 0;
let authSuccess = 0;
let authFailure = 0;
let activeUsers = 0;
let pizzasSold = 0;
let pizzaFailures = 0;
let revenueTotal = 0;
let pizzaLatencyTotal = 0;

// Express middleware
function requestTracker(req, res, next) {
  const start = Date.now();
  const method = req.method.toUpperCase();
  requestsByMethod[method] = (requestsByMethod[method] || 0) + 1;

  res.on('finish', () => {
    requestLatencyTotal += Date.now() - start;
  });

  next();
}

function authAttempt(success) {
  if (success) {
    authSuccess++;
  } else {
    authFailure++;
  }
}

function userLogin() {
  activeUsers++;
}

function userLogout() {
  if (activeUsers > 0) {
    activeUsers--;
  }
}

function pizzaPurchase(success, latencyMs, price, count) {
  pizzaLatencyTotal += latencyMs;
  if (success) {
    pizzasSold += count;
    revenueTotal += price;
  } else {
    pizzaFailures += count;
  }
}

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  return Number(((usedMemory / totalMemory) * 100).toFixed(2));
}

// Collects OTLP data points and sends to grafana
class OtelMetricBuilder {
  constructor() {
    this.metrics = [];
  }

  add(name, value, type, unit, attributes = {}) {
    const dataPoint = {
      timeUnixNano: Date.now() * 1000000,
      attributes: Object.entries({ source: config.metrics.source, ...attributes }).map(([key, v]) => ({
        key,
        value: { stringValue: String(v) },
      })),
    };

    if (Number.isInteger(value)) {
      dataPoint.asInt = value;
    } else {
      dataPoint.asDouble = value;
    }

    const metric = { name, unit, [type]: { dataPoints: [dataPoint] } };
    if (type === 'sum') {
      metric[type].aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
      metric[type].isMonotonic = true;
    }

    this.metrics.push(metric);
    return this;
  }

  toJSON() {
    return JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: this.metrics }] }] });
  }
}

function collect() {
  const builder = new OtelMetricBuilder();

  // HTTP requests by method, plus a total across all methods.
  let totalRequests = 0;
  for (const [method, count] of Object.entries(requestsByMethod)) {
    totalRequests += count;
    builder.add('requests', count, 'sum', '1', { method });
  }
  builder.add('requests_all', totalRequests, 'sum', '1');

  builder.add('request_latency', requestLatencyTotal, 'sum', 'ms');

  builder.add('auth', authSuccess, 'sum', '1', { success: 'true' });
  builder.add('auth', authFailure, 'sum', '1', { success: 'false' });

  builder.add('active_users', activeUsers, 'gauge', '1');

  builder.add('cpu', getCpuUsagePercentage(), 'gauge', '%');
  builder.add('memory', getMemoryUsagePercentage(), 'gauge', '%');

  builder.add('pizzas_sold', pizzasSold, 'sum', '1');
  builder.add('pizza_failures', pizzaFailures, 'sum', '1');
  builder.add('revenue', revenueTotal, 'sum', '1');
  builder.add('pizza_latency', pizzaLatencyTotal, 'sum', 'ms');

  return builder;
}

function sendToGrafana(builder) {
  const body = builder.toJSON();
  fetch(config.metrics.endpointUrl, {
    method: 'POST',
    body,
    headers: {
      Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
      'Content-Type': 'application/json',
    },
  })
    .then((response) => {
      if (!response.ok) {
        response.text().then((text) => console.error(`Failed to push metrics to Grafana: ${text}`));
      }
    })
    .catch((error) => console.error('Error pushing metrics:', error));
}

function sendMetricsPeriodically(period) {
  const timer = setInterval(() => {
    try {
      sendToGrafana(collect());
    } catch (error) {
      console.log('Error sending metrics', error);
    }
  }, period);
  timer.unref();
  return timer;
}

// Tests require this module without wanting a live reporter. Jest sets
// NODE_ENV=test, and CI writes the production config before running tests, so
// without this guard a CI run would report test traffic under the production
// source and corrupt the rate() calculations with counter resets.
if (process.env.NODE_ENV !== 'test' && config.metrics && config.metrics.endpointUrl && config.metrics.apiKey) {
  sendMetricsPeriodically(5000);
}

module.exports = {
  collect,
  requestTracker,
  authAttempt,
  userLogin,
  userLogout,
  pizzaPurchase,
  sendMetricsPeriodically,
};
