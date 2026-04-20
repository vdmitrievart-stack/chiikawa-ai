import http from "node:http";

export default class WebhookServer {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.bot = options.bot;
    this.port = Number(options.port || process.env.PORT || 3000);
    this.webhookSecret =
      options.webhookSecret || process.env.WEBHOOK_SECRET || "chiikawa_secret";
    this.webhookPath = options.webhookPath || `/telegram/${this.webhookSecret}`;
    this.server = null;
  }

  start() {
    if (!this.bot) {
      throw new Error("WebhookServer requires bot");
    }

    this.server = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === this.webhookPath) {
        let body = "";

        req.on("data", (chunk) => {
          body += chunk;
        });

        req.on("end", async () => {
          try {
            const update = JSON.parse(body);
            this.bot.processUpdate(update);
            res.writeHead(200);
            res.end("ok");
          } catch (error) {
            res.writeHead(500);
            res.end(error.message);
          }
        });
        return;
      }

      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    this.server.listen(this.port, () => {
      this.logger.log(`Telegram bot server listening on port ${this.port}`);
    });

    return this.server;
  }
}
