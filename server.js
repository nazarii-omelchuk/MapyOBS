const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const envPath = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    const key = s.slice(0, i).trim();
    const value = s.slice(i + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAPY_API_KEY = process.env.MAPY_API_KEY || "";
const DEFAULT_BASE = (process.env.TRACCAR_URL || "http://127.0.0.1:8082")
  .replace(/\/+$/, "");
const DEFAULT_HOURS = Number(process.env.HISTORY_HOURS || 12);
const DATA_DIR = path.join(__dirname, "data");
const WIDGETS_FILE = path.join(DATA_DIR, "widgets.json");
const MAX_ROUTE_POINTS = 10000;
const ENV_TOKEN = "env";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseCenter(value) {
  if (!value) return null;
  const m = String(value).match(
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
  );
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return `${lat},${lon}`;
}

function normalizeView(view) {
  const v = view || {};
  const zoom = Math.min(
    19,
    Math.max(3, Math.round(Number(v.zoom) || 16))
  );
  return {
    follow: v.follow === false ? false : true,
    zoom,
    center: parseCenter(v.center)
  };
}

function overlayUrlFor(w) {
  const q = new URLSearchParams({
    key: w.token,
    follow: w.view.follow ? "1" : "0",
    zoom: String(w.view.zoom)
  });
  if (w.view.center) q.set("center", w.view.center);
  return "/overlay.html?" + q.toString();
}

function valid(p) {
  return p &&
    Number.isFinite(Number(p.latitude)) &&
    Number.isFinite(Number(p.longitude)) &&
    Math.abs(Number(p.latitude)) <= 90 &&
    Math.abs(Number(p.longitude)) <= 180;
}

function normalize(p) {
  return {
    lat: Number(p.latitude),
    lon: Number(p.longitude),
    time: p.fixTime || p.deviceTime || p.serverTime,
    accuracy: p.accuracy,
    speed: Number(p.speed) || 0,
    course: Number(p.course) || 0
  };
}

class Widget {
  constructor(cfg) {
    this.token = cfg.token;
    this.baseUrl = cfg.baseUrl;
    this.username = cfg.username;
    this.password = cfg.password;
    this.identifier = cfg.identifier;
    this.hours = cfg.hours;
    this.deviceName = cfg.deviceName || null;
    this.createdAt = cfg.createdAt || new Date().toISOString();
    this.view = normalizeView(cfg.view);
    this.deviceId = null;
    this.route = [];
    this.initPromise = null;
  }

  get auth() {
    return "Basic " + Buffer.from(
      `${this.username}:${this.password}`
    ).toString("base64");
  }

  async api(endpoint) {
    const r = await fetch(this.baseUrl + "/api" + endpoint, {
      headers: { Authorization: this.auth }
    });
    if (!r.ok) {
      throw httpError(r.status, `Traccar API: HTTP ${r.status}`);
    }
    return r.json();
  }

  async ensureInit() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const devices = await this.api("/devices");
      const device = devices.find(
        d => String(d.uniqueId) === String(this.identifier)
      );

      if (!device) {
        const e = httpError(
          404,
          `Не знайдено пристрій з Identifier ${this.identifier}`
        );
        e.code = "device_not_found";
        e.devices = devices;
        throw e;
      }

      this.deviceId = device.id;
      this.deviceName = device.name;

      const to = new Date();
      const from = new Date(
        to.getTime() - this.hours * 60 * 60 * 1000
      );

      const qs = new URLSearchParams({
        deviceId: String(device.id),
        from: from.toISOString(),
        to: to.toISOString()
      });

      const history = await this.api("/positions?" + qs);
      this.route = history.filter(valid).map(normalize);

      console.log(
        `[${this.token}] Підключено ${device.name}. ` +
        `Історичних точок: ${this.route.length}`
      );
    })().catch(e => {
      this.initPromise = null;
      throw e;
    });

    return this.initPromise;
  }

  async update() {
    await this.ensureInit();

    const positions = await this.api("/positions");
    const p = positions.find(
      item => Number(item.deviceId) === Number(this.deviceId)
    );

    if (p && valid(p)) {
      const point = normalize(p);
      const last = this.route[this.route.length - 1];

      if (!last || last.lat !== point.lat ||
          last.lon !== point.lon) {
        this.route.push(point);
        if (this.route.length > MAX_ROUTE_POINTS) this.route.shift();
      }
    }

    return {
      latest: p && valid(p) ? normalize(p) : null,
      route: this.route
    };
  }
}

const widgets = new Map();
let envWidget = null;

function serializeWidget(w) {
  return {
    token: w.token,
    baseUrl: w.baseUrl,
    username: w.username,
    password: w.password,
    identifier: w.identifier,
    hours: w.hours,
    deviceName: w.deviceName,
    createdAt: w.createdAt,
    view: w.view
  };
}

function publicWidget(w) {
  return {
    token: w.token,
    baseUrl: w.baseUrl,
    identifier: w.identifier,
    deviceName: w.deviceName,
    hours: w.hours,
    createdAt: w.createdAt,
    view: w.view,
    overlayUrl: overlayUrlFor(w)
  };
}

function loadWidgets() {
  try {
    if (!fs.existsSync(WIDGETS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(WIDGETS_FILE, "utf8"));
    for (const cfg of raw.widgets || []) {
      try {
        widgets.set(cfg.token, new Widget(cfg));
      } catch (e) {
        console.error("Пропущено пошкоджений запис віджету:", e.message);
      }
    }
    if (widgets.size) {
      console.log(`Відновлено віджетів: ${widgets.size}`);
    }
  } catch (e) {
    console.error("Не вдалося прочитати", WIDGETS_FILE, e.message);
  }
}

function saveWidgets() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = WIDGETS_FILE + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { widgets: [...widgets.values()].map(serializeWidget) },
        null,
        2
      )
    );
    fs.renameSync(tmp, WIDGETS_FILE);
  } catch (e) {
    console.error("Не вдалося зберегти віджети:", e.message);
  }
}

