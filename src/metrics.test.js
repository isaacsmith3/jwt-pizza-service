const metrics = require('./metrics.js');

// Pull a single data point out of a collected batch
function dataPoint(builder, name, attrs = {}) {
  const found = builder.metrics.filter((m) => m.name === name);
  for (const metric of found) {
    const type = metric.sum ? 'sum' : 'gauge';
    const point = metric[type].dataPoints[0];
    const have = {};
    point.attributes.forEach((a) => (have[a.key] = a.value.stringValue));
    // console.log(have);
    if (Object.entries(attrs).every(([k, v]) => have[k] === v)) {
      return point;
    }
  }
  return undefined;
}

function valueOf(builder, name, attrs = {}) {
  const point = dataPoint(builder, name, attrs);
  if (!point) return undefined;
  return point.asInt !== undefined ? point.asInt : point.asDouble;
}

// Counters are module level, so snapshot immediately before the action
function snapshot() {
  // console.log('snapshot');
  return metrics.collect();
}

function runRequest(method) {
  const req = { method };
  let finish;
  const res = { on: (event, cb) => (event === 'finish' ? (finish = cb) : null) };
  const next = jest.fn();
  metrics.requestTracker(req, res, next);
  expect(next).toHaveBeenCalled();
  finish();
}

describe('requestTracker', () => {
  test('counts a request against its own method', () => {
    const before = valueOf(snapshot(), 'requests', { method: 'GET' }) || 0;
    runRequest('GET');
    expect(valueOf(snapshot(), 'requests', { method: 'GET' })).toBe(before + 1);
  });

  test('lowercase methods are normalized', () => {
    const before = valueOf(snapshot(), 'requests', { method: 'PATCH' }) || 0;
    runRequest('patch');
    expect(valueOf(snapshot(), 'requests', { method: 'PATCH' })).toBe(before + 1);
  });

  test('the total matches the sum of the per-method counts', () => {
    runRequest('POST');
    console.log(valueOf(snapshot(), 'requests', { method: 'PATCH' }));
    const builder = snapshot();
    const perMethod = builder.metrics
      .filter((m) => m.name === 'requests')
      .reduce((sum, m) => sum + m.sum.dataPoints[0].asInt, 0);
    expect(valueOf(builder, 'requests_all')).toBe(perMethod);
  });

  test('records elapsed time for the request', () => {
    const before = valueOf(snapshot(), 'request_latency');
    runRequest('GET');
    expect(valueOf(snapshot(), 'request_latency')).toBeGreaterThanOrEqual(before);
  });
});

describe('authAttempt', () => {
  test('successes and failures are counted separately', () => {
    const okBefore = valueOf(snapshot(), 'auth', { success: 'true' });
    const badBefore = valueOf(snapshot(), 'auth', { success: 'false' });

    metrics.authAttempt(true);
    metrics.authAttempt(false);

    metrics.authAttempt(false);

    expect(valueOf(snapshot(), 'auth', { success: 'true' })).toBe(okBefore + 1);
    expect(valueOf(snapshot(), 'auth', { success: 'false' })).toBe(badBefore + 2);
  });
});

describe('active users', () => {
  test('login increments and logout decrements', () => {
    const before = valueOf(snapshot(), 'active_users');
    metrics.userLogin();
    metrics.userLogin();

    expect(valueOf(snapshot(), 'active_users')).toBe(before + 2);
    metrics.userLogout();
    expect(valueOf(snapshot(), 'active_users')).toBe(before + 1);
  });

  test('never falls below zero on unmatched logouts', () => {
    for (let i = 0; i < 50; i++) metrics.userLogout();
    expect(valueOf(snapshot(), 'active_users')).toBe(0);
  });
});

