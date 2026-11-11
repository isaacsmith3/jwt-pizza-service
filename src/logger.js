const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config.js');

const requestContext = new AsyncLocalStorage();

class Logger {
  static sensitiveKey = /password|token|jwt|apikey|secret|authorization/i;
  static sensitiveColumn = /\b(token|password|secret|apikey)\b/i;

  httpLogger = (req, res, next) => {
    requestContext.run({ req }, () => {
      const send = res.send;
      res.send = (resBody) => {
        const logData = {
          authorized: !!req.headers.authorization,
          user: this.currentUser(),
          path: req.originalUrl,
          method: req.method,
          statusCode: res.statusCode,
          reqBody: JSON.stringify(req.body),
          resBody: JSON.stringify(resBody),
        };
        this.log(this.statusToLogLevel(res.statusCode), 'http', logData);
        console.log("res", res);
        console.log("logData", logData);
        res.send = send;
        return res.send(resBody);
      };
      next();
    });
  };

  dbLogger(sql, params) { // Called from DB.query so every SQL statement is logged in one place 
    const sensitiveStatement = Logger.sensitiveColumn.test(sql);
    this.log('info', 'db', {
      user: this.currentUser(),
      sql: sql,
      params: sensitiveStatement ? '*****' : JSON.stringify(params ?? []),
    });
  }

  // Called around the pizza factory fetch in orderRouter, logged all requests to the factory in one place
  factoryLogger(reqBody, resBody, statusCode) {
    this.log(this.statusToLogLevel(statusCode), 'factory', {
      user: this.currentUser(),
      statusCode: statusCode,
      reqBody: JSON.stringify(reqBody),
      resBody: JSON.stringify(resBody),
    });
  }

  // Called from the Express default error handler, logged all exceptions
  exceptionLogger(err, req) {
    this.log('error', 'exception', {
      user: this.currentUser(),
      path: req?.originalUrl,
      method: req?.method,
      message: err?.message,
      stack: err?.stack,
    });
  }

  currentUser() {
    const store = requestContext.getStore();
    const user = store?.req?.user;
    return user ? `${user.id}:${user.email}` : 'none';
  }

  log(level, type, logData) {
    const labels = { component: config.logging.source, level: level, type: type };
    const values = [this.nowString(), this.sanitize(logData)];
    const logEvent = { streams: [{ stream: labels, values: [values] }] };

    this.sendLogToGrafana(logEvent);
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return (Math.floor(Date.now()) * 1000000).toString();
  }

  // cleans logs of anything credential related
  sanitize(logData) {
    const sanitize = JSON.stringify(this.redact(logData));
    console.log("sanitize", sanitize);
    return sanitize;
  }

  redact(value, depth = 0) {
    if (depth > 8) return value;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.stringify(this.redact(JSON.parse(value), depth + 1));
        } catch {
          console.log('Failed to parse:', value);
        }
      }
      return value.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '*****').replace(/Bearer\s+\S+/g, 'Bearer *****');
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, depth + 1));
    }

    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = Logger.sensitiveKey.test(key) ? '*****' : this.redact(item, depth + 1);
      }
      return out;
    }

    return value;
  }

  sendLogToGrafana(event) {
    if (!this.enabled()) return;
    const body = JSON.stringify(event);
    fetch(`${config.logging.endpointUrl}`, {
      method: 'post',
      body: body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.logging.accountId}:${config.logging.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) {
          res.text().then((text) => console.log('Failed to send log to Grafana:', res.status, text));
        }
      })
      .catch((err) => console.log('Error sending log to Grafana:', err.message));
  }

  enabled() {
    return process.env.NODE_ENV !== 'test' && !!config.logging?.endpointUrl && !!config.logging?.apiKey;
  }
}

module.exports = new Logger();
