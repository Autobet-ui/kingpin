import { Router, type IRouter, type Request, type Response } from "express";
import md5 from "md5";

const router: IRouter = Router();

const GOA_BASE = "https://api.goa7777.com";
const GOA_API  = `${GOA_BASE}/api/webapi`;

const EXCLUDED_FROM_SIGN = ["signature", "track", "xosoBettingData"];

function makeRandom(): string {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function signPayload(data: Record<string, unknown>): Record<string, unknown> {
  const enriched: Record<string, unknown> = {
    language: 0,
    random: makeRandom(),
    ...data,
  };

  const sorted = Object.keys(enriched).sort();
  const filtered: Record<string, unknown> = {};
  sorted.forEach((k) => {
    const v = enriched[k];
    if (v !== null && v !== "" && !EXCLUDED_FROM_SIGN.includes(k)) {
      filtered[k] = v === 0 ? 0 : v;
    }
  });

  enriched["signature"] = md5(JSON.stringify(filtered)).toUpperCase().slice(0, 32);
  enriched["timestamp"] = Math.floor(Date.now() / 1000);

  return enriched;
}

const BYPASS_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://goagamea.com",
  "Referer": "https://goagamea.com/",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

async function goaPost(path: string, rawBody: Record<string, unknown>, token?: string): Promise<unknown> {
  const body = signPayload(rawBody);

  const headers: Record<string, string> = {
    ...BYPASS_HEADERS,
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["token"] = token;
  }

  const res = await fetch(`${GOA_API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  if (!text) throw new Error(`Upstream ${res.status}: empty`);
  throw new Error(`Upstream ${res.status}: ${text.slice(0, 200)}`);
}

function handle(fn: () => Promise<unknown>, res: Response) {
  fn()
    .then((d) => res.json(d))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(200).json({ code: -1, msg });
    });
}

function tokenFrom(req: Request): string | undefined {
  return (req.headers["token"] ?? req.headers["authorization"]) as string | undefined;
}

router.post("/captcha", (_req: Request, res: Response) => {
  handle(() => goaPost("/Captcha", {}), res);
});

router.post("/login", (req: Request, res: Response) => {
  handle(() => goaPost("/Login", req.body as Record<string, unknown>), res);
});

router.post("/balance", (req: Request, res: Response) => {
  handle(() => goaPost("/User/GetInfo", req.body as Record<string, unknown>, tokenFrom(req)), res);
});

router.post("/bet", (req: Request, res: Response) => {
  handle(() => goaPost("/WinGo/WinGoBet", req.body as Record<string, unknown>, tokenFrom(req)), res);
});

router.post("/history", (req: Request, res: Response) => {
  handle(() => goaPost("/WinGo/GetMyGameRecordList", req.body as Record<string, unknown>, tokenFrom(req)), res);
});

router.post("/result", (req: Request, res: Response) => {
  handle(() => goaPost("/WinGo/GetIssueList", req.body as Record<string, unknown>, tokenFrom(req)), res);
});

router.post("/betrecord", (req: Request, res: Response) => {
  handle(() => goaPost("/WinGo/GetMyGameRecordList", req.body as Record<string, unknown>, tokenFrom(req)), res);
});

router.get("/period", (req: Request, res: Response) => {
  handle(() => goaPost("/WinGo/GetIssueList", { pageNo: 1, pageSize: 1, typeId: 30, language: 0 }, tokenFrom(req)), res);
});

export default router;