function getEnvWidget() {
  if (!process.env.TRACCAR_USERNAME ||
      !process.env.TRACCAR_PASSWORD) {
    return null;
  }
  if (!envWidget) {
    envWidget = new Widget({
      token: ENV_TOKEN,
      baseUrl: DEFAULT_BASE,
      username: process.env.TRACCAR_USERNAME,
      password: process.env.TRACCAR_PASSWORD,
      identifier: process.env.TRACCAR_IDENTIFIER || "iphone12gps",
      hours: DEFAULT_HOURS
    });
  }
  return envWidget;
}

function deviceInfo(d) {
  return {
    id: d.id,
    name: d.name,
    uniqueId: d.uniqueId,
    status: d.status
  };
}

app.post("/api/widgets", async (req, res) => {
  try {
    const body = req.body || {};
    const baseUrl = String(body.baseUrl || DEFAULT_BASE)
      .trim().replace(/\/+$/, "");
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const identifier = String(body.identifier || "").trim();
    const hours = Math.min(
      168,
      Math.max(1, Math.round(Number(body.hours) || DEFAULT_HOURS))
    );
    const follow = !(
      body.follow === false ||
      body.follow === "false" ||
      body.follow === 0 ||
      body.follow === "0"
    );
    const view = normalizeView({
      follow,
      zoom: body.zoom,
      center: body.center
    });

    if (!/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({
        error: "Адреса Traccar має починатися з http:// або https://"
      });
    }
    if (!username) {
      return res.status(400).json({ error: "Вкажіть логін Traccar" });
    }
    if (!password) {
      return res.status(400).json({ error: "Вкажіть пароль Traccar" });
    }
    if (!identifier) {
      return res.status(400).json({ error: "Вкажіть ідентифікатор пристрою" });
    }

    const token = crypto.randomBytes(18).toString("base64url");
    const widget = new Widget({
      token,
      baseUrl,
      username,
      password,
      identifier,
      hours,
      view
    });

    try {
      await widget.ensureInit();
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        return res.status(401).json({
          error: "Traccar відхилив логін або пароль"
        });
      }
      if (e.code === "device_not_found") {
        return res.status(404).json({
          error: `Пристрій «${identifier}» не знайдено на вашому акаунті`,
          devices: (e.devices || []).map(deviceInfo)
        });
      }
      return res.status(502).json({
        error: e.message || "Не вдалося підключитися до Traccar"
      });
    }

    widgets.set(token, widget);
    saveWidgets();

    res.json({ ok: true, widget: publicWidget(widget) });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/test", async (req, res) => {
  try {
    const body = req.body || {};
    const baseUrl = String(body.baseUrl || DEFAULT_BASE)
      .trim().replace(/\/+$/, "");
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        error: "Вкажіть логін і пароль Traccar"
      });
    }

    const probe = new Widget({
      token: "probe",
      baseUrl,
      username,
      password,
      identifier: "probe",
      hours: DEFAULT_HOURS
    });

    let devices;
    try {
      devices = await probe.api("/devices");
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        return res.status(401).json({
          error: "Traccar відхилив логін або пароль"
        });
      }
      return res.status(502).json({
        error: e.message || "Не вдалося підключитися до Traccar"
      });
    }

    res.json({
      ok: true,
      count: devices.length,
      devices: devices.map(deviceInfo)
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/widgets", (req, res) => {
  res.json({
    widgets: [...widgets.values()]
      .filter(w => w.token !== ENV_TOKEN)
      .map(publicWidget)
  });
});

app.delete("/api/widgets/:token", (req, res) => {
  const token = String(req.params.token || "");
  if (!widgets.has(token) || token === ENV_TOKEN) {
    return res.status(404).json({ error: "Віджет не знайдено" });
  }
  widgets.delete(token);
  saveWidgets();
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  if (!MAPY_API_KEY || MAPY_API_KEY.includes("ТВІЙ_API")) {
    return res.status(503).json({
      error: "Заповни MAPY_API_KEY у файлі .env"
    });
  }

  const key = String(req.query.key || "");
  if (key && !widgets.has(key)) {
    return res.status(404).json({
      error: "Віджет не знайдено або видалений. " +
             "Створіть новий на головній сторінці."
    });
  }

  res.json({ mapyApiKey: MAPY_API_KEY });
});

app.get("/api/track", async (req, res) => {
  try {
    const key = String(req.query.key || "");
    let widget;

    if (key) {
      widget = widgets.get(key);
      if (!widget) {
        throw httpError(
          404,
          "Віджет не знайдено або видалений. " +
          "Створіть новий на головній сторінці."
        );
      }
    } else {
      widget = getEnvWidget();
      if (!widget) {
        throw httpError(
          400,
          "Не вказано ключ віджету. Відкрийте головну сторінку " +
          "та створіть віджет."
        );
      }
    }

    const data = await widget.update();

    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 503).json({
      ok: false,
      error: e.message || String(e)
    });
  }
});

loadWidgets();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Головна сторінка: http://127.0.0.1:${PORT}/`);
  console.log(`OBS-посилання: http://127.0.0.1:${PORT}/overlay.html?key=...`);
});
