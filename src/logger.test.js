const logger = require('./logger.js');

// Capture what log() would have shipped without transmitting.
function captureLog(fn) {
  const sent = [];
  const original = logger.sendLogToGrafana;
  logger.sendLogToGrafana = (event) => sent.push(event);
  try {
    fn();
  } finally {
    logger.sendLogToGrafana = original;
  }
  return sent;
}

function streamOf(event) {
  return event.streams[0].stream;
}

function lineOf(event) {
  // values is an array of [timestamp, line] pairs
  return event.streams[0].values[0][1];
}

describe('sanitize', () => {
  test('masks passwords', () => {
    const out = logger.sanitize({ reqBody: JSON.stringify({ email: 'd@jwt.com', password: 'toomanysecrets' }) });
    expect(out).not.toContain('toomanysecrets');
    expect(out).toContain('*****');
    console.log(out);
  });

  test('masks tokens and jwts', () => {
    const out = logger.sanitize({ token: 'eyJhbGciOiJIUzI1NiJ9', jwt: 'eyJpYXQiOjE3OTM4' });
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('eyJpYXQiOjE3OTM4');
    console.log("out", out);

  });

  test('masks api keys', () => {
    const out = logger.sanitize({ apiKey: 'glc_supersecretvalue' });
    expect(out).not.toContain('glc_supersecretvalue');

  });

  test('masks bearer authorization values', () => {
    const out = logger.sanitize({ authorization: 'Bearer abc.def.ghi' });
    expect(out).not.toContain('abc.def.ghi');
    expect(out).toContain('*****');

  });

  test('masks a bearer token embedded in a plain string', () => {
    const out = logger.sanitize({ note: 'sent with Bearer abc.def.ghi header' });
    expect(out).not.toContain('abc.def.ghi');
    expect(out).toContain('Bearer *****');
  });

  test('masks a jwt nested inside a double-stringified response body', () => {
    const inner = JSON.stringify({ user: { id: 2 }, token: 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Mn0.abc123signature' });
    const out = logger.sanitize({ resBody: JSON.stringify(inner) });
    expect(out).not.toContain('abc123signature');
    expect(out).toContain('*****');
  });

  test('leaves non-sensitive fields readable', () => {
    const out = logger.sanitize({ path: '/api/order', method: 'POST', statusCode: 200 });
    expect(out).toContain('/api/order');
    expect(out).toContain('POST');
  });
});

describe('statusToLogLevel', () => {
  test.each([
    [200, 'info'],
    [201, 'info'],
    [404, 'warn'],
    [401, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ])('%i maps to %s', (code, level) => {
    expect(logger.statusToLogLevel(code)).toBe(level);

  });
});

describe('log events', () => {
  test('database queries are logged with type db', () => {
    const sent = captureLog(() => logger.dbLogger('SELECT * FROM user WHERE email=?', ['d@jwt.com']));
    expect(sent).toHaveLength(1);
    expect(streamOf(sent[0]).type).toBe('db');
    expect(streamOf(sent[0]).level).toBe('info');
    expect(lineOf(sent[0])).toContain('SELECT * FROM user');
    console.log("sent", sent);
  });

  test('database parameters are masked for statements touching credentials', () => {
    const sent = captureLog(() => logger.dbLogger('DELETE FROM auth WHERE token=?', ['ugFJj9eYjmtw-Jy6OzQf2A2XljAO4OTGoeWxpHYocDI']));
    const line = lineOf(sent[0]);
    expect(line).not.toContain('ugFJj9eYjmtw');
    expect(line).toContain('DELETE FROM auth');
    expect(line).toContain('*****');
    console.log("line", line);
  });

  test('ordinary database parameters are still readable', () => {
    const sent = captureLog(() => logger.dbLogger('SELECT * FROM menu WHERE id=?', [7]));
    expect(lineOf(sent[0])).toContain('7');
  });


  test('factory calls are logged with type factory and their status level', () => {
    const sent = captureLog(() => logger.factoryLogger({ order: 1 }, { reportUrl: 'x' }, 500));
    expect(streamOf(sent[0]).type).toBe('factory');
    expect(streamOf(sent[0]).level).toBe('error');
  });

  test('unhandled exceptions are logged with type exception', () => {
    const err = new Error('Trouble in river city!');
    const sent = captureLog(() => logger.exceptionLogger(err, { originalUrl: '/boom', method: 'GET' }));
    expect(streamOf(sent[0]).type).toBe('exception');
    expect(streamOf(sent[0]).level).toBe('error');
    expect(lineOf(sent[0])).toContain('Trouble in river city!');
    console.log("sent", sent);
  });

  test('an exception without a request still logs', () => {
    const sent = captureLog(() => logger.exceptionLogger(new Error('no req'), undefined));
    expect(streamOf(sent[0]).type).toBe('exception');
    expect(lineOf(sent[0])).toContain('no req');
  });

  test('user is "none" outside of a request context', () => {
    expect(logger.currentUser()).toBe('none');
  });

  test('every event carries the configured component and a nanosecond timestamp', () => {
    const sent = captureLog(() => logger.dbLogger('SELECT 1', []));
    const stream = streamOf(sent[0]);
    expect(stream.component).toBeDefined();
    expect(sent[0].streams[0].values[0][0]).toMatch(/^\d{19}$/);
  });
});


describe('transmission guard', () => {
  test('is disabled under jest so tests never publish logs', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(logger.enabled()).toBe(false);
  });

  test('sendLogToGrafana makes no network call while disabled', () => {
    const fetchMock = jest.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchMock;
    logger.sendLogToGrafana({ streams: [] });
    global.fetch = originalFetch;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