describe('pizzaPurchase', () => {
  test('a sale adds to pizzas sold and revenue', () => {
    const sold = valueOf(snapshot(), 'pizzas_sold');
    const revenue = valueOf(snapshot(), 'revenue');
    metrics.pizzaPurchase(true, 120, 0.05, 2);

    console.log(valueOf(snapshot(), 'pizzas_sold'));
    expect(valueOf(snapshot(), 'pizzas_sold')).toBe(sold + 2);
    expect(valueOf(snapshot(), 'revenue')).toBeCloseTo(revenue + 0.05, 6);
  });

  test('a failure is counted and earns no revenue', () => {
    const failures = valueOf(snapshot(), 'pizza_failures');
    const revenue = valueOf(snapshot(), 'revenue');
    metrics.pizzaPurchase(false, 300, 0, 22);
    expect(valueOf(snapshot(), 'pizza_failures')).toBe(failures + 22);
    expect(valueOf(snapshot(), 'revenue')).toBeCloseTo(revenue, 6);
  });

  test('latency accrues on both success and failure', () => {
    const before = valueOf(snapshot(), 'pizza_latency');
    console.log(before);
    metrics.pizzaPurchase(true, 100, 0.01, 1);
    metrics.pizzaPurchase(false, 250, 0, 1);
    expect(valueOf(snapshot(), 'pizza_latency')).toBe(before + 350);
  });

  test('fractional revenue is sent as a double, not truncated', () => {
    metrics.pizzaPurchase(true, 10, 0.0038, 1);
    const point = dataPoint(snapshot(), 'revenue');

    expect(point.asDouble).toBeDefined();
    expect(point.asInt).toBeUndefined();
    expect(point.asDouble).toBeGreaterThan(0);
  });
});

describe('system metrics', () => {
  test('cpu and memory are reported as percentages', () => {
    const builder = snapshot();
    for (const name of ['cpu', 'memory']) {
      const value = valueOf(builder, name);
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(builder.metrics.find((m) => m.name === name).unit).toBe('%');
      console.log(valueOf(builder, name));
    }
  });
});

describe('OTLP payload', () => {
  test('every data point is tagged with the configured source', () => {
    const builder = snapshot();
    expect(builder.metrics.length).toBeGreaterThan(0);
    for (const metric of builder.metrics) {
      const type = metric.sum ? 'sum' : 'gauge';

      const keys = metric[type].dataPoints[0].attributes.map((a) => a.key);
      expect(keys).toContain('source');
    }
  });

  test('counters are cumulative and monotonic, gauges are not', () => {
    const builder = snapshot();
    const counter = builder.metrics.find((m) => m.name === 'requests_all');
    expect(counter.sum.isMonotonic).toBe(true);
    expect(counter.sum.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
    expect(builder.metrics.find((m) => m.name === 'cpu').gauge).toBeDefined();
  });

  test('serializes to the resourceMetrics envelope Grafana expects', () => {
    const body = JSON.parse(snapshot().toJSON());
    expect(Array.isArray(body.resourceMetrics)).toBe(true); 
    console.log(body.resourceMetrics[0].scopeMetrics[0].metrics);
    expect(body.resourceMetrics[0].scopeMetrics[0].metrics.length).toBeGreaterThan(0);
  });
});

describe('sendMetricsPeriodically', () => {
  let consoleError;

  beforeEach(() => {
    // The failure paths log on purpose; keep the test output readable.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    jest.useRealTimers();
    delete global.fetch;
  });

  test('posts the batch to the configured endpoint on each tick', () => {
    jest.useFakeTimers();

    const fetchMock = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('') }));
    global.fetch = fetchMock;

    const timer = metrics.sendMetricsPeriodically(1000);
    jest.advanceTimersByTime(1000);
    clearInterval(timer);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');

    expect(options.headers.Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(options.body).resourceMetrics).toBeDefined();
  });

  test('a rejected push is caught rather than thrown', () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() => Promise.reject(new Error('network down')));

    const timer = metrics.sendMetricsPeriodically(1000);

    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    console.log('advanceTimersByTime');
    clearInterval(timer);
    console.log('clearInterval');
  });
});
